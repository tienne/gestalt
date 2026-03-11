import { describe, it, expect } from 'vitest';
import { AgentRegistry } from '../../../src/agent/registry.js';
import { resolve } from 'node:path';

const FIXTURE_AGENTS_DIR = resolve('tests/fixtures/agents');

describe('AgentRegistry', () => {
  it('loads agents from directory', () => {
    const registry = new AgentRegistry(FIXTURE_AGENTS_DIR);
    registry.loadAll();

    expect(registry.has('mock-agent')).toBe(true);
    expect(registry.getAll()).toHaveLength(1);
  });

  it('retrieves an agent by name', () => {
    const registry = new AgentRegistry(FIXTURE_AGENTS_DIR);
    registry.loadAll();

    const agent = registry.get('mock-agent');
    expect(agent).toBeDefined();
    expect(agent!.frontmatter.name).toBe('mock-agent');
  });

  it('returns undefined for unknown agent', () => {
    const registry = new AgentRegistry(FIXTURE_AGENTS_DIR);
    registry.loadAll();

    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('handles non-existent directory gracefully', () => {
    const registry = new AgentRegistry('/nonexistent/path');
    registry.loadAll();
    expect(registry.getAll()).toHaveLength(0);
  });

  it('filters agents by pipeline', () => {
    const registry = new AgentRegistry(FIXTURE_AGENTS_DIR);
    registry.loadAll();

    const interviewAgents = registry.getByPipeline('interview');
    expect(interviewAgents).toHaveLength(1);
    expect(interviewAgents[0].frontmatter.name).toBe('mock-agent');

    const executeAgents = registry.getByPipeline('execute');
    expect(executeAgents).toHaveLength(0);
  });
});
