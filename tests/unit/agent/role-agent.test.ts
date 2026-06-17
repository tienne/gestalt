import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { AgentRegistry } from '../../../src/agent/registry.js';
import { RoleAgentRegistry } from '../../../src/agent/role-agent-registry.js';
import { RoleMatchEngine } from '../../../src/agent/role-match-engine.js';
import { RolePromptGenerator } from '../../../src/agent/role-prompt-generator.js';
import { RoleConsensusEngine } from '../../../src/agent/role-consensus-engine.js';
import { parseAgentMd } from '../../../src/agent/parser.js';
import type { RolePerspective } from '../../../src/core/types.js';

// ─── Backward Compatibility (task-14) ────────────────────────

describe('Pipeline Agent Backward Compatibility', () => {
  it('parses existing pipeline agents without role/domain fields', () => {
    const content = `---
name: test-agent
tier: frugal
pipeline: execute
description: "Test pipeline agent"
---

Test system prompt`;

    const agent = parseAgentMd(content, 'test/AGENT.md');
    expect(agent.frontmatter.role).toBe(false);
    expect(agent.frontmatter.domain).toEqual([]);
    expect(agent.frontmatter.name).toBe('test-agent');
    expect(agent.frontmatter.pipeline).toBe('execute');
  });

  it('loads real pipeline agents from agents/ directory', () => {
    const registry = new AgentRegistry(resolve('agents'));
    registry.loadAll();

    const all = registry.getAll();
    expect(all.length).toBe(5);

    const pipelineAgents = registry.getByPipeline('execute');
    expect(pipelineAgents.length).toBeGreaterThan(0);
    expect(pipelineAgents.every((a) => !a.frontmatter.role)).toBe(true);
  });

  it('getByRole returns empty for pipeline-only agents', () => {
    const registry = new AgentRegistry(resolve('agents'));
    registry.loadAll();

    const roleAgents = registry.getByRole();
    expect(roleAgents).toEqual([]);
  });

  it('getByPipeline filters out role agents', () => {
    const registry = new AgentRegistry(resolve('agents'));
    registry.loadAll();

    const pipeline = registry.getByPipeline('execute');
    // Pipeline agents have role=false (default)
    expect(pipeline.every((a) => a.frontmatter.role === false)).toBe(true);
  });
});

// ─── Role Agent Parsing ─────────────────────────────────────

describe('Role Agent Parsing', () => {
  it('parses role agent with role=true and domain[]', () => {
    const content = `---
name: test-role
tier: standard
pipeline: execute
role: true
domain: ["frontend", "react"]
description: "Test role agent"
---

Test role system prompt`;

    const agent = parseAgentMd(content, 'test/AGENT.md');
    expect(agent.frontmatter.role).toBe(true);
    expect(agent.frontmatter.domain).toEqual(['frontend', 'react']);
  });
});

// ─── RoleAgentRegistry ──────────────────────────────────────

describe('RoleAgentRegistry', () => {
  it('loads builtin role agents from role-agents/ directory', () => {
    const registry = new RoleAgentRegistry(resolve('role-agents'));
    registry.loadAll();

    const all = registry.getAll();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(registry.has('frontend-developer')).toBe(true);
    expect(registry.has('backend-developer')).toBe(true);
    expect(registry.has('architect')).toBe(true);
    expect(registry.has('video-summarizer')).toBe(true);
  });

  it('getByDomain returns matching agents', () => {
    const registry = new RoleAgentRegistry(resolve('role-agents'));
    registry.loadAll();

    const uiAgents = registry.getByDomain('ui');
    expect(uiAgents.length).toBeGreaterThan(0);
    expect(uiAgents.some((a) => a.frontmatter.name === 'frontend-developer')).toBe(true);
  });

  it('getByName returns specific agent', () => {
    const registry = new RoleAgentRegistry(resolve('role-agents'));
    registry.loadAll();

    const architect = registry.getByName('architect');
    expect(architect).toBeDefined();
    expect(architect!.frontmatter.tier).toBe('frontier');
  });

  // ─── code-review-writer (신규 role agent) ──────────────────

  it('loads code-review-writer role agent', () => {
    const registry = new RoleAgentRegistry(resolve('role-agents'));
    registry.loadAll();

    expect(registry.has('code-review-writer')).toBe(true);
  });

  it('code-review-writer has correct frontmatter fields', () => {
    const registry = new RoleAgentRegistry(resolve('role-agents'));
    registry.loadAll();

    const agent = registry.getByName('code-review-writer');
    expect(agent).toBeDefined();

    const fm = agent!.frontmatter;
    expect(fm.name).toBe('code-review-writer');
    expect(fm.role).toBe(true);
    expect(fm.tier).toBe('standard');
    expect(fm.pipeline).toBe('execute');
    expect(fm.description).toBeTruthy();
    expect(Array.isArray(fm.domain)).toBe(true);
    expect(fm.domain).toContain('code-review');
    expect(fm.domain).toContain('pr-review');

    // systemPrompt가 비어있지 않아야 함
    expect(agent!.systemPrompt.trim().length).toBeGreaterThan(0);
  });

  it('getByDomain("pr-review") includes code-review-writer', () => {
    const registry = new RoleAgentRegistry(resolve('role-agents'));
    registry.loadAll();

    const agents = registry.getByDomain('pr-review');
    expect(agents.some((a) => a.frontmatter.name === 'code-review-writer')).toBe(true);
  });

  it('getByDomain("code-review") includes code-review-writer', () => {
    const registry = new RoleAgentRegistry(resolve('role-agents'));
    registry.loadAll();

    const agents = registry.getByDomain('code-review');
    expect(agents.some((a) => a.frontmatter.name === 'code-review-writer')).toBe(true);
  });
});

