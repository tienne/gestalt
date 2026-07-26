/**
 * Continuity 모순 감지 회귀 테스트.
 *
 * 버그: hasContradictions 판정이 차원명('continuity') 비교로 되어 있어 항상 false였다.
 * 수정: resolutionScore.contradictions(또는 externalScore.contradictions) 배열의
 * length > 0 검사로 변경. 이 테스트는 실제 프로덕션 코드 경로(engine.ts의 자체 LLM 호출 모드,
 * passthrough-engine.ts의 Passthrough 모드)가 이 값을 만들어내고, selectNextPrinciple가
 * 실제로 CONTINUITY를 선택하며, 그 결과가 세션/이벤트에 영속화되는지를 검증한다.
 *
 * tests/unit/gestalt/principles.test.ts는 hasContradictions: true를 직접 주입하는 방식이라
 * 프로덕션 코드가 그 값을 실제로 만들어내는지는 검증하지 못했다 — 이 테스트가 그 간극을 메운다.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { InterviewEngine } from '../../../src/interview/engine.js';
import { PassthroughEngine } from '../../../src/interview/passthrough-engine.js';
import { InterviewSessionRepository } from '../../../src/interview/repository.js';
import { EventStore } from '../../../src/events/store.js';
import { GestaltPrinciple } from '../../../src/core/types.js';
import type { LLMAdapter, LLMRequest, LLMResponse } from '../../../src/llm/types.js';

class MockLLM implements LLMAdapter {
  responses: string[] = [];
  private callIndex = 0;

  async chat(_request: LLMRequest): Promise<LLMResponse> {
    const content =
      this.responses[this.callIndex] ?? '{"question": "Fallback question?", "reasoning": "mock"}';
    this.callIndex++;
    return { content, usage: { inputTokens: 100, outputTokens: 50 } };
  }
}

function cleanupDb(dbPath: string): void {
  try {
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(dbPath + '-wal')) rmSync(dbPath + '-wal');
    if (existsSync(dbPath + '-shm')) rmSync(dbPath + '-shm');
  } catch {
    /* ignore */
  }
}

