/**
 * 윤문 결과를 코드가 판단하는 검사.
 *
 * 모델이 스스로 매긴 변경률·등급은 참고값이다. 문자 기반 변경률 하나로는
 * 구조 편집이 안 보인다 — 변경률 2.8%인데 문장 3할이 갈려나간 사례가 있다.
 * 그래서 변경률, 잔존, 보존, 구조, 유입 다섯 측면에서 각각 측정하고, 판단한다.
 *
 * 채택 금지(abort)는 양방향이다. 너무 많이 바꾼 쪽(변경률 50%, 보호 토큰 유실)만
 * 막으면 아무것도 안 고친 윤문이 그대로 통과한다 — 원문을 그대로 돌려줘도
 * 변경률 0%에 유실 0건이라 경고 하나로 끝났다. 그래서 못 줄인 쪽과 새로 심은 쪽도
 * 막는다. 다만 두 쪽의 조건이 다르다. 신규 유입은 그 말투의 S1이 새로 생겼을 때
 * 채택 금지이고 S2 이하는 경고다. 제거율 0은 텍스트까지 그대로일 때만 채택 금지다.
 *
 * 각 축은 자기가 아는 것만 말한다. 잔존 축이 세는 건 탐지기가 있는 룰뿐이라, 그 밖에서
 * 무엇을 고쳤는지는 판정하지 않고 사람에게 넘긴다. 못 보는 자리를 봤다고 하지 않는다.
 */
import { changeRate } from './change-rate.js';
import {
  countByRule,
  missingProtectedTokens,
  reportRegisterStats,
  structureStats,
} from './detectors.js';
import {
  parseRuleBook,
  ruleLabel,
  s1Ids,
  type Register,
  type RuleBook,
  type RuleScanOptions,
} from './rules.js';
import { scan } from './scan.js';

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
  /** S1을 이만큼도 못 줄이면 경고. 한 건도 못 줄인 쪽은 아래 idleChange 와 함께 본다 */
  s1RemovalWarn: 0.5,
  /**
   * 손을 대긴 했다고 볼 최소 변경률.
   *
   * 제거율만 보면 탐지기가 가리는 룰만 세게 된다. 탐지기 없는 S1(doc 기준 일곱 개)만
   * 제대로 고친 윤문본은 제거율이 0이라 채택 금지로 떨어진다. 원문을 그대로 돌려준
   * 것과 같은 판정을 받는 셈인데, 그쪽은 변경률도 0이라 여기서 갈린다.
   *
   * 이 값으로 가르는 건 "윤문을 아예 안 했나"까지다. 문턱을 넘었다고 제대로 고쳤다는
   * 뜻은 아니다 — 그건 이 검사가 판정할 수 있는 범위 밖이라 경고로 넘긴다.
   */
  idleChange: 0.05,
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
 *
 * 세는 대상은 탐지기가 있는 룰뿐이다. 그래서 제거율 0이 곧 "아무것도 안 했다"는
 * 아니다 — 탐지기 없는 S1만 고친 윤문본도 여기서는 0으로 보인다.
 *
 * 그래서 제거율이 0일 때 이 축이 단정할 수 있는 건 하나뿐이다 — 텍스트까지 그대로면
 * 윤문을 안 한 것이다. 텍스트가 바뀌었으면 탐지기 밖에서 고쳤을 수 있으므로 경고로
 * 넘기고 사람이 본다.
 */
