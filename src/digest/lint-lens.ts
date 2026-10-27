import { isCellRef, type Evidence, type GlanceKind } from './lens-schema.js';
import { cellNumber, type LensSource } from './lens-source.js';
import type { DigestIssue } from './lint.js';
import type { Bullet, Cite, LensKind, Report, Transcript } from './schema.js';

/** 자료 종류마다 한눈에 보기에 꼭 있어야 할 칸. 순서는 뷰어가 그리는 순서다 */
export const GLANCE_REQUIRED: Record<LensKind, readonly GlanceKind[]> = {
  pdf: ['problem', 'method', 'result', 'limit'],
  web: ['claim', 'evidence', 'limit'],
  podcast: ['topic', 'claim', 'limit'],
};

/**
 * 글 속 숫자를 모은다. 천 단위 쉼표는 지우고 %는 뗀다. "표 4"의 4나 "50개"의 50도 숫자로 센다.
 * 영문자 바로 뒤에 붙은 숫자(CSP2, v3)는 이름의 일부라 세지 않는다
 */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9_.])[-−]?\d+(?:,\d{3})*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, '').replace('−', '-'));
    if (Number.isFinite(n)) out.push(Math.abs(n));
  }
  return out;
}

type Walked = { bullet: Bullet; path: string };

function* walk(bullets: Bullet[], prefix: string): Generator<Walked> {
  for (const [k, bullet] of bullets.entries()) {
    const path = `${prefix}.${k}`;
    yield { bullet, path };
    if (bullet.children) yield* walk(bullet.children, `${path}.children`);
  }
}

function unitText(transcript: Transcript, cite: Cite): string {
  return transcript.segments
    .slice(cite.from, cite.to + 1)
    .map((s) => s.text)
    .join(' ');
}

/**
 * 근거가 허락하는 숫자. 근거 칸이 든 줄 전체와 머리줄, 표 번호, 근거 문단의 숫자다.
 * 줄 이름("노드 50개")과 열 이름을 문장에 옮겨 쓸 수 있어야 해서 칸 하나보다 넓게 잡는다
 */
function allowedNumbers(
  evidence: Evidence[],
  source: LensSource | null,
  transcript: Transcript,
  extra: Cite[] = [],
): Set<number> {
  const allowed = new Set<number>();
  const add = (text: string) => numbersIn(text).forEach((n) => allowed.add(n));
  for (const ev of evidence) {
    if (isCellRef(ev)) {
      const table = source?.tables.find((t) => t.id === ev.table);
      if (!table) continue;
      add(table.number);
      table.rows[0]?.forEach(add);
      table.rows[ev.row]?.forEach(add);
    } else {
      add(unitText(transcript, ev.cite));
    }
  }
  for (const c of extra) add(unitText(transcript, c));
  return allowed;
}

function checkEvidence(
  evidence: Evidence[],
  path: string,
  source: LensSource | null,
  issues: DigestIssue[],
): void {
  evidence.forEach((ev, k) => {
    if (!isCellRef(ev)) return;
    const at = `${path}.${k}`;
    const table = source?.tables.find((t) => t.id === ev.table);
    if (!table) {
      issues.push({
        path: at,
        severity: 'error',
        code: 'TABLE_REF_UNKNOWN',
        message: source
          ? `표 ${ev.table}가 source.json에 없다. 있는 표: ${source.tables.map((t) => t.id).join(', ') || '없음'}`
          : 'source.json이 없어 표 칸을 대조할 수 없다. gestalt lens ingest를 다시 돌린다',
      });
      return;
    }
    if (table.rows[ev.row]?.[ev.col] === undefined) {
      issues.push({
        path: at,
        severity: 'error',
        code: 'CELL_REF_OUT_OF_RANGE',
        message: `${ev.table}에 ${ev.row}행 ${ev.col}열이 없다. 표는 ${table.rows.length}행이다(머리줄이 0행)`,
      });
    }
  });
}

/** 글에 든 숫자가 근거에 있는지 본다. 없는 숫자는 모델이 계산했거나 지어낸 값이다 */
function checkNumbers(
  text: string,
  allowed: Set<number>,
  path: string,
  code: string,
  issues: DigestIssue[],
): void {
  // "거의 0이다"의 0은 원문 값이 아니라 말이라 대조하지 않는다
  const unknown = [...new Set(numbersIn(text))].filter((n) => n !== 0 && !allowed.has(n));
  if (unknown.length === 0) return;
  issues.push({
    path,
    severity: 'error',
    code,
    message: `숫자 ${unknown.join(', ')}이 근거 칸이나 근거 문단에 없다. 원문 숫자만 그대로 쓰고 차이나 비율을 계산해 넣지 않는다`,
  });
}

