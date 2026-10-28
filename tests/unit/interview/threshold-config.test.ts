import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PassthroughEngine } from '../../../src/interview/passthrough-engine.js';
import { InterviewSessionRepository } from '../../../src/interview/repository.js';
import { PassthroughSpecGenerator } from '../../../src/spec/passthrough-generator.js';
import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { checkTermination } from '../../../src/execute/termination-detector.js';
import { computeResolutionScore } from '../../../src/gestalt/analyzer.js';
import { belowThresholdPrompt } from '../../../src/cli/commands/interview.js';
import { loadConfig } from '../../../src/core/config.js';
import { EventStore } from '../../../src/events/store.js';
import { EventType } from '../../../src/events/types.js';
import { RESOLUTION_THRESHOLD } from '../../../src/core/constants.js';

const SCORE_075 = {
  goalClarity: 0.75,
  constraintClarity: 0.75,
  successCriteria: 0.75,
  priorityClarity: 0.75,
  contextClarity: 0.75,
};

const SPEC = {
  goal: 'g',
  constraints: ['c'],
  acceptanceCriteria: ['a'],
  ontologySchema: { entities: [], relations: [] },
  gestaltAnalysis: [],
};

describe('해상도 기준값 설정 연결', () => {
  let store: EventStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/threshold-config-${randomUUID()}.db`;
    store = new EventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  function answeredSession(engine: PassthroughEngine): string {
    const start = engine.start('threshold');
    if (!start.ok) throw start.error;
    const sessionId = start.value.session.sessionId;
    const respond = engine.respond(sessionId, '답변', '질문');
    if (!respond.ok) throw respond.error;
    return sessionId;
  }

  it('computeResolutionScore는 넘겨받은 기준값으로 isReady를 정하고 기준값을 남긴다', () => {
    const score = computeResolutionScore({ ...SCORE_075, contradictions: [] }, 'greenfield', 0.7);
    expect(score.overall).toBeCloseTo(0.75);
    expect(score.isReady).toBe(true);
    expect(score.threshold).toBe(0.7);

    const byDefault = computeResolutionScore({ ...SCORE_075, contradictions: [] }, 'greenfield');
    expect(byDefault.isReady).toBe(false);
    expect(byDefault.threshold).toBe(RESOLUTION_THRESHOLD);
  });

  it('설정 0.7에서 overall 0.75는 isReady이고 인터뷰를 force 없이 끝낼 수 있다', () => {
    const engine = new PassthroughEngine(store, undefined, { resolutionThreshold: 0.7 });
    const sessionId = answeredSession(engine);

    const scored = engine.score(sessionId, SCORE_075);
    expect(scored.ok).toBe(true);
    if (!scored.ok) return;
    expect(scored.value.resolutionScore!.isReady).toBe(true);

    const completed = engine.complete(sessionId);
    expect(completed.ok).toBe(true);
    if (completed.ok) expect(completed.value.forcedComplete).toBeUndefined();
  });

  it('기본 설정에서는 overall 0.75로 인터뷰를 끝낼 수 없다', () => {
    const engine = new PassthroughEngine(store);
    const sessionId = answeredSession(engine);
    engine.score(sessionId, SCORE_075);

    const completed = engine.complete(sessionId);
    expect(completed.ok).toBe(false);
    if (!completed.ok) expect(completed.error.message).toContain('0.8');
  });

  it('INTERVIEW_RESOLUTION_SCORED 이벤트에 기준값이 남는다', () => {
    const engine = new PassthroughEngine(store, undefined, { resolutionThreshold: 0.7 });
    const sessionId = answeredSession(engine);
    engine.score(sessionId, SCORE_075);

    const scored = store
      .replay('interview', sessionId)
      .filter((e) => e.eventType === EventType.INTERVIEW_RESOLUTION_SCORED);
    expect(scored).toHaveLength(1);
    expect(scored[0]!.payload['threshold']).toBe(0.7);
  });

  it('이벤트로 다시 만든 세션은 기준값이 달라도 이벤트의 isReady를 그대로 쓴다', () => {
    const engine = new PassthroughEngine(store, undefined, { resolutionThreshold: 0.7 });
    const sessionId = answeredSession(engine);
    engine.score(sessionId, SCORE_075);

    const replayed = new InterviewSessionRepository(store, 0.9).reconstruct(sessionId)!;
    expect(replayed.resolutionScore!.isReady).toBe(true);
    expect(replayed.resolutionScore!.threshold).toBe(0.7);
  });

  it('스펙 생성 차단과 CLI 안내 문구가 같은 설정값을 쓴다', () => {
    const previous = process.env['GESTALT_RESOLUTION_THRESHOLD'];
    process.env['GESTALT_RESOLUTION_THRESHOLD'] = '0.7';
    try {
      const config = loadConfig({}, { skipDotEnv: true, skipGestaltJson: true });
      expect(config.interview.resolutionThreshold).toBe(0.7);
      expect(belowThresholdPrompt(config.interview.resolutionThreshold)).toContain('below 0.7.');

      const engine = new PassthroughEngine(store, undefined, config.interview);
      const generator = new PassthroughSpecGenerator(store, undefined, config.interview);

      // 0.65는 설정 기준값 아래라 막힌다
      const low = answeredSession(engine);
      engine.score(low, {
        goalClarity: 0.65,
        constraintClarity: 0.65,
        successCriteria: 0.65,
        priorityClarity: 0.65,
        contextClarity: 0.65,
      });
      engine.complete(low, true);
      const blocked = generator.validateAndStore(engine.getSession(low), SPEC);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error.message).toContain('임계값(0.7)');

      // 0.75는 기본값 0.8 아래지만 설정 기준값 위라 통과한다
      const high = answeredSession(engine);
      engine.score(high, SCORE_075);
      engine.complete(high);
      const passed = generator.validateAndStore(engine.getSession(high), SPEC);
      expect(passed.ok).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['GESTALT_RESOLUTION_THRESHOLD'];
      else process.env['GESTALT_RESOLUTION_THRESHOLD'] = previous;
    }
  });
});

describe('평가 기준값 설정 연결', () => {
  it('checkTermination은 넘겨받은 기준값으로 성공을 판정한다', () => {
    const base = {
      evolutionHistory: [],
      currentScore: 0.75,
      currentGoalAlignment: 0.72,
      structuralFixCount: 0,
      contextualCount: 0,
    };
    expect(checkTermination(base)).toBeNull();
    expect(
      checkTermination({ ...base, successThreshold: 0.7, goalAlignmentThreshold: 0.7 })?.reason,
    ).toBe('success');
  });

  it('실행 엔진은 설정의 평가 기준값을 쓰고 없으면 상수 기본값을 쓴다', () => {
    const dbPath = `.gestalt-test/threshold-config-exec-${randomUUID()}.db`;
    const store = new EventStore(dbPath);
    try {
      const configured = new PassthroughExecuteEngine(store, undefined, undefined, {
        driftThreshold: 0.3,
        successThreshold: 0.7,
        goalAlignmentThreshold: 0.6,
      });
      expect(configured.getEvaluateThresholds()).toEqual({ success: 0.7, goalAlignment: 0.6 });

      const defaults = new PassthroughExecuteEngine(store);
      expect(defaults.getEvaluateThresholds()).toEqual({ success: 0.85, goalAlignment: 0.8 });
    } finally {
      store.close();
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
      }
    }
  });
});
