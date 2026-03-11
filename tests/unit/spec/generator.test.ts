import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SpecGenerator } from '../../../src/spec/generator.js';
import { EventStore } from '../../../src/events/store.js';
import type { InterviewSession } from '../../../src/core/types.js';
import { GestaltPrinciple } from '../../../src/core/types.js';
import type { LLMAdapter, LLMRequest, LLMResponse } from '../../../src/llm/types.js';
import { isOk, isErr } from '../../../src/core/result.js';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

class MockLLM implements LLMAdapter {
  response = '';
  async chat(_req: LLMRequest): Promise<LLMResponse> {
    return { content: this.response, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

function makeSession(overrides: Partial<InterviewSession> = {}): InterviewSession {
  return {
    sessionId: 'test-session',
    topic: 'Test Feature',
    status: 'completed',
    projectType: 'greenfield',
    rounds: [
      {
        roundNumber: 1,
        question: 'What is the goal?',
        userResponse: 'Build a dashboard',
        gestaltFocus: GestaltPrinciple.CLOSURE,
        timestamp: new Date().toISOString(),
      },
    ],
    ambiguityScore: { overall: 0.15, dimensions: [], isReady: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SpecGenerator', () => {
  let store: EventStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/spec-${randomUUID()}.db`;
    store = new EventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      if (existsSync(dbPath)) rmSync(dbPath);
      if (existsSync(dbPath + '-wal')) rmSync(dbPath + '-wal');
      if (existsSync(dbPath + '-shm')) rmSync(dbPath + '-shm');
    } catch { /* ignore */ }
  });

  it('generates a spec from completed interview', async () => {
    const llm = new MockLLM();
    llm.response = JSON.stringify({
      goal: 'Build a dashboard',
      constraints: ['React'],
      acceptanceCriteria: ['Show data'],
      ontologySchema: {
        entities: [{ name: 'Dashboard', description: 'Main', attributes: ['title'] }],
        relations: [],
      },
      gestaltAnalysis: [
        { principle: 'closure', finding: 'Clear goal', confidence: 0.9 },
      ],
    });

    const generator = new SpecGenerator(llm, store);
    const result = await generator.generate(makeSession());

    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.value.goal).toBe('Build a dashboard');
      expect(result.value.version).toBe('1.0.0');
      expect(result.value.metadata.interviewSessionId).toBe('test-session');
    }
  });

  it('rejects when ambiguity too high and not forced', async () => {
    const llm = new MockLLM();
    const generator = new SpecGenerator(llm, store);
    const session = makeSession({
      ambiguityScore: { overall: 0.5, dimensions: [], isReady: false },
    });

    const result = await generator.generate(session);
    expect(isErr(result)).toBe(true);
  });

  it('allows generation with force flag', async () => {
    const llm = new MockLLM();
    llm.response = JSON.stringify({
      goal: 'Build it',
      constraints: [],
      acceptanceCriteria: [],
      ontologySchema: { entities: [], relations: [] },
      gestaltAnalysis: [],
    });

    const generator = new SpecGenerator(llm, store);
    const session = makeSession({
      ambiguityScore: { overall: 0.5, dimensions: [], isReady: false },
    });

    const result = await generator.generate(session, true);
    expect(isOk(result)).toBe(true);
  });

  it('rejects incomplete sessions', async () => {
    const llm = new MockLLM();
    const generator = new SpecGenerator(llm, store);
    const session = makeSession({ status: 'in_progress' });

    const result = await generator.generate(session);
    expect(isErr(result)).toBe(true);
  });
});
