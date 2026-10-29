import { isCellRef, type DoubtDirection, type Evidence, type GlanceKind } from './lens-schema.js';
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
 * 영문자 바로 뒤에 붙은 숫자(CSP2, v3)는 이름의 일부라 세지 않는다. "제3자"처럼 서수 접두 "제"가 붙은 숫자도 말이라 세지 않는다
 */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9_.제])[-−]?\d+(?:,\d{3})*(?:\.\d+)?/g)) {
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

/** source.json을 못 읽었을 때 표 칸 출처에 붙이는 안내. 형식 오류면 ingest를 다시 돌려도 안 풀릴 수 있다 */
function noSourceMessage(problem: 'missing' | 'invalid' | undefined): string {
  return problem === 'invalid'
    ? 'source.json 형식이 틀려서 표와 그림을 대조할 수 없다. 파일을 고치거나 gestalt lens ingest로 다시 만든다'
    : 'source.json이 없어 표와 그림을 대조할 수 없다. gestalt lens ingest를 다시 돌린다';
}

function checkEvidence(
  evidence: Evidence[],
  path: string,
  source: LensSource | null,
  issues: DigestIssue[],
  problem?: 'missing' | 'invalid',
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
          : noSourceMessage(problem),
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

/**
 * 방향 의심의 부호를 칸 값으로 계산해 본문 주장과 견준다. 주장대로 움직였으면 의심이 아니다.
 * 칸 경계를 못 믿는 표(loose)는 칸이 한 칸 밀려도 부호가 뒤집혀서 받지 않는다
 */
function checkDirection(
  direction: DoubtDirection,
  path: string,
  source: LensSource | null,
  issues: DigestIssue[],
  problem?: 'missing' | 'invalid',
): void {
  const before = issues.length;
  checkEvidence([direction.from, direction.to], path, source, issues, problem);
  if (issues.length > before || !source) return;
  if (direction.from.table !== direction.to.table) {
    issues.push({
      path: `${path}.to`,
      severity: 'error',
      code: 'DOUBT_DIRECTION_TABLE_MISMATCH',
      message:
        '방향 의심의 두 칸은 같은 표에 있어야 한다. 다른 표끼리는 조건이 달라 부호를 견줄 수 없다',
    });
    return;
  }
  const table = source.tables.find((t) => t.id === direction.from.table)!;
  if (table.grid === 'loose') {
    issues.push({
      path,
      severity: 'error',
      code: 'DOUBT_DIRECTION_LOOSE_TABLE',
      message: `${table.id}는 칸 경계를 못 믿는 표(loose)라 칸이 밀리면 부호가 뒤집힌다. 방향 의심을 빼거나 근거 문단의 숫자로 숫자 의심을 단다`,
    });
    return;
  }
  const [from, to] = [direction.from, direction.to].map((ref) => {
    const text = table.rows[ref.row]?.[ref.col];
    return text === undefined ? null : cellNumber(text);
  });
  if (from === null || to === null || from === undefined || to === undefined) {
    issues.push({
      path,
      severity: 'error',
      code: 'DOUBT_DIRECTION_NOT_NUMERIC',
      message:
        '방향 의심의 두 칸은 숫자 하나만 든 칸이어야 한다. 머리줄이나 글자 칸, "0.3±0.1" 같은 칸은 부호를 계산할 수 없다',
    });
    return;
  }
  // 주장대로라면 값이 움직일 쪽. 성능을 올린다(increase)인데 낮을수록 좋은 지표(lower)면 값은 내려가야 한다
  const expected =
    (direction.claim === 'increase' ? 1 : -1) * (direction.better === 'higher' ? 1 : -1);
  if (Math.sign(to - from) === expected) {
    issues.push({
      path,
      severity: 'error',
      code: 'DOUBT_DIRECTION_AGREES',
      message: `표에서 ${from}에서 ${to}로 주장한 방향대로 움직였다. 어긋나지 않는 자리라 의심 표시를 지운다`,
    });
  }
}

function checkDoubts(
  report: Report,
  p: string,
  source: LensSource | null,
  transcript: Transcript,
  issues: DigestIssue[],
  problem?: 'missing' | 'invalid',
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
        checkEvidence(d.evidence, `${dp}.evidence`, source, issues, problem);
        if (d.direction) checkDirection(d.direction, `${dp}.direction`, source, issues, problem);
        // 숫자끼리, 또는 방향 주장과 표 부호가 어긋난 자리만 짚는다. 해석이 갈리는 자리는 맥락 카드 몫이다
        const cells = d.direction ? [...d.evidence, d.direction.from, d.direction.to] : d.evidence;
        const cellValues = cells.flatMap((ev) => {
          if (!isCellRef(ev)) return [];
          const text = source?.tables.find((t) => t.id === ev.table)?.rows[ev.row]?.[ev.col];
          const n = text === undefined ? null : cellNumber(text);
          // numbersIn이 부호를 떼므로 칸 값도 떼어 견준다. 음수 칸을 적은 note가 막히지 않게 한다
          return n === null ? [] : [Math.abs(n)];
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
          allowedNumbers(cells, source, transcript, [bullet.cite]),
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
  problem?: 'missing' | 'invalid',
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
    checkEvidence(limit.evidence, `${lp}.evidence`, source, issues, problem);
    // 카드만 단 줄은 바깥 자료의 숫자를 옮길 수 있어 대조하지 않는다. 근거를 같이 달면 뷰어가 원문 칸 칩을 붙이므로 대조한다
    if (!limit.card || limit.evidence.length > 0) {
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
  problem?: 'missing' | 'invalid',
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
          message: source ? `표 ${t.ref}가 source.json에 없다` : noSourceMessage(problem),
        });
      });
      sub.figures?.forEach((f, k) => {
        if (source?.figures.some((x) => x.id === f.ref)) return;
        issues.push({
          path: `${bp}.figures.${k}.ref`,
          severity: 'error',
          code: 'FIGURE_REF_UNKNOWN',
          message: source ? `그림 ${f.ref}가 source.json에 없다` : noSourceMessage(problem),
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
  sourceProblem?: 'missing' | 'invalid',
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
  checkSourceRefs(report, p, source, issues, sourceProblem);
  checkDoubts(report, p, source, transcript, issues, sourceProblem);
  checkLimits(report, p, source, transcript, issues, sourceProblem);
}
