import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PassthroughEngine } from '../../../src/interview/passthrough-engine.js';
import { InterviewEngine } from '../../../src/interview/engine.js';
import { InterviewSessionRepository } from '../../../src/interview/repository.js';
import { handleInterviewPassthrough } from '../../../src/mcp/tools/interview-passthrough.js';
import { buildRescorePrompt } from '../../../src/llm/prompts.js';
import { loadConfig } from '../../../src/core/config.js';
import { READINESS_RULE_VERSION } from '../../../src/core/constants.js';
import { EventStore } from '../../../src/events/store.js';
import { EventType } from '../../../src/events/types.js';
import { GestaltPrinciple } from '../../../src/core/types.js';
import type { InterviewOptions } from '../../../src/interview/session.js';
import type { LLMAdapter, LLMRequest, LLMResponse } from '../../../src/llm/types.js';

function uniform(value: number) {
  return {
    goalClarity: value,
    constraintClarity: value,
    successCriteria: value,
    priorityClarity: value,
    contextClarity: value,
  };
}

const LOW = uniform(0.5);
const READY = uniform(0.9);
// overall 0.87이라 기준값을 넘는다. 프롬프트에 이 숫자가 새는지 보려고 흔치 않은 값을 쓴다
const READY_087 = uniform(0.87);

