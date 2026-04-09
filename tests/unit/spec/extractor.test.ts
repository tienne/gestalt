import { describe, it, expect } from 'vitest';
import { SpecExtractor } from '../../../src/spec/extractor.js';
import type { InterviewSession } from '../../../src/core/types.js';
import { GestaltPrinciple } from '../../../src/core/types.js';
import type { LLMAdapter, LLMRequest, LLMResponse } from '../../../src/llm/types.js';

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
    resolutionScore: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SpecExtractor', () => {
  it('extracts spec data from LLM response', async () => {
    const llm = new MockLLM();
    llm.response = JSON.stringify({
      goal: 'Build a real-time analytics dashboard',
      constraints: ['Use React', 'Must support mobile'],
      acceptanceCriteria: ['Display charts', 'Export to CSV'],
      ontologySchema: {
        entities: [{ name: 'Dashboard', description: 'Main view', attributes: ['title'] }],
        relations: [{ from: 'Dashboard', to: 'Chart', type: 'contains' }],
      },
      gestaltAnalysis: [{ principle: 'closure', finding: 'Goal is clear', confidence: 0.9 }],
    });

    const extractor = new SpecExtractor(llm);
    const result = await extractor.extract(makeSession());

    expect(result.goal).toBe('Build a real-time analytics dashboard');
    expect(result.constraints).toHaveLength(2);
    expect(result.acceptanceCriteria).toHaveLength(2);
    expect(result.ontologySchema.entities).toHaveLength(1);
    expect(result.gestaltAnalysis).toHaveLength(1);
  });

  it('throws on empty rounds', async () => {
    const llm = new MockLLM();
    const extractor = new SpecExtractor(llm);
    const session = makeSession({ rounds: [] });

    await expect(extractor.extract(session)).rejects.toThrow('No completed interview rounds');
  });

  it('handles malformed LLM response gracefully', async () => {
    const llm = new MockLLM();
    llm.response = 'This is not JSON at all';
    const extractor = new SpecExtractor(llm);

    await expect(extractor.extract(makeSession())).rejects.toThrow('Failed to parse');
  });
});
