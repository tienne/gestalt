import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InterviewEngine } from '../../src/interview/engine.js';
import { SpecGenerator } from '../../src/spec/generator.js';
import { EventStore } from '../../src/events/store.js';
import type { LLMAdapter, LLMRequest, LLMResponse } from '../../src/llm/types.js';
import { isOk } from '../../src/core/result.js';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

class MockLLM implements LLMAdapter {
  private callIndex = 0;
  private responses: string[];

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async chat(_request: LLMRequest): Promise<LLMResponse> {
    const content = this.responses[this.callIndex] ?? '{}';
    this.callIndex++;
    return { content, usage: { inputTokens: 100, outputTokens: 50 } };
  }
}

describe('Interview → Spec Pipeline', () => {
  let store: EventStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/integration-${randomUUID()}.db`;
    store = new EventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      if (existsSync(dbPath)) rmSync(dbPath);
      if (existsSync(dbPath + '-wal')) rmSync(dbPath + '-wal');
      if (existsSync(dbPath + '-shm')) rmSync(dbPath + '-shm');
    } catch {
      /* ignore */
    }
  });

  it('completes full interview → spec pipeline', async () => {
    const llm = new MockLLM([
      // start: question generation
      '{"question": "What is the main goal of your dashboard?", "reasoning": "Closure"}',
      // respond round 1: resolution scoring
      '{"goalClarity": 0.6, "constraintClarity": 0.4, "successCriteria": 0.3, "priorityClarity": 0.2, "contradictions": []}',
      // respond round 1: next question
      '{"question": "What technical constraints exist?", "reasoning": "Proximity"}',
      // respond round 2: resolution scoring
      '{"goalClarity": 0.8, "constraintClarity": 0.7, "successCriteria": 0.6, "priorityClarity": 0.5, "contradictions": []}',
      // respond round 2: next question
      '{"question": "What are the success criteria?", "reasoning": "Similarity"}',
      // respond round 3: resolution scoring
      '{"goalClarity": 0.95, "constraintClarity": 0.9, "successCriteria": 0.85, "priorityClarity": 0.9, "contradictions": []}',
      // respond round 3: next question
      '{"question": "Any priorities?", "reasoning": "FigureGround"}',
      // spec generation
      JSON.stringify({
        goal: 'Build a real-time analytics dashboard for e-commerce metrics',
        constraints: ['React + TypeScript', 'WebSocket for real-time', 'Mobile responsive'],
        acceptanceCriteria: ['Display KPIs in real-time', 'Export to CSV', 'Role-based access'],
        ontologySchema: {
          entities: [
            { name: 'Dashboard', description: 'Main container', attributes: ['title', 'layout'] },
            {
              name: 'Widget',
              description: 'Data visualization',
              attributes: ['type', 'dataSource'],
            },
          ],
          relations: [{ from: 'Dashboard', to: 'Widget', type: 'contains' }],
        },
        gestaltAnalysis: [
          {
            principle: 'closure',
            finding: 'Clear goal with real-time requirement',
            confidence: 0.95,
          },
          { principle: 'proximity', finding: 'Technical stack well-defined', confidence: 0.9 },
        ],
      }),
    ]);

    const engine = new InterviewEngine(llm, store);
    const specGenerator = new SpecGenerator(llm, store);

    // Step 1: Start interview
    const startResult = await engine.start('E-commerce analytics dashboard');
    expect(isOk(startResult)).toBe(true);
    if (!startResult.ok) return;
    const { session } = startResult.value;

    // Step 2: 3 rounds of Q&A
    const responses = [
      'Build a real-time dashboard showing sales, conversion rates, and inventory',
      'React + TypeScript, WebSocket for live data, must work on mobile',
      'Real-time KPIs, CSV export, role-based access control',
    ];

    for (const response of responses) {
      const result = await engine.respond(session.sessionId, response);
      expect(isOk(result)).toBe(true);
    }

    // Step 3: Complete interview
    const completeResult = engine.complete(session.sessionId);
    expect(isOk(completeResult)).toBe(true);

    // Step 4: Generate spec (force since we may not meet threshold with mock)
    const completedSession = engine.getSession(session.sessionId);
    const specResult = await specGenerator.generate(completedSession, true);
    expect(isOk(specResult)).toBe(true);

    if (specResult.ok) {
      expect(specResult.value.goal).toContain('analytics dashboard');
      expect(specResult.value.constraints.length).toBeGreaterThan(0);
      expect(specResult.value.acceptanceCriteria.length).toBeGreaterThan(0);
      expect(specResult.value.metadata.interviewSessionId).toBe(session.sessionId);
    }
  });
});