describe('다시 채점하기', () => {
  let store: EventStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/rescore-${randomUUID()}.db`;
    store = new EventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  function answered(options: InterviewOptions = {}) {
    const engine = new PassthroughEngine(store, undefined, options);
    const start = engine.start('결제 모듈');
    if (!start.ok) throw start.error;
    const sessionId = start.value.session.sessionId;
    const r = engine.respond(sessionId, '카드 결제만 지원해요', '결제 수단은?', LOW);
    if (!r.ok) throw r.error;
    return { engine, sessionId };
  }

  it('설정 기본값은 record다', () => {
    const config = loadConfig({}, { skipDotEnv: true, skipGestaltJson: true });
    expect(config.interview.rescore).toBe('record');
  });

  describe('record (기본)', () => {
    it('처음 기준값을 넘은 채점에만 rescorePrompt를 싣는다', () => {
      const { engine, sessionId } = answered();

      const below = engine.score(sessionId, LOW);
      if (!below.ok) throw below.error;
      expect(below.value.rescorePrompt).toBeUndefined();

      const first = engine.score(sessionId, READY_087);
      if (!first.ok) throw first.error;
      expect(first.value.nextAction).toBe('rescore');
      expect(first.value.rescorePrompt).toContain('카드 결제만 지원해요');

      const second = engine.score(sessionId, READY);
      if (!second.ok) throw second.error;
      expect(second.value.rescorePrompt).toBeUndefined();
      expect(second.value.nextAction).toBeUndefined();
    });

    it('respond로 넘어도 처음 한 번만 rescorePrompt를 싣는다', () => {
      const { engine, sessionId } = answered();
      const first = engine.respond(sessionId, '7일 이내 환불', '환불 정책은?', READY);
      if (!first.ok) throw first.error;
      expect(first.value.nextAction).toBe('rescore');
      // 같이 온 점수는 직전 응답의 scoringPrompt로 매긴 것이라 이번 답은 다시 채점에도 안 넣는다
      expect(first.value.rescorePrompt).toContain('카드 결제만 지원해요');
      expect(first.value.rescorePrompt).not.toContain('7일 이내 환불');

      const again = engine.respond(sessionId, '관리자 화면은 나중에', '우선순위는?', READY);
      if (!again.ok) throw again.error;
      expect(again.value.rescorePrompt).toBeUndefined();
    });

    it('respond가 주는 rescorePrompt는 직전 응답의 scoringPrompt와 같은 대화를 묻는다', () => {
      const engine = new PassthroughEngine(store);
      const start = engine.start('결제 모듈');
      if (!start.ok) throw start.error;
      const sessionId = start.value.session.sessionId;
      const prev = engine.respond(sessionId, '카드 결제만 지원해요', '결제 수단은?', LOW);
      if (!prev.ok) throw prev.error;

      const next = engine.respond(sessionId, '7일 이내 환불', '환불 정책은?', READY);
      if (!next.ok) throw next.error;
      expect(next.value.rescorePrompt).toBe(prev.value.gestaltContext.scoringPrompt);
    });

    it('rescorePrompt에는 대화 기록만 있고 앞 점수와 판정은 없다', () => {
      const { engine, sessionId } = answered();
      const first = engine.score(sessionId, READY_087);
      if (!first.ok) throw first.error;
      const prompt = first.value.rescorePrompt!;

      const session = engine.getSession(sessionId);
      expect(prompt).toBe(
        buildRescorePrompt(
          session.topic,
          session.rounds.map((r) => ({ question: r.question, response: r.userResponse })),
          session.projectType,
        ),
      );
      expect(prompt).toContain('결제 수단은?');
      expect(prompt).not.toContain('0.87');
      expect(prompt).not.toContain('0.50');
      expect(prompt).not.toMatch(/isReady|overall|threshold|명확성/);
    });

    it('다시 채점한 결과를 남기되 판정은 첫 점수를 따른다', () => {
      const { engine, sessionId } = answered();
      engine.score(sessionId, READY);

      const rescored = engine.score(sessionId, uniform(0.6), {
        rescore: true,
        rescoreMode: 'isolated',
      });
      if (!rescored.ok) throw rescored.error;
      const { resolutionScore, rescore } = rescored.value;
      expect(resolutionScore!.isReady).toBe(true);
      expect(resolutionScore!.overall).toBeCloseTo(0.9);
      expect(rescore).toEqual({
        mode: 'isolated',
        overall: expect.closeTo(0.6, 5),
        maxDimensionSpread: expect.closeTo(0.3, 5),
        droppedDimensions: [
          'goalClarity',
          'constraintClarity',
          'successCriteria',
          'priorityClarity',
          'contextClarity',
        ],
      });
      expect(resolutionScore!.signals!.rescore).toEqual(rescore);

      const replayed = new InterviewSessionRepository(store).reconstruct(sessionId)!;
      expect(replayed.resolutionScore!.signals!.rescore).toEqual(rescore);
      expect(replayed.resolutionScore!.isReady).toBe(true);
      expect(engine.complete(sessionId).ok).toBe(true);
    });

    it('넘었다가 떨어진 뒤 받은 다시 채점은 그 시점의 최신 점수와 비교한다', () => {
      const { engine, sessionId } = answered();
      engine.score(sessionId, READY);
      engine.score(sessionId, LOW);
      const rescored = engine.score(sessionId, READY, { rescore: true, rescoreMode: 'isolated' });
      if (!rescored.ok) throw rescored.error;
      // 넘었던 0.9가 아니라 지금 점수 0.5와 비교한 흔들림이다
      expect(rescored.value.rescore!.maxDimensionSpread).toBeCloseTo(0.4);
      expect(rescored.value.resolutionScore!.isReady).toBe(false);
    });

    it('rescoreMode를 안 넘기면 same-context로 남긴다', () => {
      const { engine, sessionId } = answered();
      engine.score(sessionId, READY);
      const rescored = engine.score(sessionId, READY, { rescore: true });
      if (!rescored.ok) throw rescored.error;
      expect(rescored.value.rescore!.mode).toBe('same-context');
    });

    it('다시 채점 결과는 이후 채점의 신호에도 이어진다', () => {
      const { engine, sessionId } = answered();
      engine.score(sessionId, READY);
      engine.score(sessionId, READY, { rescore: true, rescoreMode: 'isolated' });

      const later = engine.respond(sessionId, '관리자 화면은 나중에', '우선순위는?', READY);
      if (!later.ok) throw later.error;
      expect(later.value.resolutionScore!.signals!.rescore?.mode).toBe('isolated');
    });

    it('기준값을 넘기 전이나 이미 다시 채점한 뒤에는 rescore를 받지 않는다', () => {
      const { engine, sessionId } = answered();
      const early = engine.score(sessionId, READY, { rescore: true });
      expect(early.ok).toBe(false);

      engine.score(sessionId, READY);
      expect(engine.score(sessionId, READY, { rescore: true }).ok).toBe(true);
      const twice = engine.score(sessionId, READY, { rescore: true });
      expect(twice.ok).toBe(false);
      if (!twice.ok) expect(twice.error.message).toContain('한 번만');
    });

    it('다시 채점 이벤트가 따로 남는다', () => {
      const { engine, sessionId } = answered();
      engine.score(sessionId, READY);
      engine.score(sessionId, READY, { rescore: true, rescoreMode: 'isolated' });
      const rescored = store
        .replay('interview', sessionId)
        .filter((e) => e.eventType === EventType.INTERVIEW_RESOLUTION_RESCORED);
      expect(rescored).toHaveLength(1);
      expect(rescored[0]!.payload['isReady']).toBe(true);
      expect(rescored[0]!.payload['readinessRuleVersion']).toBe(READINESS_RULE_VERSION);
    });
  });

  describe('gate', () => {
    const gate: InterviewOptions = { rescore: 'gate' };

    it('다시 채점을 받기 전에는 기준값을 넘어도 끝낼 수 없다', () => {
      const { engine, sessionId } = answered(gate);
      const first = engine.score(sessionId, READY);
      if (!first.ok) throw first.error;
      expect(first.value.resolutionScore!.isReady).toBe(false);
      expect(first.value.nextAction).toBe('rescore');
      expect(engine.complete(sessionId).ok).toBe(false);

      // 받기 전까지는 넘을 때마다 다시 요청한다
      const again = engine.score(sessionId, READY);
      if (!again.ok) throw again.error;
      expect(again.value.nextAction).toBe('rescore');
    });

    it('두 overall 중 낮은 쪽으로 판정한다', () => {
      const { engine, sessionId } = answered(gate);
      engine.score(sessionId, READY);
      const rescored = engine.score(sessionId, uniform(0.75), {
        rescore: true,
        rescoreMode: 'isolated',
      });
      if (!rescored.ok) throw rescored.error;
      expect(rescored.value.rescore!.maxDimensionSpread).toBeCloseTo(0.15);
      expect(rescored.value.resolutionScore!.isReady).toBe(false);
    });

    it('두 점수가 다 넘고 흔들림이 작으면 끝낼 수 있다', () => {
      const { engine, sessionId } = answered(gate);
      engine.score(sessionId, READY);
      const rescored = engine.score(sessionId, uniform(0.85), {
        rescore: true,
        rescoreMode: 'isolated',
      });
      if (!rescored.ok) throw rescored.error;
      expect(rescored.value.resolutionScore!.isReady).toBe(true);
      expect(engine.complete(sessionId).ok).toBe(true);
    });

    it('흔들림이 0.2를 넘으면 isReady를 false로 두고 가장 흔들린 차원을 다음에 묻는다', () => {
      const { engine, sessionId } = answered(gate);
      engine.score(sessionId, READY);
      const rescored = engine.score(
        sessionId,
        { ...uniform(0.95), priorityClarity: 0.65 },
        { rescore: true, rescoreMode: 'isolated' },
      );
      if (!rescored.ok) throw rescored.error;
      const { resolutionScore, rescore, gestaltContext } = rescored.value;
      expect(Math.min(resolutionScore!.overall, rescore!.overall)).toBeGreaterThanOrEqual(0.8);
      expect(rescore!.maxDimensionSpread).toBeCloseTo(0.25);
      expect(resolutionScore!.isReady).toBe(false);
      expect(gestaltContext!.currentPrinciple).toBe(GestaltPrinciple.FIGURE_GROUND);

      // 다음 라운드는 그 원칙으로 기록된다
      const next = engine.respond(sessionId, 'MVP는 카드 결제', gestaltContext!.questionPrompt);
      if (!next.ok) throw next.error;
      const rounds = engine.getSession(sessionId).rounds;
      expect(rounds[rounds.length - 1]!.gestaltFocus).toBe(GestaltPrinciple.FIGURE_GROUND);
    });

    it('흔들림으로 보류된 뒤 다시 넘은 채점은 첫 점수 규칙으로 판정한다', () => {
      const { engine, sessionId } = answered(gate);
      engine.score(sessionId, READY);
      const held = engine.score(
        sessionId,
        { ...uniform(0.95), priorityClarity: 0.65 },
        { rescore: true, rescoreMode: 'isolated' },
      );
      if (!held.ok) throw held.error;
      expect(held.value.resolutionScore!.isReady).toBe(false);

      // 다시 채점은 인터뷰마다 한 번이라 이번에는 요청하지 않는다
      const next = engine.respond(
        sessionId,
        'MVP는 카드 결제',
        held.value.gestaltContext!.questionPrompt,
        READY,
      );
      if (!next.ok) throw next.error;
      expect(next.value.resolutionScore!.isReady).toBe(true);
      expect(next.value.nextAction).toBeUndefined();
      expect(engine.complete(sessionId).ok).toBe(true);
    });
  });

  describe('off', () => {
    it('rescorePrompt를 싣지 않고 rescore도 받지 않는다', () => {
      const { engine, sessionId } = answered({ rescore: 'off' });
      const first = engine.score(sessionId, READY);
      if (!first.ok) throw first.error;
      expect(first.value.rescorePrompt).toBeUndefined();
      expect(first.value.resolutionScore!.isReady).toBe(true);
      expect(engine.score(sessionId, READY, { rescore: true }).ok).toBe(false);
    });
  });

  describe('MCP 응답', () => {
    it('처음 넘은 채점 응답에 nextAction과 안내 문구가 붙는다', async () => {
      const { engine, sessionId } = answered();
      const res = JSON.parse(
        await handleInterviewPassthrough(engine, {
          action: 'score',
          sessionId,
          resolutionScore: READY,
          force: false,
        }),
      );
      expect(res.nextAction).toBe('rescore');
      expect(res.rescorePrompt).toContain('카드 결제만 지원해요');
      expect(res.message).toContain('rescore');

      const rescored = JSON.parse(
        await handleInterviewPassthrough(engine, {
          action: 'score',
          sessionId,
          resolutionScore: READY,
          rescore: true,
          rescoreMode: 'isolated',
          force: false,
        }),
      );
      expect(rescored.error).toBeUndefined();
      expect(rescored.rescore.mode).toBe('isolated');
      expect(rescored.nextAction).toBeUndefined();
    });
  });

  describe('API 키 경로', () => {
    function scoringLlm(values: number[]): {
      llm: LLMAdapter;
      calls: () => number;
      requests: LLMRequest[];
    } {
      let i = 0;
      const requests: LLMRequest[] = [];
      const llm: LLMAdapter = {
        chat: async (req: LLMRequest): Promise<LLMResponse> => {
          requests.push(req);
          const v = values[Math.min(i, values.length - 1)]!;
          i++;
          return {
            content: JSON.stringify({ question: '다음 질문?', ...uniform(v), contradictions: [] }),
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      };
      return { llm, calls: () => i, requests };
    }

    it('처음 기준값을 넘으면 같은 모델로 한 번 더 채점해 isolated로 남긴다', async () => {
      // 시작 질문, 채점, 다시 채점, 다음 질문
      const { llm, calls } = scoringLlm([0.9, 0.9, 0.7, 0.9]);
      const engine = new InterviewEngine(llm, store);
      const start = await engine.start('결제 모듈');
      if (!start.ok) throw start.error;
      const sessionId = start.value.session.sessionId;

      const responded = await engine.respond(sessionId, '카드 결제만 지원해요');
      if (!responded.ok) throw responded.error;
      expect(calls()).toBe(4);
      const { signals, isReady } = responded.value.resolutionScore;
      expect(signals!.rescore!.mode).toBe('isolated');
      expect(signals!.rescore!.overall).toBeCloseTo(0.7);
      expect(isReady).toBe(true);

      // 두 번째로 넘을 때는 다시 부르지 않는다
      const again = await engine.respond(sessionId, '7일 이내 환불');
      if (!again.ok) throw again.error;
      expect(calls()).toBe(6);
    });

    it('다시 채점 호출은 첫 채점과 같은 요청이라 앞 점수를 담지 않는다', async () => {
      // 시작 질문, 채점, 다시 채점, 다음 질문
      const { llm, requests } = scoringLlm([0.9, 0.9, 0.7, 0.9]);
      const engine = new InterviewEngine(llm, store);
      const start = await engine.start('결제 모듈');
      if (!start.ok) throw start.error;
      const responded = await engine.respond(start.value.session.sessionId, '카드 결제만 지원해요');
      if (!responded.ok) throw responded.error;

      const [, scoring, rescoring] = requests;
      expect(rescoring).toEqual(scoring);
      expect(rescoring!.messages).toHaveLength(1);
      expect(rescoring!.messages[0]!.content).toContain('카드 결제만 지원해요');
      expect(rescoring!.messages[0]!.content).not.toContain('0.9');
    });

    it('gate에서 다시 채점이 낮으면 판정을 미룬다', async () => {
      const { llm } = scoringLlm([0.9, 0.9, 0.7, 0.9]);
      const engine = new InterviewEngine(llm, store, undefined, { rescore: 'gate' });
      const start = await engine.start('결제 모듈');
      if (!start.ok) throw start.error;
      const responded = await engine.respond(start.value.session.sessionId, '카드만');
      if (!responded.ok) throw responded.error;
      expect(responded.value.resolutionScore.isReady).toBe(false);
    });

    it('gate에서 다시 채점이 실패하면 판정은 미룬 채 이어가고 다음에 넘을 때 다시 부른다', async () => {
      // 시작 질문, 채점, 다시 채점(실패), 다음 질문, 채점, 다시 채점, 다음 질문
      const { llm: base, calls } = scoringLlm([0.9]);
      let n = 0;
      const llm: LLMAdapter = {
        chat: async (req) => {
          if (++n === 3) throw new Error('rate limited');
          return base.chat(req);
        },
      };
      const engine = new InterviewEngine(llm, store, undefined, { rescore: 'gate' });
      const start = await engine.start('결제 모듈');
      if (!start.ok) throw start.error;
      const sessionId = start.value.session.sessionId;

      const failed = await engine.respond(sessionId, '카드만');
      if (!failed.ok) throw failed.error;
      expect(failed.value.resolutionScore.isReady).toBe(false);
      expect(failed.value.nextQuestion).toBe('다음 질문?');
      const events = store.replay('interview', sessionId);
      const failure = events.find(
        (e) => e.eventType === EventType.INTERVIEW_RESOLUTION_RESCORE_FAILED,
      );
      expect(failure!.payload).toEqual({ error: 'rate limited' });

      const retried = await engine.respond(sessionId, '7일 이내 환불');
      if (!retried.ok) throw retried.error;
      expect(n).toBe(7);
      expect(calls()).toBe(6);
      expect(retried.value.resolutionScore.signals!.rescore!.mode).toBe('isolated');
      expect(retried.value.resolutionScore.isReady).toBe(true);
    });
  });
});