describe('Continuity 모순 감지 (engine.ts — 자체 LLM 호출 모드)', () => {
  let store: EventStore;
  let mockLLM: MockLLM;
  let engine: InterviewEngine;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/contradiction-engine-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    mockLLM = new MockLLM();
    engine = new InterviewEngine(mockLLM, store);
  });

  afterEach(() => {
    store.close();
    cleanupDb(dbPath);
  });

  it('LLM이 contradictions를 반환하면 hasContradictions가 true로 판정되어 CONTINUITY가 선택되고 다음 라운드에 반영된다', async () => {
    mockLLM.responses = [
      '{"question": "What is the main goal?", "reasoning": "Closure"}',
      '{"goalClarity": 0.6, "constraintClarity": 0.5, "successCriteria": 0.4, "priorityClarity": 0.3, "contradictions": ["처음엔 관리자만 접근 가능하다고 했다가 나중엔 모든 사용자가 접근 가능하다고 했다"]}',
      '{"question": "Which access policy is correct — admin-only or all users?", "reasoning": "Continuity"}',
    ];

    const startResult = await engine.start('Access control feature');
    if (!startResult.ok) throw new Error('start failed');

    const { sessionId } = startResult.value.session;
    const respondResult = await engine.respond(
      sessionId,
      '관리자만 접근 가능해야 하지만 모든 사용자도 봐야 해요',
    );
    expect(respondResult.ok).toBe(true);
    if (!respondResult.ok) return;

    // 1. resolutionScore에 contradictions가 실제로 채워진다 (analyzer.computeResolutionScore)
    expect(respondResult.value.resolutionScore.contradictions).toBeDefined();
    expect(respondResult.value.resolutionScore.contradictions!.length).toBeGreaterThan(0);

    // 2. 이번이 핵심 회귀 포인트: hasContradictions가 true로 판정되어
    //    selectNextPrinciple가 다음 라운드에 CONTINUITY를 배정한다.
    //    (버그 당시엔 차원명 비교라 이 경로에 절대 도달하지 못했다.)
    const session = engine.getSession(sessionId);
    expect(session.rounds).toHaveLength(2);
    expect(session.rounds[1]!.gestaltFocus).toBe(GestaltPrinciple.CONTINUITY);

    // 3. 모순이 감지된 라운드(직전에 답변된 라운드)에 contradictions가 기록된다
    expect(session.rounds[0]!.contradictions).toEqual(
      respondResult.value.resolutionScore.contradictions,
    );
  });

  it('contradictions가 없으면 CONTINUITY가 아닌 다른 원리가 선택된다 (오탐 방지 대조군)', async () => {
    // contextClarity를 명시적으로 높게 채워 넣는다 — 세션 projectType이 (cwd 감지 결과)
    // brownfield일 경우 이 값을 비워두면 contextClarity가 0으로 기본값 처리되어
    // "가장 약한 차원"으로 CONTINUITY가 선택되는 별개 경로(오탐이 아닌 정상 로직)와
    // 혼선을 일으키기 때문에, 이 대조군에서는 모든 차원이 고르게 명확하도록 만든다.
    mockLLM.responses = [
      '{"question": "What is the main goal?", "reasoning": "Closure"}',
      '{"goalClarity": 0.9, "constraintClarity": 0.9, "successCriteria": 0.9, "priorityClarity": 0.9, "contextClarity": 0.9, "contradictions": []}',
      '{"question": "Any other constraints?", "reasoning": "next"}',
    ];

    const startResult = await engine.start('Simple feature');
    if (!startResult.ok) throw new Error('start failed');

    const { sessionId } = startResult.value.session;
    const respondResult = await engine.respond(sessionId, 'It just needs a login page');
    expect(respondResult.ok).toBe(true);
    if (!respondResult.ok) return;

    expect(respondResult.value.resolutionScore.contradictions ?? []).toHaveLength(0);

    const session = engine.getSession(sessionId);
    expect(session.rounds[1]!.gestaltFocus).not.toBe(GestaltPrinciple.CONTINUITY);
    expect(session.rounds[0]!.contradictions).toBeUndefined();
  });

  it('영속화: 모순이 감지된 라운드는 이벤트 replay 후에도 contradictions를 유지한다 (서버 재시작 시뮬레이션)', async () => {
    mockLLM.responses = [
      '{"question": "What is the main goal?", "reasoning": "Closure"}',
      '{"goalClarity": 0.6, "constraintClarity": 0.5, "successCriteria": 0.4, "priorityClarity": 0.3, "contradictions": ["요구사항 A와 B가 서로 모순된다"]}',
    ];

    const startResult = await engine.start('Payment feature');
    if (!startResult.ok) throw new Error('start failed');

    const { sessionId } = startResult.value.session;
    const respondResult = await engine.respond(
      sessionId,
      '결제는 즉시 처리되면서 동시에 24시간 후 처리되어야 해요',
    );
    if (!respondResult.ok) throw new Error('respond failed');

    // 서버 재시작 시뮬레이션: EventStore를 닫고 새로 열어 replay로 복원
    store.close();
    const newStore = new EventStore(dbPath);
    const repo = new InterviewSessionRepository(newStore);

    const reconstructed = repo.reconstruct(sessionId);
    expect(reconstructed).not.toBeNull();
    expect(reconstructed!.rounds[0]!.contradictions).toEqual(
      respondResult.value.resolutionScore.contradictions,
    );
    expect(reconstructed!.resolutionScore?.contradictions).toEqual(
      respondResult.value.resolutionScore.contradictions,
    );

    newStore.close();
  });
});

