import {
  boldPattern,
  keywordPattern,
  type Bullet,
  type Cite,
  type Digest,
  type Report,
  type ReportOptions,
  type Transcript,
} from './schema.js';
import { rangeSpan, reportKey } from './reports.js';
import {
  checkDiagramShape,
  extensionFields,
  lintExtensions,
  walkDiagram,
  type ExtensionLintOptions,
} from './lint-extension.js';

export type DigestIssueSeverity = 'error' | 'warning';

export interface DigestIssue {
  path: string;
  severity: DigestIssueSeverity;
  code: string;
  message: string;
}

interface Volume {
  subsections: { min: number; max: number };
  bullets: { min: number; max: number };
}

/** 분량 옵션별 권장 개수. 넘쳐도 경고만 낸다. 영상마다 답이 달라서다 */
export const VOLUME_BY_LENGTH: Record<ReportOptions['length'], Volume> = {
  short: { subsections: { min: 1, max: 2 }, bullets: { min: 1, max: 3 } },
  default: { subsections: { min: 2, max: 3 }, bullets: { min: 2, max: 4 } },
  long: { subsections: { min: 2, max: 5 }, bullets: { min: 3, max: 6 } },
};

// 부동소수 시각을 그대로 옮겨 적어도 반올림 차이는 날 수 있다
const FRAME_SEC_TOLERANCE = 0.05;

interface TextField {
  path: string;
  text: string;
}

function range(from: number, to: number): string {
  return from === to ? `${from}번 문장` : `${from}~${to}번 문장`;
}

/**
 * 소섹션 불릿을 자식까지 깊이 우선으로 돈다. path는 불릿 자신의 경로다.
 * prose의 path와 lint 경고의 path가 같은 규칙에서 나와야 짝이 맞는다
 */
function* walkBullets(
  bullets: Bullet[],
  prefix: string,
  depth = 0,
): Generator<{ bullet: Bullet; path: string; depth: number }> {
  for (const [k, bullet] of bullets.entries()) {
    const path = `${prefix}.${k}`;
    yield { bullet, path, depth };
    if (bullet.children) yield* walkBullets(bullet.children, `${path}.children`, depth + 1);
  }
}

function collectReportText(report: Report, p: string): TextField[] {
  const out: TextField[] = [];
  out.push({ path: `${p}.lead.question`, text: report.lead.question });
  out.push({ path: `${p}.lead.answer`, text: report.lead.answer });
  out.push({ path: `${p}.lead.takeaway`, text: report.lead.takeaway });
  report.sections.forEach((section, si) => {
    const sp = `${p}.sections.${si}`;
    out.push({ path: `${sp}.title`, text: section.title });
    out.push({ path: `${sp}.conclusion`, text: section.conclusion });
    section.subsections.forEach((sub, bi) => {
      const bp = `${sp}.subsections.${bi}`;
      out.push({ path: `${bp}.title`, text: sub.title });
      for (const { bullet, path } of walkBullets(sub.bullets, `${bp}.bullets`)) {
        out.push({ path: `${path}.text`, text: bullet.text });
      }
    });
  });
  report.keywords.forEach((kw, ki) => {
    out.push({ path: `${p}.keywords.${ki}.explanation`, text: kw.explanation });
  });
  report.skipped.forEach((s, i) => {
    out.push({ path: `${p}.skipped.${i}.reason`, text: s.reason });
  });
  return out;
}

/**
 * 본문에 들어가는 문자열을 리포트 전부에서 경로와 함께 모은다. 키워드 마커 검사와 윤문이 쓴다.
 * 확장 리포트는 본문 칸만 싣는다. 이름 칸과 대사 원문은 윤문하지 않는다
 */
export function collectTextFields(digest: Digest): TextField[] {
  const reports = digest.reports.flatMap((report, ri) =>
    collectReportText(report, `reports.${ri}`),
  );
  const extensions = digest.extensions.flatMap((ext, xi) =>
    extensionFields(ext, `extensions.${xi}`)
      .texts.filter((t) => t.role === 'body')
      .map(({ path, text }) => ({ path, text })),
  );
  return [...reports, ...extensions];
}

