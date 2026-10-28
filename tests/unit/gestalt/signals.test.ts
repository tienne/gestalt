import { describe, it, expect } from 'vitest';
import {
  computeSignals,
  formatSignalLine,
  isDeferredAnswer,
  DEFERRED_ANSWER_MAX_LENGTH,
} from '../../../src/gestalt/signals.js';
import { computeResolutionScore } from '../../../src/gestalt/analyzer.js';
import { GestaltPrinciple } from '../../../src/core/types.js';
import type { InterviewRound, InterviewSession, ResolutionScore } from '../../../src/core/types.js';

function round(
  roundNumber: number,
  userResponse: string | null,
  gestaltFocus: GestaltPrinciple = GestaltPrinciple.CLOSURE,
): InterviewRound {
  return {
    roundNumber,
    question: `q${roundNumber}`,
    userResponse,
    gestaltFocus,
    timestamp: new Date().toISOString(),
  };
}

function session(rounds: InterviewRound[]): InterviewSession {
  return {
    sessionId: 's',
    topic: 't',
    status: 'in_progress',
    projectType: 'greenfield',
    rounds,
    resolutionScore: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function score(clarity: Partial<Record<string, number>>, contradictions: string[] = []) {
  return computeResolutionScore(
    {
      goalClarity: clarity['goalClarity'] ?? 0.5,
      constraintClarity: clarity['constraintClarity'] ?? 0.5,
      successCriteria: clarity['successCriteria'] ?? 0.5,
      priorityClarity: clarity['priorityClarity'] ?? 0.5,
      contradictions,
    },
    'greenfield',
  );
}

describe('isDeferredAnswer', () => {
  it('짧은 위임 답을 센다', () => {
    expect(isDeferredAnswer('알아서 해주세요')).toBe(true);
    expect(isDeferredAnswer('잘 모르겠어요')).toBe(true);
    expect(isDeferredAnswer('나중에 정할게요')).toBe(true);
    expect(isDeferredAnswer('Up to you')).toBe(true);
    expect(isDeferredAnswer("I don't know")).toBe(true);
  });

  it('긴 답 안에 위임 표현이 들어 있으면 세지 않는다', () => {
    const long =
      '결제는 카드와 계좌이체를 지원하고 환불 정책은 7일 이내 전액 환불로 하되 부분 환불은 나중에 붙일게요';
    expect(long.length).toBeGreaterThan(DEFERRED_ANSWER_MAX_LENGTH);
    expect(isDeferredAnswer(long)).toBe(false);
  });

  it('구체적인 짧은 답은 세지 않는다', () => {
    expect(isDeferredAnswer('카드 결제만 지원')).toBe(false);
    expect(isDeferredAnswer('')).toBe(false);
  });
});

describe('computeSignals', () => {
  it('빈 답과 위임 답을 따로 세고 답을 기다리는 라운드는 세지 않는다', () => {
    const s = session([
      round(1, '카드 결제만 지원해요'),
      round(2, '   '),
      round(3, '알아서 해주세요'),
      round(4, null),
    ]);
    const signals = computeSignals(s, score({}), null);
    expect(signals.answeredRounds).toBe(2);
    expect(signals.emptyRounds).toBe(1);
    expect(signals.deferredRounds).toBe(1);
  });

  it('긴 답에 섞인 위임 표현은 위임 답으로 세지 않는다', () => {
    const s = session([
      round(1, '결제는 카드와 계좌이체를 지원하고 환불은 7일 이내 전액 환불, 부분 환불은 나중에'),
    ]);
    expect(computeSignals(s, score({}), null).deferredRounds).toBe(0);
  });

  it('0.8 이상인데 그 원칙으로 묻지 않은 차원을 고른다', () => {
    const s = session([
      round(1, '목표는 결제', GestaltPrinciple.CLOSURE),
      round(2, '카드만', GestaltPrinciple.PROXIMITY),
    ]);
    const signals = computeSignals(
      s,
      score({
        goalClarity: 0.9,
        constraintClarity: 0.85,
        priorityClarity: 0.9,
        successCriteria: 0.7,
      }),
      null,
    );
    // 우선순위(figure-ground)는 묻지 않았는데 0.9, 성공 기준은 묻지 않았지만 0.7이라 빠진다
    expect(signals.unaskedConfidentDimensions).toEqual(['priorityClarity']);
  });

  it('첫 채점의 overallJump와 maxOverallJump는 null이다', () => {
    const signals = computeSignals(session([round(1, 'a')]), score({}), null);
    expect(signals.overallJump).toBeNull();
    expect(signals.maxOverallJump).toBeNull();
  });

  it('직전 채점과의 차이와 세션 최대 상승 폭을 남긴다', () => {
    const s = session([round(1, 'a'), round(2, 'b')]);
    const first = score({});
    first.signals = computeSignals(s, first, null);

    const second = score({
      goalClarity: 0.9,
      constraintClarity: 0.9,
      successCriteria: 0.9,
      priorityClarity: 0.9,
    });
    second.signals = computeSignals(s, second, first);
    expect(second.signals.overallJump).toBeCloseTo(0.4);
    expect(second.signals.maxOverallJump).toBeCloseTo(0.4);

    const third = score({
      goalClarity: 0.85,
      constraintClarity: 0.85,
      successCriteria: 0.85,
      priorityClarity: 0.85,
    });
    third.signals = computeSignals(s, third, second);
    expect(third.signals.overallJump).toBeCloseTo(-0.05);
    expect(third.signals.maxOverallJump).toBeCloseTo(0.4);
  });

  it('모순 수는 llmDerived로 따로 둔다', () => {
    const signals = computeSignals(session([round(1, 'a')]), score({}, ['x', 'y']), null);
    expect(signals.llmDerived).toEqual({ contradictions: 2 });
  });
});

describe('formatSignalLine', () => {
  it('답변 수와 위임 답변, 안 물은 차원을 한 줄로 쓴다', () => {
    const line = formatSignalLine(
      {
        answeredRounds: 6,
        emptyRounds: 0,
        deferredRounds: 1,
        unaskedConfidentDimensions: ['priorityClarity'],
        overallJump: 0.1,
        maxOverallJump: 0.2,
        llmDerived: { contradictions: 0 },
      },
      7,
    );
    expect(line).toBe('답변 6/7, 위임 답변 1, 안 물은 차원: 우선순위');
  });

  it('빈 답이 있으면 적고 안 물은 차원이 없으면 없음으로 쓴다', () => {
    const line = formatSignalLine(
      {
        answeredRounds: 2,
        emptyRounds: 1,
        deferredRounds: 0,
        unaskedConfidentDimensions: [],
        overallJump: null,
        maxOverallJump: null,
        llmDerived: { contradictions: 0 },
      },
      3,
    );
    expect(line).toBe('답변 2/3, 빈 답변 1, 위임 답변 0, 안 물은 차원: 없음');
  });
});

// 판정은 신호와 무관하다
describe('신호는 판정을 바꾸지 않는다', () => {
  it('isReady는 overall과 기준값만으로 정해진다', () => {
    const s = session([round(1, '알아서')]);
    const ready: ResolutionScore = score({
      goalClarity: 0.9,
      constraintClarity: 0.9,
      successCriteria: 0.9,
      priorityClarity: 0.9,
    });
    const before = ready.isReady;
    ready.signals = computeSignals(s, ready, null);
    expect(ready.signals.deferredRounds).toBe(1);
    expect(ready.isReady).toBe(before);
    expect(ready.isReady).toBe(true);
  });
});
