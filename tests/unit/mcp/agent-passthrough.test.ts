import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { AgentRegistry } from '../../../src/agent/registry.js';
import { RoleAgentRegistry } from '../../../src/agent/role-agent-registry.js';
import { handleAgentPassthrough } from '../../../src/mcp/tools/agent-passthrough.js';

function loadRoleRegistry(): RoleAgentRegistry {
  const registry = new RoleAgentRegistry(
    resolve('role-agents'),
    undefined,
    resolve('review-agents'),
    resolve('personas'),
  );
  registry.loadAll();
  return registry;
}

function loadPrincipleRegistry(): AgentRegistry {
  const registry = new AgentRegistry(resolve('agents'));
  registry.loadAll();
  return registry;
}

describe('handleAgentPassthrough: get', () => {
  it('resolves a role agent from the role registry', () => {
    const roleReg = loadRoleRegistry();

    const raw = handleAgentPassthrough(roleReg, { action: 'get', name: 'code-review-writer' });
    const res = JSON.parse(raw);

    expect(res.status).toBe('ok');
    expect(res.name).toBe('code-review-writer');
    expect(res.systemPrompt.trim().length).toBeGreaterThan(0);
  });

  it('falls back to the principle registry for continuity-judge', () => {
    const roleReg = loadRoleRegistry();
    const principleReg = loadPrincipleRegistry();

    const raw = handleAgentPassthrough(
      roleReg,
      { action: 'get', name: 'continuity-judge' },
      principleReg,
    );
    const res = JSON.parse(raw);

    expect(res.status).toBe('ok');
    expect(res.name).toBe('continuity-judge');
    expect(res.pipeline).toBe('evaluate');
    expect(res.systemPrompt.trim().length).toBeGreaterThan(0);
  });

  it('does not resolve continuity-judge without the principle registry (fallback is required)', () => {
    const roleReg = loadRoleRegistry();

    const raw = handleAgentPassthrough(roleReg, { action: 'get', name: 'continuity-judge' });
    const res = JSON.parse(raw);

    expect(res.error).toContain("'continuity-judge' not found");
  });

  it('lists both registries in available when an unknown agent is requested', () => {
    const roleReg = loadRoleRegistry();
    const principleReg = loadPrincipleRegistry();

    const raw = handleAgentPassthrough(
      roleReg,
      { action: 'get', name: 'does-not-exist' },
      principleReg,
    );
    const res = JSON.parse(raw);

    expect(res.error).toContain('not found');
    // role registry entry
    expect(res.available).toContain('code-review-writer');
    // principle registry entry (only present via fallback enumeration)
    expect(res.available).toContain('continuity-judge');
  });
});