function checkDoubts(
  report: Report,
  p: string,
  source: LensSource | null,
  transcript: Transcript,
  issues: DigestIssue[],
): number {
  let count = 0;
  report.sections.forEach((section, si) => {
    section.subsections.forEach((sub, bi) => {
      const prefix = `${p}.sections.${si}.subsections.${bi}.bullets`;
      for (const { bullet, path } of walk(sub.bullets, prefix)) {
        const d = bullet.doubt;
        if (!d) continue;
        count++;
        const dp = `${path}.doubt`;
        checkEvidence(d.evidence, `${dp}.evidence`, source, issues);
        // 1차는 숫자끼리 어긋난 자리만 짚는다. 해석이 갈리는 자리는 맥락 카드 몫이다
        const cellValues = d.evidence.flatMap((ev) => {
          if (!isCellRef(ev)) return [];
          const text = source?.tables.find((t) => t.id === ev.table)?.rows[ev.row]?.[ev.col];
          const n = text === undefined ? null : cellNumber(text);
          return n === null ? [] : [n];
        });
        const noteNumbers = numbersIn(d.note);
        const citesNumbers = d.evidence.some(
          (ev) => !isCellRef(ev) && numbersIn(unitText(transcript, ev.cite)).length > 0,
        );
        const pinned =
          cellValues.some((v) => noteNumbers.includes(v)) ||
          (cellValues.length === 0 && citesNumbers && noteNumbers.length > 0);
        if (!pinned) {
          issues.push({
            path: `${dp}.note`,
            severity: 'error',
            code: 'DOUBT_NOT_NUMERIC',
            message:
              '의심 표시는 원문 숫자끼리 어긋난 자리만 짚는다. note에 근거 칸의 숫자를 그대로 적는다. 해석이 갈리는 자리는 맥락 카드로 옮긴다',
          });
        }
        checkNumbers(
          d.note,
          allowedNumbers(d.evidence, source, transcript, [bullet.cite]),
          `${dp}.note`,
          'DOUBT_NUMBER_UNKNOWN',
          issues,
        );
      }
    });
  });
  return count;
}

function checkLimits(
  report: Report,
  p: string,
  source: LensSource | null,
  transcript: Transcript,
  issues: DigestIssue[],
): void {
  const limits = report.limits ?? [];
  if (limits.length === 0) {
    issues.push({
      path: `${p}.limits`,
      severity: 'error',
      code: 'LIMITS_MISSING',
      message:
        '검증 안 된 부분(limits)이 없다. 의심 표시와 맥락 카드, 원문이 스스로 밝힌 한계를 한 줄 이상 모은다',
    });
  }
  limits.forEach((limit, k) => {
    const lp = `${p}.limits.${k}`;
    if (limit.evidence.length === 0 && !limit.card) {
      issues.push({
        path: lp,
        severity: 'error',
        code: 'LIMIT_NO_SOURCE',
        message: '한계 한 줄마다 원문 근거(evidence)나 맥락 카드 id(card)를 단다',
      });
    }
    checkEvidence(limit.evidence, `${lp}.evidence`, source, issues);
    // 카드에서 온 줄은 바깥 자료의 숫자를 옮길 수 있어 대조하지 않는다
    if (!limit.card) {
      checkNumbers(
        limit.text,
        allowedNumbers(limit.evidence, source, transcript),
        `${lp}.text`,
        'LIMIT_NUMBER_UNKNOWN',
        issues,
      );
    }
  });
}

function checkGlance(report: Report, p: string, kind: LensKind, issues: DigestIssue[]): void {
  const have = new Set((report.lead.glance ?? []).map((g) => g.kind));
  const missing = GLANCE_REQUIRED[kind].filter((k) => !have.has(k));
  if (missing.length > 0) {
    issues.push({
      path: `${p}.lead.glance`,
      severity: 'error',
      code: 'GLANCE_MISSING',
      message: `한눈에 보기에 ${missing.join(', ')} 칸이 없다. ${kind} 자료는 ${GLANCE_REQUIRED[kind].join(', ')} 순서로 쓴다`,
    });
  }
}

function checkSourceRefs(
  report: Report,
  p: string,
  source: LensSource | null,
  issues: DigestIssue[],
): void {
  report.sections.forEach((section, si) => {
    if (!section.intro) {
      issues.push({
        path: `${p}.sections.${si}.intro`,
        severity: 'warning',
        code: 'INTRO_MISSING',
        message: '대섹션 머리에 장 도입 한 줄(intro)을 둔다',
      });
    }
    section.subsections.forEach((sub, bi) => {
      const bp = `${p}.sections.${si}.subsections.${bi}`;
      sub.tables?.forEach((t, k) => {
        if (source?.tables.some((x) => x.id === t.ref)) return;
        issues.push({
          path: `${bp}.tables.${k}.ref`,
          severity: 'error',
          code: 'TABLE_REF_UNKNOWN',
          message: `표 ${t.ref}가 source.json에 없다`,
        });
      });
      sub.figures?.forEach((f, k) => {
        if (source?.figures.some((x) => x.id === f.ref)) return;
        issues.push({
          path: `${bp}.figures.${k}.ref`,
          severity: 'error',
          code: 'FIGURE_REF_UNKNOWN',
          message: `그림 ${f.ref}가 source.json에 없다`,
        });
      });
    });
  });
}

/**
 * 읽기 렌즈 리포트가 원문과 맞물리는지 본다. 숫자가 든 칸은 원문 표나 문단과 대조한다.
 * 의심 표시는 원문 안의 어긋남만 받는다. 바깥 반론은 맥락 카드로 간다
 */
export function lintLensReport(
  report: Report,
  p: string,
  kind: LensKind,
  transcript: Transcript,
  source: LensSource | null,
  issues: DigestIssue[],
): void {
  if (report.options.range && kind !== 'podcast') {
    issues.push({
      path: `${p}.options.range`,
      severity: 'error',
      code: 'RANGE_NOT_SUPPORTED',
      message: '글 자료에는 시각 구간이 없다. 구간 리포트는 팟캐스트만 만든다',
    });
  }
  checkGlance(report, p, kind, issues);
  checkSourceRefs(report, p, source, issues);
  checkDoubts(report, p, source, transcript, issues);
  checkLimits(report, p, source, transcript, issues);
}
