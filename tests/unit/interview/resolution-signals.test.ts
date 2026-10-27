import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassthroughEngine } from '../../../src/interview/passthrough-engine.js';
import { InterviewEngine } from '../../../src/interview/engine.js';
import { InterviewSessionRepository } from '../../../src/interview/repository.js';
import { PassthroughSpecGenerator } from '../../../src/spec/passthrough-generator.js';
import { handleSpecPassthrough } from '../../../src/mcp/tools/spec-passthrough.js';
import { handleStatus } from '../../../src/mcp/tools/status.js';
import { EventStore } from '../../../src/events/store.js';
import { EventType } from '../../../src/events/types.js';
import { GestaltPrinciple } from '../../../src/core/types.js';
import { READINESS_RULE_VERSION } from '../../../src/core/constants.js';
import type { ProjectMemory, ResolutionSignals } from '../../../src/core/types.js';
import type { LLMAdapter, LLMResponse } from '../../../src/llm/types.js';

const LOW = {
  goalClarity: 0.9,
  constraintClarity: 0.3,
  successCriteria: 0.3,
  priorityClarity: 0.3,
  contextClarity: 0.3,
};
const READY = {
  goalClarity: 0.9,
  constraintClarity: 0.9,
  successCriteria: 0.9,
  priorityClarity: 0.9,
  contextClarity: 0.9,
};

describe('해상도 신호 기록', () => {
  let store: EventStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/resolution-signals-${randomUUID()}.db`;
    store = new EventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  it('passthrough 라운드에 호스트가 질문을 만든 원칙이 남는다', () => {
    const engine = new PassthroughEngine(store);
    const start = engine.start('topic');
    if (!start.ok) throw start.error;
    const sessionId = start.value.session.sessionId;
    const expected = [start.value.gestaltContext.currentPrinciple];

    for (let i = 0; i < 3; i++) {
      const r = engine.respond(sessionId, `답 ${i}`, `질문 ${i}`, LOW);
      if (!r.ok) throw r.error;
      expected.push(r.value.gestaltContext.currentPrinciple);
    }

    const focuses = engine.getSession(sessionId).rounds.map((r) => r.gestaltFocus);
    expect(focuses).toEqual(expected.slice(0, 3));
    // 목표만 높고 나머지가 낮으면 두 번째 라운드부터 closure가 아닌 원칙을 고른다
    expect(focuses[1]).not.toBe(GestaltPrinciple.CLOSURE);
  });

  it('채점 이벤트 payload에 신호가 남고 이벤트로 다시 만든 세션에도 실린다', () => {
    const engine = new PassthroughEngine(store);
    const start = engine.start('topic');
    if (!start.ok) throw start.error;
    const sessionId = start.value.session.sessionId;
    engine.respond(sessionId, '카드 결제만 지원해요', '결제 수단은?', LOW);
    engine.respond(sessionId, '알아서 해주세요', '환불 정책은?');
    const scored = engine.score(sessionId, READY);
    if (!scored.ok) throw scored.error;

    const signals = scored.value.resolutionScore!.signals!;
    expect(signals.answeredRounds).toBe(2);
    expect(signals.deferredRounds).toBe(1);
    expect(signals.overallJump).not.toBeNull();

    const events = store
      .replay('interview', sessionId)
      .filter((e) => e.eventType === EventType.INTERVIEW_RESOLUTION_SCORED);
    const last = events[events.length - 1]!.payload as {
      signals: ResolutionSignals;
      readinessRuleVersion: number;
    };
    expect(last.signals).toEqual(signals);
    expect(last.readinessRuleVersion).toBe(READINESS_RULE_VERSION);

    const replayed = new InterviewSessionRepository(store).reconstruct(sessionId)!;
    expect(replayed.resolutionScore!.signals).toEqual(signals);
  });

  it('ges_status 인터뷰 요약에 신호 한 줄이 붙는다', async () => {
    const reply = JSON.stringify({
      question: '다음 질문?',
      goalClarity: 0.9,
      constraintClarity: 0.9,
      successCriteria: 0.9,
      priorityClarity: 0.9,
      contextClarity: 0.9,
      contradictions: [],
    });
    const llm: LLMAdapter = {
      chat: async (): Promise<LLMResponse> => ({
        content: reply,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    const engine = new InterviewEngine(llm, store);
    const start = await engine.start('topic');
    if (!start.ok) throw start.error;
    const sessionId = start.value.session.sessionId;
    const responded = await engine.respond(sessionId, '나중에요');
    if (!responded.ok) throw responded.error;

    const status = JSON.parse(handleStatus(engine, { sessionId }, store));
    expect(status.summary).toContain('신호: 답변 1/2, 위임 답변 1');
    expect(status.session.signalSummary).toContain('답변 1/2');
    expect(status.session.resolutionScore.signals.deferredRounds).toBe(1);
  });

  describe('specHistory 기록', () => {
    let cwd: string;
    let originalCwd: string;

    beforeEach(() => {
      originalCwd = process.cwd();
      cwd = resolve(`.gestalt-test/resolution-signals-cwd-${randomUUID()}`);
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, 'package.json'), '{}');
    });

    afterEach(() => {
      process.chdir(originalCwd);
      rmSync(cwd, { recursive: true, force: true });
    });

    it('인터뷰로 만든 스펙은 해상도 점수와 신호를, 텍스트 스펙은 null 점수를 남긴다', () => {
      const engine = new PassthroughEngine(store);
      const generator = new PassthroughSpecGenerator(store);
      const start = engine.start('topic', cwd);
      if (!start.ok) throw start.error;
      const sessionId = start.value.session.sessionId;
      engine.respond(sessionId, '카드 결제만 지원해요', '결제 수단은?', READY);
      engine.complete(sessionId);
      const signals = engine.getSession(sessionId).resolutionScore!.signals!;

      const spec = {
        goal: 'g',
        constraints: ['c'],
        acceptanceCriteria: ['a'],
        ontologySchema: { entities: [], relations: [] },
        gestaltAnalysis: [],
      };

      process.chdir(cwd);
      const interviewRes = JSON.parse(
        handleSpecPassthrough(engine, generator, { sessionId, spec, force: false }),
      );
      expect(interviewRes.error).toBeUndefined();
      const textRes = JSON.parse(
        handleSpecPassthrough(engine, generator, { text: 'plain text', spec, force: false }),
      );
      expect(textRes.error).toBeUndefined();

      const memory = JSON.parse(
        readFileSync(join(cwd, '.gestalt', 'memory.json'), 'utf-8'),
      ) as ProjectMemory;
      const fromInterview = memory.specHistory.find((s) => s.sourceType === 'interview')!;
      expect(fromInterview.resolutionScore).toBeCloseTo(0.9);
      expect(fromInterview.resolutionSignals).toEqual(signals);
      expect(fromInterview.readinessRuleVersion).toBe(READINESS_RULE_VERSION);
      const fromText = memory.specHistory.find((s) => s.sourceType === 'text')!;
      expect(fromText.resolutionScore).toBeNull();
      expect(fromText.resolutionSignals).toBeUndefined();
      expect(fromText.readinessRuleVersion).toBeUndefined();
    });
  });
});
