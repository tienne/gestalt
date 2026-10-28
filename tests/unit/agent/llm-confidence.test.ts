import { describe, it, expect } from 'vitest';
import { RoleConsensusEngine } from '../../../src/agent/role-consensus-engine.js';
import { RolePromptGenerator } from '../../../src/agent/role-prompt-generator.js';
import { SpecExtractor } from '../../../src/spec/extractor.js';
import { specSchema } from '../../../src/spec/schema.js';
import { executeInputSchema } from '../../../src/mcp/schemas.js';
import { GestaltPrinciple } from '../../../src/core/types.js';
import type { AgentDefinition, InterviewSession } from '../../../src/core/types.js';
import type { LLMAdapter, LLMResponse } from '../../../src/llm/types.js';

const agent: AgentDefinition = {
  frontmatter: {
    name: 'architect',
    tier: 'frontier',
    pipeline: 'execute',
    description: 'system design',
    role: true,
  },
  systemPrompt: 'You are an architect.',
  filePath: 'architect/AGENT.md',
};

function session(): InterviewSession {
  const now = new Date().toISOString();
  return {
    sessionId: 's',
    topic: 't',
    status: 'completed',
    projectType: 'greenfield',
    rounds: [
      {
        roundNumber: 1,
        question: 'q',
        userResponse: 'a',
        gestaltFocus: GestaltPrinciple.CLOSURE,
        timestamp: now,
      },
    ],
    resolutionScore: null,
    createdAt: now,
    updatedAt: now,
  };
}

function specJson(analysis: unknown[]): string {
  return JSON.stringify({
    goal: 'g',
    constraints: ['c'],
    acceptanceCriteria: ['a'],
    ontologySchema: { entities: [], relations: [] },
    gestaltAnalysis: analysis,
  });
}

describe('LLM이 쓴 확신도 숫자', () => {
  it('합의 프롬프트에 관점별 확신도가 안 들어간다', () => {
    const context = new RoleConsensusEngine().generateSynthesisContext('task', 'desc', [
      { agentName: 'architect', perspective: 'split modules', confidence: 0.85 },
      { agentName: 'designer', perspective: 'keep tokens' },
    ]);
    expect(context.synthesisPrompt).toContain('### Perspective 1: architect\nsplit modules');
    expect(context.synthesisPrompt).toContain('### Perspective 2: designer\nkeep tokens');
    expect(context.synthesisPrompt).not.toMatch(/confidence/i);
    expect(context.synthesisPrompt).not.toContain('0.85');
  });

  it('관점 프롬프트의 출력 예시에 확신도 필드가 없다', () => {
    const [prompt] = new RolePromptGenerator().generatePerspectivePrompts('task', 'desc', [agent]);
    expect(prompt!.perspectivePrompt).not.toContain('confidence');
    expect(prompt!.perspectivePrompt).not.toContain('0.85');
    const example = prompt!.perspectivePrompt.slice(prompt!.perspectivePrompt.indexOf('{'));
    expect(JSON.parse(example)).toEqual({
      agentName: 'architect',
      perspective: 'Your detailed perspective and recommendations',
    });
  });

  it('스펙 파서는 빠진 확신도를 0.5로 채우지 않는다', async () => {
    const llm: LLMAdapter = {
      chat: async (): Promise<LLMResponse> => ({
        content: specJson([
          { principle: 'closure', finding: 'no number' },
          { principle: 'proximity', finding: 'with number', confidence: 0.7 },
        ]),
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    };
    const extracted = await new SpecExtractor(llm).extract(session());
    expect(extracted.gestaltAnalysis[0]).toEqual({ principle: 'closure', finding: 'no number' });
    expect(extracted.gestaltAnalysis[0]).not.toHaveProperty('confidence');
    expect(extracted.gestaltAnalysis[1]!.confidence).toBe(0.7);
  });

  it('스펙 스키마는 확신도가 있어도 없어도 받는다', () => {
    const spec = (analysis: unknown[]) => ({
      ...JSON.parse(specJson(analysis)),
      version: '1.0.0',
      metadata: {
        specId: 'id',
        interviewSessionId: 's',
        resolutionScore: 0.9,
        generatedAt: new Date().toISOString(),
      },
    });
    expect(specSchema.safeParse(spec([{ principle: 'closure', finding: 'f' }])).success).toBe(true);
    expect(
      specSchema.safeParse(spec([{ principle: 'closure', finding: 'f', confidence: 0.8 }])).success,
    ).toBe(true);
    expect(
      specSchema.safeParse(spec([{ principle: 'closure', finding: 'f', confidence: 2 }])).success,
    ).toBe(false);
  });

  it('role_consensus 입력은 확신도가 있어도 없어도 받는다', () => {
    const parse = (perspectives: unknown[]) =>
      executeInputSchema.safeParse({
        action: 'role_consensus',
        perspectives,
        consensus: { consensus: 'c', conflictResolutions: [], perspectives },
      }).success;
    expect(parse([{ agentName: 'a', perspective: 'p' }])).toBe(true);
    expect(parse([{ agentName: 'a', perspective: 'p', confidence: 0.9 }])).toBe(true);
  });
});