interface CiteField {
  path: string;
  cite: Cite;
  /** 불릿이면 소속 소섹션, 도식 노드면 소속 대섹션 범위. 키워드 firstCite처럼 범위 제한이 없으면 비운다 */
  within?: { cite: Cite; code: string; name: string };
}

function collectCites(report: Report, p: string): CiteField[] {
  const out: CiteField[] = [];
  report.sections.forEach((section, si) => {
    const sp = `${p}.sections.${si}`;
    out.push({ path: `${sp}.cite`, cite: section.cite });
    section.subsections.forEach((sub, bi) => {
      const bp = `${sp}.subsections.${bi}`;
      out.push({ path: `${bp}.cite`, cite: sub.cite });
      const within = { cite: sub.cite, code: 'BULLET_CITE_OUT_OF_SUBSECTION', name: '소섹션' };
      for (const { bullet, path } of walkBullets(sub.bullets, `${bp}.bullets`)) {
        out.push({ path: `${path}.cite`, cite: bullet.cite, within });
      }
      const shotWithin = { cite: sub.cite, code: 'SHOT_CITE_OUT_OF_SUBSECTION', name: '소섹션' };
      sub.shots?.forEach((shot, k) => {
        out.push({ path: `${bp}.shots.${k}.cite`, cite: shot.cite, within: shotWithin });
      });
    });
    if (section.diagram) {
      const within = { cite: section.cite, code: 'DIAGRAM_CITE_OUT_OF_SECTION', name: '대섹션' };
      for (const node of walkDiagram(section.diagram, `${sp}.diagram`)) {
        if (node.cite) out.push({ path: `${node.path}.cite`, cite: node.cite, within });
      }
    }
  });
  report.keywords.forEach((kw, ki) => {
    out.push({ path: `${p}.keywords.${ki}.firstCite`, cite: kw.firstCite });
  });
  return out;
}

/**
 * 대섹션과 skipped를 합쳐 span을 빈틈과 겹침 없이 덮는지 본다.
 * span은 보통 0번부터 마지막 문장까지고 구간 리포트면 그 구간에 든 문장들이다
 */
function checkSectionCoverage(
  report: Report,
  p: string,
  span: { from: number; to: number },
  issues: DigestIssue[],
): void {
  const { sections, skipped } = report;
  sections.forEach((section, si) => {
    const prev = sections[si - 1];
    if (prev && section.cite.from <= prev.cite.from) {
      issues.push({
        path: `${p}.sections.${si}.cite`,
        severity: 'error',
        code: 'SECTION_ORDER',
        message: '대섹션은 스크립트 순서대로 놓는다',
      });
    }
  });

  const spans = [
    ...sections.map((s, si) => ({
      path: `${p}.sections.${si}.cite`,
      from: s.cite.from,
      to: s.cite.to,
    })),
    ...skipped.map((s, i) => ({ path: `${p}.skipped.${i}`, from: s.from, to: s.to })),
  ].sort((a, b) => a.from - b.from);

  let cursor = span.from;
  for (const item of spans) {
    if (item.from > item.to) {
      issues.push({
        path: item.path,
        severity: 'error',
        code: 'SECTION_GAP',
        message: `from(${item.from})이 to(${item.to})보다 크다`,
      });
      continue;
    }
    // 구간 없는 리포트에서 스크립트 밖 번호는 CITE_OUT_OF_RANGE가 이미 잡는다
    if (report.options.range && (item.from < span.from || item.to > span.to)) {
      issues.push({
        path: item.path,
        severity: 'error',
        code: 'OUT_OF_REPORT_RANGE',
        message: `${range(item.from, item.to)}이 리포트 구간(${range(span.from, span.to)}) 밖이다`,
      });
      cursor = Math.max(cursor, item.to + 1);
      continue;
    }
    if (item.from > cursor) {
      issues.push({
        path: item.path,
        severity: 'error',
        code: 'SECTION_GAP',
        message: `${range(cursor, item.from - 1)}이 어느 대섹션에도 없다. 대섹션에 넣거나 skipped에 이유와 함께 적는다`,
      });
    } else if (item.from < cursor) {
      issues.push({
        path: item.path,
        severity: 'error',
        code: 'SECTION_OVERLAP',
        message: `${range(item.from, Math.min(item.to, cursor - 1))}이 앞 구간과 겹친다`,
      });
    }
    cursor = Math.max(cursor, item.to + 1);
  }
  if (cursor <= span.to) {
    issues.push({
      path: `${p}.sections`,
      severity: 'error',
      code: 'SECTION_GAP',
      message: `${range(cursor, span.to)}이 어느 대섹션에도 없다. 대섹션에 넣거나 skipped에 이유와 함께 적는다`,
    });
  }
}

