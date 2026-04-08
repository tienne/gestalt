import { describe, it, expect } from 'vitest';
import { ReviewAgentMatcher } from '../../../src/review/agent-matcher.js';
import type { AgentDefinition, ReviewContext, Spec } from '../../../src/core/types.js';

const mockSpec: Spec = {
  version: '1.0.0',
  goal: 'Build auth system',
  constraints: ['Use TypeScript'],
  acceptanceCriteria: ['Login works'],
  ontologySchema: { entities: [], relations: [] },
  gestaltAnalysis: [],
  metadata: { specId: 's1', interviewSessionId: 'i1', resolutionScore: 0.9, generatedAt: '' },
};

const mockContext: ReviewContext = {
  changedFiles: ['src/auth/login.ts', 'src/auth/session.ts'],
  dependencyFiles: ['./utils/hash.js'],
  spec: mockSpec,
  taskResults: [],
};

const roleAgent: AgentDefinition = {
  frontmatter: {
    name: 'backend-developer',
    tier: 'standard',
    pipeline: 'execute',
    description: 'Backend dev',
    role: true,
    domain: ['api', 'database'],
  },
  systemPrompt: 'Backend prompt',
  filePath: 'role-agents/backend-developer/AGENT.md',
};

const reviewAgent: AgentDefinition = {
  frontmatter: {
    name: 'security-reviewer',
    tier: 'standard',
    pipeline: 'review',
    description: 'Security reviewer',
    role: true,
    domain: ['security'],
  },
  systemPrompt: 'Security prompt',
  filePath: 'review-agents/security-reviewer/AGENT.md',
};

describe('ReviewAgentMatcher', () => {
  const matcher = new ReviewAgentMatcher();

  it('generates match context with both agent types', () => {
    const ctx = matcher.generateMatchContext(mockContext, [roleAgent], [reviewAgent]);

    expect(ctx.availableAgents).toHaveLength(2);
    expect(ctx.availableAgents[0]!.category).toBe('role-agent');
    expect(ctx.availableAgents[1]!.category).toBe('review-specialist');
  });

  it('includes spec goal in matching prompt', () => {
    const ctx = matcher.generateMatchContext(mockContext, [roleAgent], [reviewAgent]);
    expect(ctx.matchingPrompt).toContain('Build auth system');
  });

  it('lists changed files in matching prompt', () => {
    const ctx = matcher.generateMatchContext(mockContext, [roleAgent], [reviewAgent]);
    expect(ctx.matchingPrompt).toContain('src/auth/login.ts');
    expect(ctx.matchingPrompt).toContain('src/auth/session.ts');
  });

  it('includes dependency files in matching prompt', () => {
    const ctx = matcher.generateMatchContext(mockContext, [roleAgent], [reviewAgent]);
    expect(ctx.matchingPrompt).toContain('./utils/hash.js');
  });

  it('system prompt contains matching rules', () => {
    const ctx = matcher.generateMatchContext(mockContext, [], [reviewAgent]);
    expect(ctx.systemPrompt).toContain('Always include at least one review-specialist');
    expect(ctx.systemPrompt).toContain('JSON object');
  });

  it('works with empty role agents', () => {
    const ctx = matcher.generateMatchContext(mockContext, [], [reviewAgent]);
    expect(ctx.availableAgents).toHaveLength(1);
    expect(ctx.availableAgents[0]!.category).toBe('review-specialist');
  });
});
