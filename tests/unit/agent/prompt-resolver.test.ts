import { describe, it, expect } from 'vitest';
import { resolveAgentPrompt, mergeSystemPrompt, getActiveAgentNames } from '../../../src/agent/prompt-resolver.js';
import { AgentRegistry } from '../../../src/agent/registry.js';
import { resolve } from 'node:path';

const FIXTURE_AGENTS_DIR = resolve('tests/fixtures/agents');

function loadedRegistry(): AgentRegistry {
  const registry = new AgentRegistry(FIXTURE_AGENTS_DIR);
  registry.loadAll();
  return registry;
}

describe('resolveAgentPrompt', () => {
  it('returns undefined when no registry', () => {
    expect(resolveAgentPrompt(undefined, 'interview')).toBeUndefined();
  });

  it('returns undefined when no matching agents', () => {
    const registry = loadedRegistry();
    expect(resolveAgentPrompt(registry, 'execute')).toBeUndefined();
  });

  it('returns agent systemPrompt for matching pipeline', () => {
    const registry = loadedRegistry();
    const prompt = resolveAgentPrompt(registry, 'interview');
    expect(prompt).toBeDefined();
    expect(prompt).toContain('mock agent for testing');
  });
});

describe('mergeSystemPrompt', () => {
  const BASE = 'You are a base system prompt.';

  it('returns base prompt when no registry', () => {
    expect(mergeSystemPrompt(BASE, undefined, 'interview')).toBe(BASE);
  });

  it('returns base prompt when no matching agents', () => {
    const registry = loadedRegistry();
    expect(mergeSystemPrompt(BASE, registry, 'execute')).toBe(BASE);
  });

  it('merges base + agent prompt for matching pipeline', () => {
    const registry = loadedRegistry();
    const merged = mergeSystemPrompt(BASE, registry, 'interview');
    expect(merged).toContain(BASE);
    expect(merged).toContain('## Agent Persona');
    expect(merged).toContain('mock agent for testing');
  });
});

describe('getActiveAgentNames', () => {
  it('returns empty array when no registry', () => {
    expect(getActiveAgentNames(undefined, 'interview')).toEqual([]);
  });

  it('returns agent names for matching pipeline', () => {
    const registry = loadedRegistry();
    expect(getActiveAgentNames(registry, 'interview')).toEqual(['mock-agent']);
  });

  it('returns empty array for non-matching pipeline', () => {
    const registry = loadedRegistry();
    expect(getActiveAgentNames(registry, 'spec')).toEqual([]);
  });
});