function checkSubsectionCoverage(report: Report, p: string, issues: DigestIssue[]): void {
  report.sections.forEach((section, si) => {
    let cursor = section.cite.from;
    section.subsections.forEach((sub, bi) => {
      const path = `${p}.sections.${si}.subsections.${bi}.cite`;
      if (sub.cite.from > cursor) {
        issues.push({
          path,
          severity: 'error',
          code: 'SUBSECTION_GAP',
          message: `${range(cursor, sub.cite.from - 1)}이 어느 소섹션에도 없다`,
        });
      } else if (sub.cite.from < cursor) {
        issues.push({
          path,
          severity: 'error',
          code: 'SUBSECTION_OVERLAP',
          message: `${range(sub.cite.from, Math.min(sub.cite.to, cursor - 1))}이 앞 소섹션과 겹치거나 대섹션 밖이다`,
        });
      }
      cursor = Math.max(cursor, sub.cite.to + 1);
    });
    if (cursor <= section.cite.to) {
      issues.push({
        path: `${p}.sections.${si}.subsections`,
        severity: 'error',
        code: 'SUBSECTION_GAP',
        message: `${range(cursor, section.cite.to)}이 어느 소섹션에도 없다`,
      });
    } else if (cursor > section.cite.to + 1) {
      issues.push({
        path: `${p}.sections.${si}.subsections`,
        severity: 'error',
        code: 'SUBSECTION_OVERLAP',
        message: `소섹션이 대섹션 끝(${section.cite.to}번 문장)을 넘어간다`,
      });
    }
  });
}

function checkCites(report: Report, p: string, total: number, issues: DigestIssue[]): void {
  for (const { path, cite, within } of collectCites(report, p)) {
    if (cite.to >= total) {
      issues.push({
        path,
        severity: 'error',
        code: 'CITE_OUT_OF_RANGE',
        message: `${cite.to}번 문장이 없다. 스크립트는 0~${total - 1}번이다`,
      });
    }
    if (cite.key < cite.from || cite.key > cite.to) {
      issues.push({
        path: `${path}.key`,
        severity: 'error',
        code: 'KEY_OUT_OF_RANGE',
        message: `key(${cite.key})가 ${range(cite.from, cite.to)} 밖이다`,
      });
    }
    if (within && (cite.from < within.cite.from || cite.to > within.cite.to)) {
      issues.push({
        path,
        severity: 'error',
        code: within.code,
        message: `${range(cite.from, cite.to)}이 ${within.name} 범위(${range(within.cite.from, within.cite.to)}) 밖이다`,
      });
    }
  }
  // skipped도 커버리지 계산에 들어가니 범위 밖 구간으로 SECTION_GAP을 덮지 못하게 막는다
  report.skipped.forEach((s, i) => {
    if (s.to >= total) {
      issues.push({
        path: `${p}.skipped.${i}`,
        severity: 'error',
        code: 'CITE_OUT_OF_RANGE',
        message: `${s.to}번 문장이 없다. 스크립트는 0~${total - 1}번이다`,
      });
    }
  });
}

function checkBulletDepth(report: Report, p: string, issues: DigestIssue[]): void {
  report.sections.forEach((section, si) => {
    section.subsections.forEach((sub, bi) => {
      const prefix = `${p}.sections.${si}.subsections.${bi}.bullets`;
      for (const { bullet, path, depth } of walkBullets(sub.bullets, prefix)) {
        // 2단 불릿에서 처음 넘친 자리만 알린다. 더 깊은 단은 같은 원인이다
        if (depth === 1 && bullet.children && bullet.children.length > 0) {
          issues.push({
            path: `${path}.children`,
            severity: 'error',
            code: 'BULLET_DEPTH',
            message: '불릿은 2단까지다',
          });
        }
      }
    });
  });
}