// ─── Review Agents (review-agents/ 디렉토리) ─────────────────

describe('RoleAgentRegistry: review-agents loading', () => {
  function loadWithReview(): RoleAgentRegistry {
    // 생성자: (builtinDir, customDir?, reviewDir?)
    const registry = new RoleAgentRegistry(
      resolve('role-agents'),
      undefined,
      resolve('review-agents'),
    );
    registry.loadAll();
    return registry;
  }

  it('getByPipeline("review") includes frontend-reviewer', () => {
    const registry = loadWithReview();

    const reviewAgents = registry.getByPipeline('review');
    expect(reviewAgents.some((a) => a.frontmatter.name === 'frontend-reviewer')).toBe(true);
  });

  it('loads all 4 review agents (quality/security/performance/frontend)', () => {
    const registry = loadWithReview();

    const reviewNames = registry.getByPipeline('review').map((a) => a.frontmatter.name);
    expect(reviewNames).toContain('quality-reviewer');
    expect(reviewNames).toContain('security-reviewer');
    expect(reviewNames).toContain('performance-reviewer');
    expect(reviewNames).toContain('frontend-reviewer');
    expect(reviewNames.length).toBeGreaterThanOrEqual(4);
  });

  it('every review agent has pipeline=review', () => {
    const registry = loadWithReview();

    const reviewAgents = registry.getByPipeline('review');
    expect(reviewAgents.length).toBeGreaterThanOrEqual(4);
    expect(reviewAgents.every((a) => a.frontmatter.pipeline === 'review')).toBe(true);
  });

  it('frontend-reviewer is matchable by frontend domains', () => {
    const registry = loadWithReview();

    for (const domain of ['react', 'a11y', 'web-vitals']) {
      const agents = registry.getByDomain(domain);
      expect(agents.some((a) => a.frontmatter.name === 'frontend-reviewer')).toBe(true);
    }
  });

  it('frontend-reviewer is not loaded when reviewDir is omitted', () => {
    // 회귀 가드: review-agents는 reviewDir 지정 시에만 로드되어야 한다
    const registry = new RoleAgentRegistry(resolve('role-agents'));
    registry.loadAll();

    expect(registry.has('frontend-reviewer')).toBe(false);
  });
});

// ─── Persona Agents (personas/ 디렉토리) ────────────────────

