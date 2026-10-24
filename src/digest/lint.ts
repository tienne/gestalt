import {
  boldPattern,
  keywordPattern,
  type Bullet,
  type Cite,
  type Digest,
  type Transcript,
} from './schema.js';

export type DigestIssueSeverity = 'error' | 'warning';

export interface DigestIssue {
  path: string;
  severity: DigestIssueSeverity;
  code: string;
  message: string;
}

export const SUBSECTIONS_PER_SECTION = { min: 2, max: 3 } as const;
export const TOP_BULLETS_PER_SUBSECTION = { min: 2, max: 4 } as const;

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

/** 본문에 들어가는 문자열을 전부 경로와 함께 모은다. 키워드 마커 검사가 쓴다 */
export function collectTextFields(digest: Digest): TextField[] {
  const out: TextField[] = [];
  const { report } = digest;
  out.push({ path: 'report.lead.question', text: report.lead.question });
  out.push({ path: 'report.lead.answer', text: report.lead.answer });
  out.push({ path: 'report.lead.takeaway', text: report.lead.takeaway });
  report.sections.forEach((section, si) => {
    const sp = `report.sections.${si}`;
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
    out.push({ path: `report.keywords.${ki}.explanation`, text: kw.explanation });
  });
  report.skipped.forEach((s, i) => {
    out.push({ path: `report.skipped.${i}.reason`, text: s.reason });
  });
  return out;
}

interface CiteField {
  path: string;
  cite: Cite;
  /** 불릿이면 소속 소섹션 범위. 키워드 firstCite처럼 범위 제한이 없으면 비운다 */
  within?: Cite;
}

function collectCites(digest: Digest): CiteField[] {
  const out: CiteField[] = [];
  digest.report.sections.forEach((section, si) => {
    const sp = `report.sections.${si}`;
    out.push({ path: `${sp}.cite`, cite: section.cite });
    section.subsections.forEach((sub, bi) => {
      const bp = `${sp}.subsections.${bi}`;
      out.push({ path: `${bp}.cite`, cite: sub.cite });
      for (const { bullet, path } of walkBullets(sub.bullets, `${bp}.bullets`)) {
        out.push({ path: `${path}.cite`, cite: bullet.cite, within: sub.cite });
      }
    });
  });
  digest.report.keywords.forEach((kw, ki) => {
    out.push({ path: `report.keywords.${ki}.firstCite`, cite: kw.firstCite });
  });
  return out;
}

/** 대섹션과 skipped를 합쳐 0번부터 마지막 문장까지 빈틈과 겹침 없이 덮는지 본다 */
function checkSectionCoverage(digest: Digest, total: number, issues: DigestIssue[]): void {
  const { sections, skipped } = digest.report;
  sections.forEach((section, si) => {
    const prev = sections[si - 1];
    if (prev && section.cite.from <= prev.cite.from) {
      issues.push({
        path: `report.sections.${si}.cite`,
        severity: 'error',
        code: 'SECTION_ORDER',
        message: '대섹션은 스크립트 순서대로 놓는다',
      });
    }
  });

  const spans = [
    ...sections.map((s, si) => ({
      path: `report.sections.${si}.cite`,
      from: s.cite.from,
      to: s.cite.to,
    })),
    ...skipped.map((s, i) => ({ path: `report.skipped.${i}`, from: s.from, to: s.to })),
  ].sort((a, b) => a.from - b.from);

  let cursor = 0;
  for (const span of spans) {
    if (span.from > span.to) {
      issues.push({
        path: span.path,
        severity: 'error',
        code: 'SECTION_GAP',
        message: `from(${span.from})이 to(${span.to})보다 크다`,
      });
      continue;
    }
    if (span.from > cursor) {
      issues.push({
        path: span.path,
        severity: 'error',
        code: 'SECTION_GAP',
        message: `${range(cursor, span.from - 1)}이 어느 대섹션에도 없다. 대섹션에 넣거나 skipped에 이유와 함께 적는다`,
      });
    } else if (span.from < cursor) {
      issues.push({
        path: span.path,
        severity: 'error',
        code: 'SECTION_OVERLAP',
        message: `${range(span.from, Math.min(span.to, cursor - 1))}이 앞 구간과 겹친다`,
      });
    }
    cursor = Math.max(cursor, span.to + 1);
  }
  if (cursor < total) {
    issues.push({
      path: 'report.sections',
      severity: 'error',
      code: 'SECTION_GAP',
      message: `${range(cursor, total - 1)}이 어느 대섹션에도 없다. 대섹션에 넣거나 skipped에 이유와 함께 적는다`,
    });
  }
}

function checkSubsectionCoverage(digest: Digest, issues: DigestIssue[]): void {
  digest.report.sections.forEach((section, si) => {
    let cursor = section.cite.from;
    section.subsections.forEach((sub, bi) => {
      const path = `report.sections.${si}.subsections.${bi}.cite`;
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
        path: `report.sections.${si}.subsections`,
        severity: 'error',
        code: 'SUBSECTION_GAP',
        message: `${range(cursor, section.cite.to)}이 어느 소섹션에도 없다`,
      });
    } else if (cursor > section.cite.to + 1) {
      issues.push({
        path: `report.sections.${si}.subsections`,
        severity: 'error',
        code: 'SUBSECTION_OVERLAP',
        message: `소섹션이 대섹션 끝(${section.cite.to}번 문장)을 넘어간다`,
      });
    }
  });
}

