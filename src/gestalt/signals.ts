import type {
  InterviewSession,
  ResolutionDimensionName,
  ResolutionScore,
  ResolutionSignals,
} from '../core/types.js';

/** 이보다 긴 답은 위임 패턴이 들어 있어도 세지 않는다. 긴 답 속 "나중에"까지 세면 잘못 세는 경우가 많아진다 */
export const DEFERRED_ANSWER_MAX_LENGTH = 40;

/** 사용자가 결정을 넘긴 답. 답 전체가 짧을 때만 본다 */
export const DEFERRED_ANSWER_PATTERNS: readonly RegExp[] = [
  /알아서/,
  /모르겠/,
  /몰라/,
  /나중에/,
  /상관\s*없/,
  /아무거나/,
  /아무렇게나/,
  /편한\s*대로/,
  /맡길게|맡겨/,
  /미정/,
  /글쎄/,
  /up to you/i,
  /your call/i,
  /you decide/i,
  /don'?t know/i,
  /not sure/i,
  /no idea/i,
  /whatever/i,
  /doesn'?t matter/i,
  /\blater\b/i,
  /\btbd\b/i,
];

/** 이 점수 이상인 차원을 "자신 있게 매긴 차원"으로 본다 */
export const CONFIDENT_DIMENSION_CLARITY = 0.8;

const DIMENSION_NAMES: readonly ResolutionDimensionName[] = [
  'goalClarity',
  'constraintClarity',
  'successCriteria',
  'priorityClarity',
  'contextClarity',
];

export function isResolutionDimensionName(name: string): name is ResolutionDimensionName {
  return (DIMENSION_NAMES as readonly string[]).includes(name);
}

export function isDeferredAnswer(response: string): boolean {
  const trimmed = response.trim();
  if (trimmed === '' || trimmed.length > DEFERRED_ANSWER_MAX_LENGTH) return false;
  return DEFERRED_ANSWER_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * 채점 하나에 붙는 신호를 세션 상태로 센다. LLM에게 묻지 않는다.
 *
 * @param session 채점 직전 세션. 라운드와 질문 주제를 읽는다
 * @param score 지금 들어온 채점
 * @param prevScore 직전 채점. 첫 채점이면 null
 */
export function computeSignals(
  session: InterviewSession,
  score: ResolutionScore,
  prevScore: ResolutionScore | null,
): ResolutionSignals {
  let answeredRounds = 0;
  let emptyRounds = 0;
  let deferredRounds = 0;
  // 답을 기다리는 마지막 라운드(userResponse === null)는 빈 답으로 세지 않는다
  for (const round of session.rounds) {
    if (round.userResponse === null) continue;
    if (round.userResponse.trim() === '') {
      emptyRounds++;
      continue;
    }
    answeredRounds++;
    if (isDeferredAnswer(round.userResponse)) deferredRounds++;
  }

  const askedPrinciples = new Set(session.rounds.map((r) => r.gestaltFocus));
  const unaskedConfidentDimensions = score.dimensions
    .filter((d) => d.clarity >= CONFIDENT_DIMENSION_CLARITY)
    .filter((d) => !askedPrinciples.has(d.gestaltPrinciple))
    .map((d) => d.name)
    .filter(isResolutionDimensionName);

  const overallJump = prevScore ? round4(score.overall - prevScore.overall) : null;
  const prevMax = prevScore?.signals?.maxOverallJump ?? null;
  const maxOverallJump =
    overallJump === null
      ? prevMax
      : prevMax === null
        ? overallJump
        : Math.max(prevMax, overallJump);

  return {
    answeredRounds,
    emptyRounds,
    deferredRounds,
    unaskedConfidentDimensions,
    overallJump,
    maxOverallJump,
    llmDerived: { contradictions: score.contradictions?.length ?? 0 },
  };
}

const DIMENSION_SHORT_LABELS: Record<ResolutionDimensionName, string> = {
  goalClarity: '목표',
  constraintClarity: '제약',
  successCriteria: '성공 기준',
  priorityClarity: '우선순위',
  contextClarity: '맥락',
};

/** ges_status에 붙는 신호 한 줄. 예: `답변 6/7, 위임 답변 1, 안 물은 차원: 우선순위` */
export function formatSignalLine(signals: ResolutionSignals, totalRounds: number): string {
  const parts = [`답변 ${signals.answeredRounds}/${totalRounds}`];
  if (signals.emptyRounds > 0) parts.push(`빈 답변 ${signals.emptyRounds}`);
  parts.push(`위임 답변 ${signals.deferredRounds}`);
  const unasked = signals.unaskedConfidentDimensions.map((d) => DIMENSION_SHORT_LABELS[d]);
  parts.push(`안 물은 차원: ${unasked.length > 0 ? unasked.join(', ') : '없음'}`);
  return parts.join(', ');
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