// 제목은 목차와 미니맵, 마크다운에 글자 그대로 나가서 마커를 풀지 않는다
function checkTitleMarkers(report: Report, p: string, issues: DigestIssue[]): void {
  const check = (title: string, path: string): void => {
    if (title.includes('**') || title.includes('{{kw:')) {
      issues.push({
        path,
        severity: 'error',
        code: 'TITLE_MARKER',
        message: '제목에는 굵게(**)와 키워드 마커({{kw:}})를 쓰지 않는다',
      });
    }
  };
  report.sections.forEach((section, si) => {
    check(section.title, `${p}.sections.${si}.title`);
    section.subsections.forEach((sub, bi) => {
      const bp = `${p}.sections.${si}.subsections.${bi}`;
      check(sub.title, `${bp}.title`);
      // 장면 설명은 그림 캡션과 alt로 글자 그대로 나간다
      sub.shots?.forEach((shot, k) => check(shot.caption, `${bp}.shots.${k}.caption`));
    });
    // 도식 라벨과 설명도 SVG와 목록에 글자 그대로 나간다
    const d = section.diagram;
    if (d) {
      const dp = `${p}.sections.${si}.diagram`;
      if (d.caption) check(d.caption, `${dp}.caption`);
      for (const node of walkDiagram(d, dp)) {
        check(node.label, node.labelPath);
      }
    }
  });
}

function checkDiagramShapes(report: Report, p: string, issues: DigestIssue[]): void {
  report.sections.forEach((section, si) => {
    if (section.diagram) checkDiagramShape(section.diagram, `${p}.sections.${si}.diagram`, issues);
  });
}

function checkKeywords(report: Report, p: string, issues: DigestIssue[]): void {
  const known = new Set(report.keywords.map((k) => k.id));
  // 제목의 마커는 TITLE_MARKER 하나로 알린다
  const fields = collectReportText(report, p).filter((f) => !f.path.endsWith('.title'));
  for (const field of fields) {
    for (const m of field.text.matchAll(keywordPattern())) {
      const id = m[1]!;
      if (!known.has(id)) {
        issues.push({
          path: field.path,
          severity: 'error',
          code: 'UNKNOWN_KEYWORD',
          message: `키워드 ${id}가 keywords에 없다`,
        });
      }
    }
    if (field.text.replace(boldPattern(), '').includes('**')) {
      issues.push({
        path: field.path,
        severity: 'warning',
        code: 'UNBALANCED_BOLD',
        message: '** 짝이 맞지 않아 굵게가 풀린 채로 보인다',
      });
    }
  }
}

function checkFrameSec(
  report: Report,
  p: string,
  transcript: Transcript,
  issues: DigestIssue[],
): void {
  report.sections.forEach((section, si) => {
    section.subsections.forEach((sub, bi) => {
      const first = transcript.segments[sub.cite.from];
      if (!first) return; // CITE_OUT_OF_RANGE가 이미 잡는다
      if (Math.abs(sub.frameSec - first.startSec) > FRAME_SEC_TOLERANCE) {
        issues.push({
          path: `${p}.sections.${si}.subsections.${bi}.frameSec`,
          severity: 'error',
          code: 'FRAME_SEC_MISMATCH',
          message: `frameSec(${sub.frameSec})이 첫 문장(${sub.cite.from}번) 시각 ${first.startSec}과 다르다`,
        });
      }
    });
  });
}

/** 장면 시각이 후보와 같은지 볼 때의 여유. scenes.json은 소수 둘째 자리까지 적는다 */
const SHOT_SEC_TOLERANCE = 0.05;

/**
 * shots 시각이 소섹션 구간 안의 후보 장면인지 본다. 구간 끝은 다음 문장 시작이고 마지막 문장이면 영상 끝이다.
 * scenes가 undefined면 후보 대조를 건너뛰고 null이면 파일이 없는 것이라 장면을 하나도 받지 않는다
 */
