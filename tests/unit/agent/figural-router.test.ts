import { describe, it, expect } from 'vitest';
import { FiguralRouter } from '../../../src/agent/figural-router.js';
import type { AgentDefinition } from '../../../src/core/types.js';
import type { LLMAdapter, LLMRequest, LLMResponse } from '../../../src/llm/types.js';

function createMockAdapter(name: string): LLMAdapter {
  return {
    async chat(_req: LLMRequest): Promise<LLMResponse> {
      return { content: `response from ${name}`, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

function createAgent(overrides: Partial<AgentDefinition['frontmatter']> = {}): AgentDefinition {
  return {
    frontmatter: {
      name: 'test-agent',
      tier: 'standard',
      pipeline: 'interview',
      description: 'Test agent',
      ...overrides,
    },
    systemPrompt: 'You are a test agent.',
    filePath: 'test.md',
  };
}

describe('FiguralRouter', () => {
  const frugalAdapter = createMockAdapter('frugal');
  const standardAdapter = createMockAdapter('standard');
  const frontierAdapter = createMockAdapter('frontier');

  const router = new FiguralRouter({
    tierMapping: {
      frugal: { provider: 'openai', model: 'gpt-4o-mini', adapter: frugalAdapter },
      standard: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', adapter: standardAdapter },
      frontier: { provider: 'anthropic', model: 'claude-opus-4-20250514', adapter: frontierAdapter },
    },
  });

  it('routes to adapter based on agent tier', () => {
    const frugalAgent = createAgent({ tier: 'frugal' });
    expect(router.route(frugalAgent)).toBe(frugalAdapter);

    const standardAgent = createAgent({ tier: 'standard' });
    expect(router.route(standardAgent)).toBe(standardAdapter);

    const frontierAgent = createAgent({ tier: 'frontier' });
    expect(router.route(frontierAgent)).toBe(frontierAdapter);
  });

  it('runtime override takes precedence over agent tier', () => {
    const agent = createAgent({ tier: 'frugal' });
    expect(router.route(agent, 'frontier')).toBe(frontierAdapter);
  });

  it('resolves model from tier mapping', () => {
    const agent = createAgent({ tier: 'standard' });
    expect(router.resolveModel(agent)).toBe('claude-sonnet-4-20250514');
  });

  it('AGENT.md model field takes precedence in resolveModel', () => {
    const agent = createAgent({ tier: 'standard', model: 'custom-model-v1' });
    expect(router.resolveModel(agent)).toBe('custom-model-v1');
  });

  it('defaults to standard tier when not specified', () => {
    const defaultRouter = new FiguralRouter({
      tierMapping: {
        frugal: { provider: 'openai', model: 'gpt-4o-mini', adapter: frugalAdapter },
        standard: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', adapter: standardAdapter },
        frontier: { provider: 'anthropic', model: 'claude-opus-4-20250514', adapter: frontierAdapter },
      },
      defaultTier: 'standard',
    });

    const agent = createAgent({ tier: 'standard' });
    expect(defaultRouter.route(agent)).toBe(standardAdapter);
  });

  it('returns tier mapping info', () => {
    const mapping = router.getTierMapping();
    expect(mapping.frugal.provider).toBe('openai');
    expect(mapping.standard.provider).toBe('anthropic');
    expect(mapping.frontier.provider).toBe('anthropic');
  });
});
