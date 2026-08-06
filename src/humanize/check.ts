/**
 * 윤문 결과를 코드가 판단하는 검사.
 *
 * 모델이 스스로 매긴 변경률·등급은 참고값이다. 문자 기반 변경률 하나로는
 * 구조 편집이 안 보인다 — 변경률 2.8%인데 문장 3할이 갈려나간 사례가 있다.
 * 그래서 변경률, 잔존, 보존, 구조 4가지 측면에서 각각 측정하고, 판단한다.
 */
import { changeRate } from './change-rate.js';
import { countByRule, missingProtectedTokens, structureStats } from './detectors.js';
import { parseRuleBook, s1Ids, type Register, type RuleBook } from './rules.js';

export type Verdict = 'pass' | 'warn' | 'abort';

export const EXIT_CODE: Record<Verdict | 'unknown', number> = {
  pass: 0,
  warn: 1,
  abort: 2,
  unknown: 3,
};

export const THRESHOLD = {
  changeWarn: 0.3,
  changeAbort: 0.5,
  sentenceDrop: 0.25,
} as const;

export interface AxisResult {
  axis: 'change-rate' | 'residual-s1' | 'preservation' | 'structure';
  verdict: Verdict;
  detail: string;
  evidence?: string[];
}

export interface CheckReport {
  register: Register;
  verdict: Verdict;
  exitCode: number;
  changeRate: number;
  changeRateNoMarkup: number;
  axes: AxisResult[];
  residualS1: { ruleId: string; before: number; after: number }[];
  introduced: { ruleId: string; before: number; after: number }[];
}

const WORST: Record<Verdict, number> = { pass: 0, warn: 1, abort: 2 };

function worst(verdicts: Verdict[]): Verdict {
  return verdicts.reduce((acc, v) => (WORST[v] > WORST[acc] ? v : acc), 'pass' as Verdict);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function checkChangeRate(rate: number, rateNoMarkup: number): AxisResult {
  const detail = `변경률 ${pct(rate)} (마크업 제외 ${pct(rateNoMarkup)})`;
  if (rate >= THRESHOLD.changeAbort) {
    return { axis: 'change-rate', verdict: 'abort', detail: `${detail} — 50% 이상, 채택 금지` };
  }
  if (rate >= THRESHOLD.changeWarn) {
    return { axis: 'change-rate', verdict: 'warn', detail: `${detail} — 30% 이상, 과윤문 의심` };
  }
  return { axis: 'change-rate', verdict: 'pass', detail };
}

function checkResidualS1(
  book: RuleBook,
  register: Register,
  before: string,
  after: string,
): { axis: AxisResult; residual: CheckReport['residualS1'] } {
  const targets = s1Ids(book, register);
  const beforeCounts = countByRule(before, targets);
  const afterCounts = countByRule(after, targets);

  const residual = targets
    .map((ruleId) => ({
      ruleId,
      before: beforeCounts.get(ruleId) ?? 0,
      after: afterCounts.get(ruleId) ?? 0,
    }))
    .filter((row) => row.after > 0);

  if (residual.length === 0) {
    return {
      axis: { axis: 'residual-s1', verdict: 'pass', detail: 'S1 잔존 0건' },
      residual,
    };
  }

  const evidence = residual.map((row) => `${row.ruleId}: ${row.before} → ${row.after}`);
  return {
    axis: {
      axis: 'residual-s1',
      verdict: 'warn',
      detail: `S1 ${residual.length}종 잔존`,
      evidence,
    },
    residual,
  };
}

/** 철칙 — AI 티는 빼기만 하고 넣지 않는다. 늘어난 룰이 있으면 윤문이 새 티를 심은 것이다 */
function findIntroduced(before: string, after: string): CheckReport['introduced'] {
  const beforeCounts = countByRule(before);
  const afterCounts = countByRule(after);

  return [...afterCounts.entries()]
    .map(([ruleId, count]) => ({ ruleId, before: beforeCounts.get(ruleId) ?? 0, after: count }))
    .filter((row) => row.after > row.before)
    .sort((a, b) => b.after - b.before - (a.after - a.before));
}

function checkPreservation(before: string, after: string): AxisResult {
  const missing = missingProtectedTokens(before, after);
  if (missing.length === 0) {
    return { axis: 'preservation', verdict: 'pass', detail: '수치·인용·코드·고유명사 전부 생존' };
  }
  return {
    axis: 'preservation',
    verdict: 'abort',
    detail: `보호 토큰 ${missing.length}건 유실 — 의미 불변 위반`,
    evidence: missing.slice(0, 10),
  };
}

function checkStructure(
  before: string,
  after: string,
  introduced: CheckReport['introduced'],
): AxisResult {
  const a = structureStats(before);
  const b = structureStats(after);
  const problems: string[] = [];

  const drop = a.sentences === 0 ? 0 : (a.sentences - b.sentences) / a.sentences;
  if (drop > THRESHOLD.sentenceDrop) {
    problems.push(`문장 ${a.sentences} → ${b.sentences} (${pct(drop)} 감소) — 내용 유실 의심`);
  }
  if (b.codeFences < a.codeFences) {
    problems.push(`코드블록 ${a.codeFences / 2} → ${b.codeFences / 2}`);
  }
  if (b.links < a.links) {
    problems.push(`링크 ${a.links} → ${b.links}`);
  }
  for (const row of introduced.slice(0, 5)) {
    problems.push(`${row.ruleId} 신규 유입 ${row.before} → ${row.after}`);
  }

  if (problems.length === 0) {
    return { axis: 'structure', verdict: 'pass', detail: '구조·정보량 보존' };
  }
  return {
    axis: 'structure',
    verdict: 'warn',
    detail: `구조 이상 ${problems.length}건`,
    evidence: problems,
  };
}

export interface RunCheckOptions {
  register?: Register;
  book?: RuleBook;
}

export function runCheck(before: string, after: string, options: RunCheckOptions = {}): CheckReport {
  const register = options.register ?? 'doc';
  const book = options.book ?? parseRuleBook();

  const rate = changeRate(before, after);
  const rateNoMarkup = changeRate(before, after, { ignoreMarkup: true });

  const changeAxis = checkChangeRate(rate, rateNoMarkup);
  const { axis: s1Axis, residual } = checkResidualS1(book, register, before, after);
  const preservationAxis = checkPreservation(before, after);
  const introduced = findIntroduced(before, after);
  const structureAxis = checkStructure(before, after, introduced);

  const axes = [changeAxis, s1Axis, preservationAxis, structureAxis];
  const verdict = worst(axes.map((a) => a.verdict));

  return {
    register,
    verdict,
    exitCode: EXIT_CODE[verdict],
    changeRate: rate,
    changeRateNoMarkup: rateNoMarkup,
    axes,
    residualS1: residual,
    introduced,
  };
}

export function formatReport(report: CheckReport): string {
  const head = `검사 ${report.verdict.toUpperCase()} (exit ${report.exitCode}) / 말투 ${report.register}`;
  const lines = [head, ''];

  for (const axis of report.axes) {
    const mark = axis.verdict === 'pass' ? 'OK' : axis.verdict === 'warn' ? '경고' : '중단';
    lines.push(`[${mark}] ${axis.axis} — ${axis.detail}`);
    for (const item of axis.evidence ?? []) {
      lines.push(`       ${item}`);
    }
  }

  return lines.join('\n');
}