function checkShots(
  report: Report,
  p: string,
  transcript: Transcript,
  scenes: readonly number[] | null | undefined,
  issues: DigestIssue[],
): void {
  const segs = transcript.segments;
  report.sections.forEach((section, si) => {
    section.subsections.forEach((sub, bi) => {
      const first = segs[sub.cite.from];
      // 소섹션 cite가 스크립트 밖이면 CITE_OUT_OF_RANGE가 이미 오류를 낸다
      if (!first || !sub.shots) return;
      const start = first.startSec;
      const end = segs[sub.cite.to + 1]?.startSec ?? transcript.meta.durationSec;
      sub.shots.forEach((shot, k) => {
        const path = `${p}.sections.${si}.subsections.${bi}.shots.${k}.sec`;
        if (shot.sec < start || shot.sec >= end) {
          issues.push({
            path,
            severity: 'error',
            code: 'SHOT_OUT_OF_RANGE',
            message: `장면 시각 ${shot.sec}초가 소섹션 구간(${start}~${end}초) 밖이다`,
          });
          return;
        }
        if (scenes === undefined) return;
        if (scenes === null) {
          issues.push({
            path,
            severity: 'error',
            code: 'SHOT_NO_SCENES',
            message:
              'scenes.json이 없거나 읽을 수 없다. gestalt digest scenes로 후보 장면을 다시 뽑는다',
          });
          return;
        }
        if (!scenes.some((sec) => Math.abs(sec - shot.sec) <= SHOT_SEC_TOLERANCE)) {
          issues.push({
            path,
            severity: 'error',
            code: 'SHOT_NOT_SCENE',
            message: `장면 시각 ${shot.sec}초가 scenes.json 후보에 없다. 후보 시각을 그대로 쓴다`,
          });
        }
      });
    });
  });
}

// 목차 앵커가 id로 걸려서 겹치면 엉뚱한 섹션으로 간다
function checkDuplicateIds(report: Report, p: string, issues: DigestIssue[]): void {
  const seen = new Map<string, string>();
  const visit = (id: string, path: string): void => {
    const before = seen.get(id);
    if (before) {
      issues.push({
        path,
        severity: 'error',
        code: 'DUPLICATE_ID',
        message: `id ${id}가 ${before}와 겹친다`,
      });
    } else {
      seen.set(id, path);
    }
  };
  report.sections.forEach((section, si) => {
    visit(section.id, `${p}.sections.${si}.id`);
    section.subsections.forEach((sub, bi) =>
      visit(sub.id, `${p}.sections.${si}.subsections.${bi}.id`),
    );
  });
  const kwSeen = new Set<string>();
  report.keywords.forEach((kw, ki) => {
    if (kwSeen.has(kw.id)) {
      issues.push({
        path: `${p}.keywords.${ki}.id`,
        severity: 'error',
        code: 'DUPLICATE_ID',
        message: `키워드 id ${kw.id}가 겹친다`,
      });
    }
    kwSeen.add(kw.id);
  });
}

/**
 * 리포트마다 붙어야 할 도식 수. 쉬운 난이도는 그림이 글을 대신 읽어 주는 몫이 커서 대섹션마다 하나,
 * 짧게는 대섹션이 몇 개든 하나, 나머지는 대섹션 수의 절반(올림)이다
 */
export function diagramTarget(report: Report): number {
  const n = report.sections.length;
  if (report.options.difficulty === 'easy') return n;
  if (report.options.length === 'short') return Math.min(1, n);
  return Math.ceil(n / 2);
}

// 잡담이나 브이로그처럼 그릴 구조가 없는 영상도 있어서 경고로만 알린다
function checkDiagramCount(report: Report, p: string, issues: DigestIssue[]): void {
  const have = report.sections.filter((s) => s.diagram).length;
  const want = diagramTarget(report);
  if (have < want) {
    issues.push({
      path: `${p}.sections`,
      severity: 'warning',
      code: 'DIAGRAM_TOO_FEW',
      message: `도식이 ${have}개다. 이 리포트는 ${want}개 이상을 권한다. 단계나 고리, 견주기, 가지, 시간 흐름, 원인과 결과가 있는 대섹션에 붙인다`,
    });
  }
}