describe('Continuity 모순 감지 (passthrough-engine.ts — Passthrough 모드)', () => {
  let store: EventStore;
  let engine: PassthroughEngine;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/contradiction-passthrough-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughEngine(store);
  });

  afterEach(() => {
    store.close();
    cleanupDb(dbPath);
  });

  it('externalScore.contradictions가 있으면 hasContradictions가 true로 판정되어 다음 gestaltContext가 CONTINUITY를 가리킨다', () => {
    const startResult = engine.start('Access control feature');
    if (!startResult.ok) throw new Error('start failed');

    const { sessionId } = startResult.value.session;

    const respondResult = engine.respond(
      sessionId,
      '관리자만 접근 가능해야 하지만 모든 사용자도 봐야 해요',
      'Who should have access to this feature?',
      {
        goalClarity: 0.6,
        constraintClarity: 0.5,
        successCriteria: 0.4,
        priorityClarity: 0.3,
        contradictions: [
          '처음엔 관리자만 접근 가능하다고 했다가 나중엔 모든 사용자가 접근 가능하다고 했다',
        ],
      },
    );
    expect(respondResult.ok).toBe(true);
    if (!respondResult.ok) return;

    // 1. resolutionScore에 contradictions가 실제로 채워진다
    expect(respondResult.value.resolutionScore).not.toBeNull();
    expect(respondResult.value.resolutionScore!.contradictions).toBeDefined();
    expect(respondResult.value.resolutionScore!.contradictions!.length).toBeGreaterThan(0);

    // 2. 핵심 회귀 포인트: 다음 질문을 위한 gestaltContext가 CONTINUITY를 가리킨다
    //    (버그 당시엔 차원명 비교라 이 경로에 절대 도달하지 못했다.)
    expect(respondResult.value.gestaltContext.currentPrinciple).toBe(GestaltPrinciple.CONTINUITY);

    // 3. 모순이 감지된 라운드(방금 답변된 라운드)에 contradictions가 기록된다
    expect(respondResult.value.session.rounds).toHaveLength(1);
    expect(respondResult.value.session.rounds[0]!.contradictions).toEqual(
      respondResult.value.resolutionScore!.contradictions,
    );
  });

  it('externalScore.contradictions가 비어있으면 CONTINUITY가 아닌 다른 원리가 선택된다 (오탐 방지 대조군)', () => {
    const startResult = engine.start('Simple feature');
    if (!startResult.ok) throw new Error('start failed');

    const { sessionId } = startResult.value.session;
    const respondResult = engine.respond(
      sessionId,
      'It just needs a login page',
      'What is the goal?',
      {
        goalClarity: 0.9,
        constraintClarity: 0.9,
        successCriteria: 0.9,
        priorityClarity: 0.9,
        contradictions: [],
      },
    );
    expect(respondResult.ok).toBe(true);
    if (!respondResult.ok) return;

    expect(respondResult.value.resolutionScore!.contradictions ?? []).toHaveLength(0);
    expect(respondResult.value.gestaltContext.currentPrinciple).not.toBe(
      GestaltPrinciple.CONTINUITY,
    );
    expect(respondResult.value.session.rounds[0]!.contradictions).toBeUndefined();
  });

  it('영속화: 모순이 감지된 라운드는 이벤트 replay 후에도 contradictions를 유지한다 (서버 재시작 시뮬레이션)', () => {
    const startResult = engine.start('Payment feature');
    if (!startResult.ok) throw new Error('start failed');

    const { sessionId } = startResult.value.session;
    const respondResult = engine.respond(
      sessionId,
      '결제는 즉시 처리되면서 동시에 24시간 후 처리되어야 해요',
      'When should payment be processed?',
      {
        goalClarity: 0.6,
        constraintClarity: 0.5,
        successCriteria: 0.4,
        priorityClarity: 0.3,
        contradictions: ['요구사항 A와 B가 서로 모순된다'],
      },
    );
    if (!respondResult.ok) throw new Error('respond failed');

    // 서버 재시작 시뮬레이션
    store.close();
    const newStore = new EventStore(dbPath);
    const repo = new InterviewSessionRepository(newStore);

    const reconstructed = repo.reconstruct(sessionId);
    expect(reconstructed).not.toBeNull();
    expect(reconstructed!.rounds[0]!.contradictions).toEqual(
      respondResult.value.resolutionScore!.contradictions,
    );
    expect(reconstructed!.resolutionScore?.contradictions).toEqual(
      respondResult.value.resolutionScore!.contradictions,
    );

    newStore.close();
  });
});
