import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InterviewEngine } from '../../../src/interview/engine.js';
import { EventStore } from '../../../src/events/store.js';
import type { LLMAdapter, LLMRequest, LLMResponse } from '../../../src/llm/types.js';
import { isOk, isErr } from '../../../src/core/result.js';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

class MockLLM implements LLMAdapter {
  responses: string[] = [];
  private callIndex = 0;

  async chat(_request: LLMRequest): Promise<LLMResponse> {
    const content = this.responses[this.callIndex] ?? '{"question": "Fallback question?", "reasoning": "mock"}';
    this.callIndex++;
    return { content, usage: { inputTokens: 100, outputTokens: 50 } };
  }
}

describe('InterviewEngine', () => {
  let store: EventStore;
  let mockLLM: MockLLM;
  let engine: InterviewEngine;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/engine-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    mockLLM = new MockLLM();
    engine = new InterviewEngine(mockLLM, store);
  });

  afterEach(() => {
    store.close();
    try {
      if (existsSync(dbPath)) rmSync(dbPath);
      if (existsSync(dbPath + '-wal')) rmSync(dbPath + '-wal');
      if (existsSync(dbPath + '-shm')) rmSync(dbPath + '-shm');
    } catch { /* ignore */ }
  });

  it('starts an interview', async () => {
    mockLLM.responses = [
      '{"question": "What is the main goal of this feature?", "reasoning": "Closure principle"}',
    ];

    const result = await engine.start('Dashboard feature');
    expect(isOk(result)).toBe(true);

    if (result.ok) {
      expect(result.value.session.topic).toBe('Dashboard feature');
      expect(result.value.firstQuestion).toBe('What is the main goal of this feature?');
      expect(result.value.session.rounds).toHaveLength(1);
    }
  });

  it('responds to questions and generates next', async () => {
    mockLLM.responses = [
      '{"question": "What is the goal?", "reasoning": "Closure"}',
      '{"goalClarity": 0.5, "constraintClarity": 0.3, "successCriteria": 0.2, "priorityClarity": 0.1, "contradictions": []}',
      '{"question": "What constraints exist?", "reasoning": "Proximity"}',
    ];

    const startResult = await engine.start('Dashboard');
    expect(isOk(startResult)).toBe(true);

    if (startResult.ok) {
      const respondResult = await engine.respond(
        startResult.value.session.sessionId,
        'Build a real-time analytics dashboard',
      );
      expect(isOk(respondResult)).toBe(true);

      if (respondResult.ok) {
        expect(respondResult.value.nextQuestion).toBe('What constraints exist?');
        expect(respondResult.value.resolutionScore.overall).toBeGreaterThan(0);
      }
    }
  });

  it('scores a session', async () => {
    mockLLM.responses = [
      '{"question": "What?", "reasoning": "r"}',
      '{"goalClarity": 0.8, "constraintClarity": 0.7, "successCriteria": 0.6, "priorityClarity": 0.5, "contradictions": []}',
    ];

    const start = await engine.start('test');
    if (!start.ok) throw new Error('start failed');

    const session = engine.getSession(start.value.session.sessionId);
    session.rounds[0]!.userResponse = 'some response';

    const scoreResult = await engine.score(start.value.session.sessionId);
    expect(isOk(scoreResult)).toBe(true);
  });

  it('completes a session', async () => {
    mockLLM.responses = [
      '{"question": "What?", "reasoning": "r"}',
    ];

    const start = await engine.start('test');
    if (!start.ok) throw new Error('start failed');

    const result = engine.complete(start.value.session.sessionId);
    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('completed');
    }
  });

  it('returns error for nonexistent session', async () => {
    const result = await engine.respond('nonexistent', 'hello');
    expect(isErr(result)).toBe(true);
  });
});