function checkVolume(report: Report, p: string, issues: DigestIssue[]): void {
  const { subsections: subRange, bullets: bulletRange } = VOLUME_BY_LENGTH[report.options.length];
  report.sections.forEach((section, si) => {
    const n = section.subsections.length;
    if (n < subRange.min || n > subRange.max) {
      issues.push({
        path: `${p}.sections.${si}.subsections`,
        severity: 'warning',
        code: 'SUBSECTION_COUNT',
        message: `소섹션이 ${n}개다. 대섹션마다 ${subRange.min}~${subRange.max}개를 권한다`,
      });
    }
    section.subsections.forEach((sub, bi) => {
      const b = sub.bullets.length;
      if (b < bulletRange.min || b > bulletRange.max) {
        issues.push({
          path: `${p}.sections.${si}.subsections.${bi}.bullets`,
          severity: 'warning',
          code: 'BULLET_COUNT',
          message: `1단 불릿이 ${b}개다. ${bulletRange.min}~${bulletRange.max}개를 권한다`,
        });
      }
    });
  });
}

export interface DigestLintOptions extends ExtensionLintOptions {
  /**
   * scenes.json 후보 장면 시각. undefined면 shots를 후보와 대조하지 않는다.
   * null이면 파일이 없거나 읽을 수 없는 것이라 shots가 하나라도 있으면 오류다
   */
  scenes?: readonly number[] | null;
}

/**
 * 스키마를 통과한 digest가 스크립트와 맞물리는지 본다.
 * 오류가 하나라도 있으면 렌더하지 않는다. 경고는 분량처럼 영상마다 답이 다른 것들이다.
 */
export function lintDigest(
  digest: Digest,
  transcript: Transcript,
  opts: DigestLintOptions = {},
): DigestIssue[] {
  const issues: DigestIssue[] = [];
  if (digest.slug !== transcript.slug) {
    issues.push({
      path: 'slug',
      severity: 'error',
      code: 'SLUG_MISMATCH',
      message: `digest slug(${digest.slug})가 transcript slug(${transcript.slug})와 다르다`,
    });
  }
  const seenKeys = new Map<string, number>();
  digest.reports.forEach((report, ri) => {
    const p = `reports.${ri}`;
    const key = reportKey(report.options);
    const before = seenKeys.get(key);
    if (before !== undefined) {
      issues.push({
        path: `${p}.options`,
        severity: 'error',
        code: 'DUPLICATE_REPORT',
        message: `reports.${before}와 옵션이 같다(${key}). 툴바가 둘 중 하나만 고른다`,
      });
    } else {
      seenKeys.set(key, ri);
    }
    lintReport(report, p, transcript, issues);
    checkShots(report, p, transcript, opts.scenes, issues);
  });
  lintExtensions(digest.extensions, transcript, issues, opts);
  return issues;
}

function lintReport(
  report: Report,
  p: string,
  transcript: Transcript,
  issues: DigestIssue[],
): void {
  const total = transcript.segments.length;
  let span: { from: number; to: number } | null = { from: 0, to: total - 1 };
  if (report.options.range) {
    span = rangeSpan(report.options.range, transcript.segments);
    if (!span) {
      issues.push({
        path: `${p}.options.range`,
        severity: 'error',
        code: 'RANGE_EMPTY',
        message: `구간 ${report.options.range[0]}~${report.options.range[1]}초에 든 문장이 없다`,
      });
    }
  }
  if (span) checkSectionCoverage(report, p, span, issues);
  checkSubsectionCoverage(report, p, issues);
  checkCites(report, p, total, issues);
  // 대섹션 아래 출처는 커버리지와 소섹션 범위 검사가 이미 구간 안으로 묶는다. 키워드만 따로 본다
  if (report.options.range && span) {
    const s = span;
    report.keywords.forEach((kw, ki) => {
      if (kw.firstCite.from < s.from || kw.firstCite.to > s.to) {
        issues.push({
          path: `${p}.keywords.${ki}.firstCite`,
          severity: 'error',
          code: 'OUT_OF_REPORT_RANGE',
          message: `${range(kw.firstCite.from, kw.firstCite.to)}이 리포트 구간(${range(s.from, s.to)}) 밖이다`,
        });
      }
    });
  }
  checkBulletDepth(report, p, issues);
  checkTitleMarkers(report, p, issues);
  checkDiagramShapes(report, p, issues);
  checkKeywords(report, p, issues);
  checkFrameSec(report, p, transcript, issues);
  checkDuplicateIds(report, p, issues);
  checkVolume(report, p, issues);
  checkDiagramCount(report, p, issues);
}

export function lintErrors(issues: DigestIssue[]): DigestIssue[] {
  return issues.filter((i) => i.severity === 'error');
}