function checkResidualS1(
  book: RuleBook,
  register: Register,
  counts: { before: ReadonlyMap<string, number>; after: ReadonlyMap<string, number> },
  rate: number,
): ResidualResult {
  const targets = s1Ids(book, register);
  const beforeCounts = counts.before;
  const afterCounts = counts.after;

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

  // 원문에 없던 S1이 생긴 경우는 introduced 축이 판정한다. 여기서 함께 abort를 내면
  // 같은 사실을 두 축이 각자 판단하는 꼴이라, 한쪽이 회귀해도 다른 쪽이 가려서 안 잡힌다.
  if (beforeTotal === 0) {
    return {
      ...base,
      axis: {
        axis: 'residual-s1',
        verdict: 'warn',
        detail: `원문에 없던 S1이 ${afterTotal}건 생김 — 유입 측면을 본다`,
        evidence,
      },
    };
  }
  if (removal <= 0) {
    // 여기서 갈 수 있는 데까지만 간다. 텍스트가 사실상 그대로면 윤문을 안 한 것이라
    // 단정할 수 있다. 유의미하게 바뀌었으면 탐지기 밖에서 고쳤을 수도 있는데,
    // 이 검사는 그 자리를 못 본다 — 못 보는 걸 봤다고 하지 않는다.
    const idle = rate < THRESHOLD.idleChange;
    const grew = afterTotal > beforeTotal;
    return {
      ...base,
      axis: {
        axis: 'residual-s1',
        verdict: idle ? 'abort' : 'warn',
        detail: idle
          ? `${scale}, 한 건도 못 줄이고 텍스트도 그대로다 (변경률 ${pct(rate)}) — 채택 금지`
          : `${scale}, ${grew ? '탐지 가능한 룰이 오히려 늘었다' : '탐지 가능한 룰은 안 줄었다'} (변경률 ${pct(rate)}) — 탐지기 밖은 이 검사가 못 본다`,
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

/** 늘어난 룰을 추린다. 판정은 checkIntroduced가 한다 */
function findIntroduced(
  beforeCounts: ReadonlyMap<string, number>,
  afterCounts: ReadonlyMap<string, number>,
): CheckReport['introduced'] {
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
 * 윤문을 돌리면 남는 건 과윤문뿐이다. 둘째, 여기서 센 건수를 runCheck의 prescanned로
 * 넘기면 그 값이 제거율의 기준선이 된다.
 *
 * 비용은 문서 크기가 아니라 걸린 룰 종류 수에 비례한다. scan 을 거치며 라벨과 처방을
 * 조회하지만 그건 걸린 룰마다 한 번씩이라, 2.5KB 와 5MB 사이에서 오버헤드가 커지지 않는다.
 * 룰북이 수백 룰로 자라면 그때 다시 본다.
 *
 * 기준선이 실제로 의미를 가지려면 윤문 전에 불러 그 값을 들고 있어야 한다. 원문과
 * 윤문본을 한꺼번에 받는 자리(예: humanize-check CLI)에서는 검사 시점에 다시 세는
 * 것과 결과가 같다. 그 자리에서 이 함수는 편의일 뿐이다. 기준선이 갈릴 수 있는
 * 흐름은 윤문 파이프라인이 원문을 먼저 훑는 경우다.
 */
export function prescan(text: string, options: RuleScanOptions = {}): PrescanReport {
  // 세는 일은 scan 한 곳에만 둔다. 여기서 다시 세면 같은 집계가 두 벌이 된다.
  // 룰북 해석이 갈리는 날 어느 쪽이 맞는지 알 수 없게 된다.
  const report = scan(text, options);

  return {
    register: report.register,
    s1Total: report.s1Total,
    s1ByRule: new Map(report.hits.map((hit) => [hit.ruleId, hit.count])),
    worthHumanizing: report.worthHumanizing,
  };
}

/** @deprecated rules.ts 의 RuleScanOptions 를 쓴다. 이름이 runCheck 전용처럼 보인다 */
export type RunCheckOptions = RuleScanOptions;

export interface RunCheckWithPrescan extends RuleScanOptions {
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

  // 탐지기는 텍스트당 한 번만 돌린다. 잔존 축은 S1 부분집합을, 유입 축은 전체를 보는데
  // 룰 필터만 다른 같은 순회라, 따로 부르면 같은 문자열에 정규식이 두 번씩 돌아간다.
  //
  // 다만 이 절약은 detect 안에서만이다. 아래 checkStructure의 structureStats가
  // proseOnly를 다시 계산한다. report 말투면 reportRegisterStats가 한 번 더 한다.
  //
  // 안 건드리는 근거는 실측으로 확인했다. 그 중복이 차지하는 비중이 1KB에서 1MB까지
  // 어느 구간에서도 7퍼센트를 안 넘는다. changeRate가 지배한다는 말은 어절 6000개
  // 이하에서만 맞고 그 위로는 절반으로 준다. 다만 그 자리를 메우는 건 detect 본연의
  // 계산이지 이 중복이 아니라, 결론은 전 구간에서 같다.
  const beforeAll = countByRule(before);
  const afterAll = countByRule(after);
  // prescanned는 윤문에 들어가기 전에 확정한 기준선이라 지금 센 값보다 우선한다
  const counts = { before: options.prescanned ?? beforeAll, after: afterAll };

  // 유입 축도 잔존 축과 같은 기준선을 봐야 한다. 잔존 축이 prescanned 기준으로
  // "원문에 S1이 없었다"며 유입 축에 판정을 넘겼는데, 유입 축이 지금 센 원문을 보고
  // "안 늘었다"고 하면 두 축 사이로 빠져나가는 자리가 생긴다.
  const introducedBase = options.prescanned
    ? new Map([...beforeAll, ...options.prescanned])
    : beforeAll;

  const changeAxis = checkChangeRate(rate, rateNoMarkup);
  const s1 = checkResidualS1(book, register, counts, rate);
  const preservationAxis = checkPreservation(before, after);
  const introduced = findIntroduced(introducedBase, afterAll);
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
export function decide(
  report: CheckReport,
  attempt: number = 1,
  maxAttempts: number = MAX_ATTEMPTS,
): Decision {
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

  if (attempt < maxAttempts) {
    return {
      action: 'retry',
      message: `${blocking} — 윤문본을 버리고 원문에서 한 번 더 윤문한 뒤 --attempt ${attempt + 1}로 다시 검사한다.`,
    };
  }
  return {
    action: 'fallback',
    message: `${blocking} — 재시도(${maxAttempts}회)를 소진했다. 윤문본을 버리고 원문을 그대로 낸다.`,
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
