/**
 * 윤문 결과를 코드가 판단하는 검사.
 *
 * 모델이 스스로 매긴 변경률·등급은 참고값이다. 문자 기반 변경률 하나로는
 * 구조 편집이 안 보인다 — 변경률 2.8%인데 문장 3할이 갈려나간 사례가 있다.
 * 그래서 변경률, 잔존, 보존, 구조, 유입 다섯 측면에서 각각 측정하고, 판단한다.
 *
 * 채택 금지(abort)는 양방향이다. 너무 많이 바꾼 쪽(변경률 50%, 보호 토큰 유실)만
 * 막으면 아무것도 안 고친 윤문이 그대로 통과한다 — 원문을 그대로 돌려줘도
 * 변경률 0%에 유실 0건이라 경고 하나로 끝났다. 그래서 못 줄인 쪽(S1 제거율 0)과
 * 새로 심은 쪽(S1 신규 유입)도 같은 무게로 막는다.
 */
import { changeRate } from './change-rate.js';
import {
  countByRule,
  missingProtectedTokens,
  reportRegisterStats,
  structureStats,
} from './detectors.js';
import { parseRuleBook, ruleLabel, s1Ids, type Register, type RuleBook } from './rules.js';

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
  /** S1을 이만큼도 못 줄이면 경고. 한 건도 못 줄이면 제거율이 0 이하라 채택 금지다 */
  s1RemovalWarn: 0.5,
} as const;