describe('RoleAgentRegistry: personas loading', () => {
  function loadWithPersonas(): RoleAgentRegistry {
    // 생성자: (builtinDir, customDir?, reviewDir?, personasDir?)
    const registry = new RoleAgentRegistry(
      resolve('role-agents'),
      undefined,
      undefined,
      resolve('personas'),
    );
    registry.loadAll();
    return registry;
  }

  it('getByName("medicine-seller") returns the persona', () => {
    const registry = loadWithPersonas();

    const agent = registry.getByName('medicine-seller');
    expect(agent).toBeDefined();
    expect(agent!.frontmatter.name).toBe('medicine-seller');
    expect(agent!.frontmatter.pipeline).toBe('persona');
  });

  it('getByName("trickster") returns the persona', () => {
    const registry = loadWithPersonas();

    const agent = registry.getByName('trickster');
    expect(agent).toBeDefined();
    expect(agent!.frontmatter.name).toBe('trickster');
    expect(agent!.frontmatter.pipeline).toBe('persona');
  });

  it('getByPipeline("persona") returns exactly 2 personas', () => {
    const registry = loadWithPersonas();

    const personas = registry.getByPipeline('persona');
    expect(personas.length).toBe(2);

    const names = personas.map((a) => a.frontmatter.name).sort();
    expect(names).toEqual(['medicine-seller', 'trickster']);
  });

  it('every persona agent has pipeline=persona', () => {
    const registry = loadWithPersonas();

    const personas = registry.getByPipeline('persona');
    expect(personas.every((a) => a.frontmatter.pipeline === 'persona')).toBe(true);
  });

  it('personas are not loaded when personasDir is omitted', () => {
    // 회귀 가드: personas는 personasDir 지정 시에만 로드되어야 한다
    const registry = new RoleAgentRegistry(resolve('role-agents'));
    registry.loadAll();

    expect(registry.has('medicine-seller')).toBe(false);
    expect(registry.has('trickster')).toBe(false);
    expect(registry.getByPipeline('persona').length).toBe(0);
  });

  it('isolates persona from execute/review pipelines', () => {
    // builtin role-agents (execute) + review-agents (review) + personas (persona) 모두 로드
    const registry = new RoleAgentRegistry(
      resolve('role-agents'),
      undefined,
      resolve('review-agents'),
      resolve('personas'),
    );
    registry.loadAll();

    const personaNames = registry.getByPipeline('persona').map((a) => a.frontmatter.name);
    const executeNames = registry.getByPipeline('execute').map((a) => a.frontmatter.name);
    const reviewNames = registry.getByPipeline('review').map((a) => a.frontmatter.name);

    // persona는 정확히 2개
    expect(personaNames.sort()).toEqual(['medicine-seller', 'trickster']);

    // persona가 다른 파이프라인에 섞이지 않음
    expect(executeNames).not.toContain('medicine-seller');
    expect(executeNames).not.toContain('trickster');
    expect(reviewNames).not.toContain('medicine-seller');
    expect(reviewNames).not.toContain('trickster');

    // 다른 파이프라인 에이전트가 persona에 섞이지 않음
    expect(personaNames).not.toContain('frontend-developer');
    expect(personaNames).not.toContain('frontend-reviewer');

    // 세 파이프라인 간 이름 교집합 없음
    const personaSet = new Set(personaNames);
    expect(executeNames.some((n) => personaSet.has(n))).toBe(false);
    expect(reviewNames.some((n) => personaSet.has(n))).toBe(false);
  });
});

// ─── RoleMatchEngine ────────────────────────────────────────

describe('RoleMatchEngine', () => {
  it('generates match context with all available agents', () => {
    const registry = new RoleAgentRegistry(resolve('role-agents'));
    registry.loadAll();

    const engine = new RoleMatchEngine();
    const context = engine.generateMatchContext(
      'task-1',
      'React 컴포넌트 구현',
      'UserProfile 컴포넌트를 React로 구현',
      registry.getAll(),
    );

    expect(context.systemPrompt).toContain('role-agent matcher');
    expect(context.matchingPrompt).toContain('task-1');
    expect(context.matchingPrompt).toContain('React 컴포넌트 구현');
    expect(context.availableAgents.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── RolePromptGenerator ────────────────────────────────────

describe('RolePromptGenerator', () => {
  it('generates perspective prompts for matched agents', () => {
    const registry = new RoleAgentRegistry(resolve('role-agents'));
    registry.loadAll();

    const agents = [registry.getByName('frontend-developer')!, registry.getByName('designer')!];

    const generator = new RolePromptGenerator();
    const prompts = generator.generatePerspectivePrompts(
      'UI 컴포넌트 구현',
      'UserProfile 컴포넌트를 구현',
      agents,
    );

    expect(prompts.length).toBe(2);
    expect(prompts[0].agentName).toBe('frontend-developer');
    expect(prompts[0].systemPrompt).toContain('Frontend Developer');
    expect(prompts[1].agentName).toBe('designer');
  });
});

// ─── RoleConsensusEngine ────────────────────────────────────

describe('RoleConsensusEngine', () => {
  it('generates synthesis context from perspectives', () => {
    const perspectives: RolePerspective[] = [
      { agentName: 'frontend-developer', perspective: 'Use React hooks', confidence: 0.9 },
      { agentName: 'designer', perspective: 'Follow design system', confidence: 0.85 },
    ];

    const engine = new RoleConsensusEngine();
    const context = engine.generateSynthesisContext(
      'UI 구현',
      '사용자 프로필 컴포넌트',
      perspectives,
    );

    expect(context.systemPrompt).toContain('consensus synthesizer');
    expect(context.synthesisPrompt).toContain('frontend-developer');
    expect(context.synthesisPrompt).toContain('designer');
    expect(context.synthesisPrompt).toContain('2 role agents');
  });
});
