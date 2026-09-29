import { describe, it, expect } from 'vitest';
import {
  ReviewAgentMatcher,
  detectHarnessTargets,
  ensureRequiredAgents,
} from '../../../src/review/agent-matcher.js';
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

  it('omits the dependency section entirely when there are no dependency files', () => {
    const ctx = matcher.generateMatchContext(
      { ...mockContext, dependencyFiles: [] },
      [roleAgent],
      [reviewAgent],
    );

    expect(ctx.matchingPrompt).not.toContain('Dependency Context');
    expect(ctx.matchingPrompt).toContain('src/auth/session.ts\n\n**Task Results Summary**');
  });

  it('surrounds the dependency section with one blank line when it renders', () => {
    const ctx = matcher.generateMatchContext(mockContext, [roleAgent], [reviewAgent]);

    expect(ctx.matchingPrompt).toContain(
      'src/auth/session.ts\n\n**Dependency Context** (1):\n  ./utils/hash.js\n\n**Task Results Summary**',
    );
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

  describe('harness-reviewer 항상 포함', () => {
    const harnessReviewer: AgentDefinition = {
      frontmatter: {
        name: 'harness-reviewer',
        tier: 'standard',
        pipeline: 'review',
        description: 'Harness reviewer',
        role: true,
        domain: ['harness', 'prompt', 'skill'],
      },
      systemPrompt: 'Harness prompt',
      filePath: 'review-agents/harness-reviewer/AGENT.md',
    };
    const ctxOf = (changedFiles: string[]): ReviewContext => ({
      ...mockContext,
      changedFiles,
    });

    it('ruleDoc 경로가 바뀌면 필수로 적고 requiredAgents에 담는다', () => {
      const ctx = matcher.generateMatchContext(
        ctxOf(['plugin/skills/foo/SKILL.md', 'src/a.ts']),
        [],
        [reviewAgent, harnessReviewer],
      );
      expect(ctx.requiredAgents).toEqual(['harness-reviewer']);
      expect(ctx.systemPrompt).toContain('Always include harness-reviewer');
      expect(ctx.availableAgents.map((a) => a.name)).toContain('harness-reviewer');
    });

    it('하네스 대상이 없으면 domain에 prompt, skill이 있어도 후보에서 뺀다', () => {
      const ctx = matcher.generateMatchContext(
        ctxOf(['src/prompt/skill-loader.ts', 'src/utils/prompt.ts']),
        [],
        [reviewAgent, harnessReviewer],
      );
      expect(ctx.requiredAgents).toEqual([]);
      expect(ctx.systemPrompt).not.toContain('harness-reviewer');
      expect(ctx.availableAgents.map((a) => a.name)).toEqual(['security-reviewer']);
    });

    it('MCP 도구 등록부는 readFile이 있을 때만 잡는다', () => {
      const registry =
        "import { Server } from '@modelcontextprotocol/sdk/server/index.js';\n" +
        "server.registerTool('acme_search', {}, async () => ({}));\n";
      const files = { 'src/tools.ts': registry };
      const readFile = (p: string) => files[p as keyof typeof files];
      const ctxNoRead = matcher.generateMatchContext(
        ctxOf(['src/tools.ts']),
        [],
        [reviewAgent, harnessReviewer],
      );
      const ctxRead = matcher.generateMatchContext(
        ctxOf(['src/tools.ts']),
        [],
        [reviewAgent, harnessReviewer],
        { readFile },
      );
      expect(ctxNoRead.requiredAgents).toEqual([]);
      expect(ctxRead.requiredAgents).toEqual(['harness-reviewer']);
    });

    it('공개 package.json은 readFile로 잡고 private은 잡지 않는다', () => {
      const readPublic = () => JSON.stringify({ name: '@acme/widget-kit', version: '1.0.0' });
      const readPrivate = () => JSON.stringify({ name: 'app', private: true });
      expect(detectHarnessTargets(['package.json'], readPublic)).toEqual(['package.json']);
      expect(detectHarnessTargets(['package.json'], readPrivate)).toEqual([]);
    });

    it('reviewContext.harnessTargets가 있으면 그 값을 쓴다', () => {
      const ctx = matcher.generateMatchContext(
        { ...ctxOf(['src/a.ts']), harnessTargets: ['src/tools.ts'] },
        [],
        [reviewAgent, harnessReviewer],
      );
      expect(ctx.requiredAgents).toEqual(['harness-reviewer']);
    });

    it('ensureRequiredAgents는 빠진 필수 에이전트만 붙인다', () => {
      const fill = (agentName: string) => ({ agentName, relevanceScore: 1 });
      const omitted = ensureRequiredAgents(
        [{ agentName: 'security-reviewer', relevanceScore: 0.9 }],
        ['harness-reviewer'],
        fill,
      );
      expect(omitted.map((m) => m.agentName)).toEqual(['security-reviewer', 'harness-reviewer']);
      const present = ensureRequiredAgents(omitted, ['harness-reviewer'], fill);
      expect(present).toHaveLength(2);
    });
  });
});