export interface AxisResult {
  axis:
    | 'change-rate'
    | 'residual-s1'
    | 'preservation'
    | 'structure'
    | 'introduced'
    | 'report-register';
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
  /** 원문 대비 S1을 얼마나 걷어냈나. 원문에 S1이 없었으면 1 */
  s1Removal: number;
  s1Before: number;
  s1After: number;
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

interface ResidualResult {
  axis: AxisResult;
  residual: CheckReport['residualS1'];
  removal: number;
  beforeTotal: number;
  afterTotal: number;
}

/**
 * S1을 얼마나 걷어냈는지 본다.
 *
 * 잔존 건수만 보면 "5건 → 5건"과 "5건 → 1건"이 같은 경고로 끝난다. 앞은 윤문이
 * 아무 일도 안 한 것이고 뒤는 8할을 걷어낸 것이라, 같은 판정을 받을 수 없다.
 * 원문 건수를 기준선으로 두고 제거율로 가른다.
 */
function checkResidualS1(
  book: RuleBook,
  register: Register,
  before: string,
  after: string,
  prescanned?: ReadonlyMap<string, number>,
): ResidualResult {
  const targets = s1Ids(book, register);
  const beforeCounts = prescanned ?? countByRule(before, targets);
  const afterCounts = countByRule(after, targets);

  const rows = targets.map((ruleId) => ({
    ruleId,
    before: beforeCounts.get(ruleId) ?? 0,
    after: afterCounts.get(ruleId) ?? 0,
  }));
  const beforeTotal = rows.reduce((sum, row) => sum + row.before, 0);
  const afterTotal = rows.reduce((sum, row) => sum + row.after, 0);
  const residual = rows.filter((row) => row.after > 0);
  // 원문에 S1이 없었으면 줄일 것도 없다. 그 자리에 새로 심었다면 아래에서 걸린다
  const removal = beforeTotal === 0 ? 1 : (beforeTotal - afterTotal) / beforeTotal;

  const base = { residual, removal, beforeTotal, afterTotal };

  if (afterTotal === 0) {
    return { ...base, axis: { axis: 'residual-s1', verdict: 'pass', detail: 'S1 잔존 0건' } };
  }

  const evidence = residual.map(
    (row) => `${ruleLabel(book, row.ruleId)}: ${row.before} → ${row.after}`,
  );
  const scale = `S1 ${beforeTotal} → ${afterTotal}건`;

  if (beforeTotal === 0) {
    return {
      ...base,
      axis: {
        axis: 'residual-s1',
        verdict: 'abort',
        detail: `원문에 없던 S1이 ${afterTotal}건 생김 — 채택 금지`,
        evidence,
      },
    };
  }
  if (removal <= 0) {
    return {
      ...base,
      axis: {
        axis: 'residual-s1',
        verdict: 'abort',
        detail: `${scale}, 한 건도 못 줄임 — 채택 금지`,
        evidence,
      },
    };
  }
  if (removal < THRESHOLD.s1RemovalWarn) {
    return {
      ...base,
      axis: {
        axis: 'residual-s1',
        verdict: 'warn',
        detail: `${scale} (제거율 ${pct(removal)}) — 절반도 못 줄임`,
        evidence,
      },
    };
  }
  return {
    ...base,
    axis: {
      axis: 'residual-s1',
      verdict: 'warn',
      detail: `${scale} (제거율 ${pct(removal)}), ${residual.length}종 잔존`,
      evidence,
    },
  };
}

/**
 * 철칙 — AI 티는 빼기만 하고 넣지 않는다.
 *
 * 구조 이상의 한 항목으로 묻어두면 새 티를 심어도 경고에서 그친다. 심각도가
 * S1인 룰이 새로 들어왔으면 그건 윤문이 원문을 나쁘게 만든 것이라 채택하지 않는다.
 */
function checkIntroduced(
  book: RuleBook,
  register: Register,
  introduced: CheckReport['introduced'],
): AxisResult {
  if (introduced.length === 0) {
    return { axis: 'introduced', verdict: 'pass', detail: '새로 심은 AI-tell 없음' };
  }

  const evidence = introduced
    .slice(0, 5)
    .map((row) => `${ruleLabel(book, row.ruleId)} ${row.before} → ${row.after}`);
  const s1 = new Set(s1Ids(book, register));
  const s1Rows = introduced.filter((row) => s1.has(row.ruleId));

  if (s1Rows.length > 0) {
    return {
      axis: 'introduced',
      verdict: 'abort',
      detail: `S1 ${s1Rows.length}종을 새로 심음 — 채택 금지`,
      evidence,
    };
  }
  return {
    axis: 'introduced',
    verdict: 'warn',
    detail: `${introduced.length}종 신규 유입`,
    evidence,
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

function checkStructure(before: string, after: string): AxisResult {
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

function checkReportRegister(after: string): AxisResult {
  const { plainEndings, formalEndings } = reportRegisterStats(after);
  if (plainEndings > 0 && formalEndings > 0) {
    return {
      axis: 'report-register',
      verdict: 'warn',
      detail: '보고 본문에 평서체와 합니다체가 함께 있음',
      evidence: [`평서체 ${plainEndings}문장 / 합니다체 ${formalEndings}문장`],
    };
  }
  return {
    axis: 'report-register',
    verdict: 'pass',
    detail: '보고 본문 어미 일관',
  };
}

export interface PrescanReport {
  register: Register;
  /** 이 말투 기준 S1 총 건수 */
  s1Total: number;
  /** 룰 ID별 건수. runCheck 에 그대로 넘겨 기준선으로 쓴다 */
  s1ByRule: Map<string, number>;
  /** 걸리는 게 없으면 윤문할 이유도 없다 */
  worthHumanizing: boolean;
}

/**
 * 윤문 전에 원문을 훑는다.
 *
 * 두 가지를 한다. 첫째, S1이 0건이면 윤문 자체를 건너뛴다 — 고칠 게 없는 글에
 * 윤문을 돌리면 남는 건 과윤문뿐이다. 둘째, 여기서 센 건수가 윤문 뒤 제거율의
 * 기준선이 된다. 사후에 다시 세는 값이 아니라 들어가기 전에 확정한 값이라,
 * 판정 근거로 쓸 수 있다.
 */
export function prescan(text: string, options: RunCheckOptions = {}): PrescanReport {
  const register = options.register ?? 'doc';
  const book = options.book ?? parseRuleBook();
  const s1ByRule = countByRule(text, s1Ids(book, register));
  const s1Total = [...s1ByRule.values()].reduce((sum, n) => sum + n, 0);

  return { register, s1Total, s1ByRule, worthHumanizing: s1Total > 0 };
}

export interface RunCheckOptions {
  register?: Register;
  book?: RuleBook;
}

export interface RunCheckWithPrescan extends RunCheckOptions {
  /** prescan() 이 센 원문 기준선. 안 넘기면 여기서 다시 센다 */
  prescanned?: ReadonlyMap<string, number>;
}

export function runCheck(
  before: string,
  after: string,
  options: RunCheckWithPrescan = {},
): CheckReport {
  const register = options.register ?? 'doc';
  const book = options.book ?? parseRuleBook();

  const rate = changeRate(before, after);
  const rateNoMarkup = changeRate(before, after, { ignoreMarkup: true });

  const changeAxis = checkChangeRate(rate, rateNoMarkup);
  const s1 = checkResidualS1(book, register, before, after, options.prescanned);
  const preservationAxis = checkPreservation(before, after);
  const introduced = findIntroduced(before, after);
  const introducedAxis = checkIntroduced(book, register, introduced);
  const structureAxis = checkStructure(before, after);
  const reportAxis = register === 'report' ? [checkReportRegister(after)] : [];

  const axes = [
    changeAxis,
    s1.axis,
    preservationAxis,
    structureAxis,
    introducedAxis,
    ...reportAxis,
  ];
  const verdict = worst(axes.map((a) => a.verdict));

  return {
    register,
    verdict,
    exitCode: EXIT_CODE[verdict],
    changeRate: rate,
    changeRateNoMarkup: rateNoMarkup,
    s1Removal: s1.removal,
    s1Before: s1.beforeTotal,
    s1After: s1.afterTotal,
    axes,
    residualS1: s1.residual,
    introduced,
  };
}

/** 검사 결과가 지시하는 다음 행동 */
export type NextAction = 'accept' | 'accept-with-warning' | 'retry' | 'fallback';

export interface Decision {
  action: NextAction;
  message: string;
}

/** 윤문은 한 번만 다시 시킨다. 두 번째도 막히면 원문이 답이다 */
export const MAX_ATTEMPTS = 2;

/**
 * 검사 결과를 다음 행동으로 옮긴다.
 *
 * "exit 2면 채택하지 않는다"를 문서에만 적어두면 모델이 자기 결과를 스스로
 * 버려야 성립한다. 그건 지켜지지 않는다. 판정과 지시를 코드가 같이 낸다.
 * 실행하는 쪽은 따르기만 한다.
 *
 * 재시도가 소진되면 윤문본을 버리고 원문을 낸다. 윤문이 원문보다 나아졌다고
 * 증명하지 못했으니, 남는 선택지는 원문뿐이다.
 */
export function decide(report: CheckReport, attempt: number = 1): Decision {
  if (report.verdict === 'pass') {
    return { action: 'accept', message: '검사 통과. 윤문본을 채택한다.' };
  }
  if (report.verdict === 'warn') {
    const flagged = report.axes
      .filter((axis) => axis.verdict === 'warn')
      .map((axis) => axis.axis)
      .join(', ');
    return {
      action: 'accept-with-warning',
      message: `윤문본을 채택하되 걸린 측면을 요약에 적는다: ${flagged}`,
    };
  }

  const blocking = report.axes
    .filter((axis) => axis.verdict === 'abort')
    .map((axis) => axis.detail)
    .join(' / ');

  if (attempt < MAX_ATTEMPTS) {
    return {
      action: 'retry',
      message: `${blocking} — 윤문본을 버리고 원문에서 한 번 더 윤문한 뒤 --attempt ${attempt + 1} 로 다시 검사한다.`,
    };
  }
  return {
    action: 'fallback',
    message: `${blocking} — 재시도(${MAX_ATTEMPTS}회)를 소진했다. 윤문본을 버리고 원문을 그대로 낸다.`,
  };
}

export function formatReport(report: CheckReport, attempt: number = 1): string {
  const head = `검사 ${report.verdict.toUpperCase()} (exit ${report.exitCode}) / 말투 ${report.register} / 시도 ${attempt}`;
  const lines = [head, ''];

  for (const axis of report.axes) {
    const mark = axis.verdict === 'pass' ? 'OK' : axis.verdict === 'warn' ? '경고' : '중단';
    lines.push(`[${mark}] ${axis.axis} — ${axis.detail}`);
    for (const item of axis.evidence ?? []) {
      lines.push(`       ${item}`);
    }
  }

  const decision = decide(report, attempt);
  lines.push('', `[다음] ${decision.action} — ${decision.message}`);

  return lines.join('\n');
}