function checkCites(digest: Digest, total: number, issues: DigestIssue[]): void {
  for (const { path, cite, within } of collectCites(digest)) {
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
    if (within && (cite.from < within.from || cite.to > within.to)) {
      issues.push({
        path,
        severity: 'error',
        code: 'BULLET_CITE_OUT_OF_SUBSECTION',
        message: `${range(cite.from, cite.to)}이 소섹션 범위(${range(within.from, within.to)}) 밖이다`,
      });
    }
  }
  // skipped도 커버리지 계산에 들어가니 범위 밖 구간으로 SECTION_GAP을 덮지 못하게 막는다
  digest.report.skipped.forEach((s, i) => {
    if (s.to >= total) {
      issues.push({
        path: `report.skipped.${i}`,
        severity: 'error',
        code: 'CITE_OUT_OF_RANGE',
        message: `${s.to}번 문장이 없다. 스크립트는 0~${total - 1}번이다`,
      });
    }
  });
}

function checkBulletDepth(digest: Digest, issues: DigestIssue[]): void {
  digest.report.sections.forEach((section, si) => {
    section.subsections.forEach((sub, bi) => {
      const prefix = `report.sections.${si}.subsections.${bi}.bullets`;
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
function checkTitleMarkers(digest: Digest, issues: DigestIssue[]): void {
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
  digest.report.sections.forEach((section, si) => {
    check(section.title, `report.sections.${si}.title`);
    section.subsections.forEach((sub, bi) =>
      check(sub.title, `report.sections.${si}.subsections.${bi}.title`),
    );
  });
}

function checkKeywords(digest: Digest, issues: DigestIssue[]): void {
  const known = new Set(digest.report.keywords.map((k) => k.id));
  // 제목의 마커는 TITLE_MARKER 하나로 알린다
  const fields = collectTextFields(digest).filter((f) => !f.path.endsWith('.title'));
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

function checkFrameSec(digest: Digest, transcript: Transcript, issues: DigestIssue[]): void {
  digest.report.sections.forEach((section, si) => {
    section.subsections.forEach((sub, bi) => {
      const first = transcript.segments[sub.cite.from];
      if (!first) return; // CITE_OUT_OF_RANGE가 이미 잡는다
      if (Math.abs(sub.frameSec - first.startSec) > FRAME_SEC_TOLERANCE) {
        issues.push({
          path: `report.sections.${si}.subsections.${bi}.frameSec`,
          severity: 'error',
          code: 'FRAME_SEC_MISMATCH',
          message: `frameSec(${sub.frameSec})이 첫 문장(${sub.cite.from}번) 시각 ${first.startSec}과 다르다`,
        });
      }
    });
  });
}

// 목차 앵커가 id로 걸려서 겹치면 엉뚱한 섹션으로 간다
function checkDuplicateIds(digest: Digest, issues: DigestIssue[]): void {
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
  digest.report.sections.forEach((section, si) => {
    visit(section.id, `report.sections.${si}.id`);
    section.subsections.forEach((sub, bi) =>
      visit(sub.id, `report.sections.${si}.subsections.${bi}.id`),
    );
  });
  const kwSeen = new Set<string>();
  digest.report.keywords.forEach((kw, ki) => {
    if (kwSeen.has(kw.id)) {
      issues.push({
        path: `report.keywords.${ki}.id`,
        severity: 'error',
        code: 'DUPLICATE_ID',
        message: `키워드 id ${kw.id}가 겹친다`,
      });
    }
    kwSeen.add(kw.id);
  });
}

function checkVolume(digest: Digest, issues: DigestIssue[]): void {
  digest.report.sections.forEach((section, si) => {
    const n = section.subsections.length;
    if (n < SUBSECTIONS_PER_SECTION.min || n > SUBSECTIONS_PER_SECTION.max) {
      issues.push({
        path: `report.sections.${si}.subsections`,
        severity: 'warning',
        code: 'SUBSECTION_COUNT',
        message: `소섹션이 ${n}개다. 대섹션마다 ${SUBSECTIONS_PER_SECTION.min}~${SUBSECTIONS_PER_SECTION.max}개를 권한다`,
      });
    }
    section.subsections.forEach((sub, bi) => {
      const b = sub.bullets.length;
      if (b < TOP_BULLETS_PER_SUBSECTION.min || b > TOP_BULLETS_PER_SUBSECTION.max) {
        issues.push({
          path: `report.sections.${si}.subsections.${bi}.bullets`,
          severity: 'warning',
          code: 'BULLET_COUNT',
          message: `1단 불릿이 ${b}개다. ${TOP_BULLETS_PER_SUBSECTION.min}~${TOP_BULLETS_PER_SUBSECTION.max}개를 권한다`,
        });
      }
    });
  });
}

/**
 * 스키마를 통과한 digest가 스크립트와 맞물리는지 본다.
 * 오류가 하나라도 있으면 렌더하지 않는다. 경고는 분량처럼 영상마다 답이 다른 것들이다.
 */
export function lintDigest(digest: Digest, transcript: Transcript): DigestIssue[] {
  const issues: DigestIssue[] = [];
  const total = transcript.segments.length;
  if (digest.slug !== transcript.slug) {
    issues.push({
      path: 'slug',
      severity: 'error',
      code: 'SLUG_MISMATCH',
      message: `digest slug(${digest.slug})가 transcript slug(${transcript.slug})와 다르다`,
    });
  }
  checkSectionCoverage(digest, total, issues);
  checkSubsectionCoverage(digest, issues);
  checkCites(digest, total, issues);
  checkBulletDepth(digest, issues);
  checkTitleMarkers(digest, issues);
  checkKeywords(digest, issues);
  checkFrameSec(digest, transcript, issues);
  checkDuplicateIds(digest, issues);
  checkVolume(digest, issues);
  return issues;
}

export function lintErrors(issues: DigestIssue[]): DigestIssue[] {
  return issues.filter((i) => i.severity === 'error');
}
