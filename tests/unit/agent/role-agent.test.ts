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

    const all = registry.getAll();
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
    expect(all.length).toBe(9);
    expect(registry.has('frontend-developer')).toBe(true);
    expect(registry.has('backend-developer')).toBe(true);
    expect(registry.has('architect')).toBe(true);
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
    expect(context.availableAgents.length).toBe(9);
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
