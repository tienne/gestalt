import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { AgentRegistry } from '../../../src/agent/registry.js';
import { RoleAgentRegistry } from '../../../src/agent/role-agent-registry.js';
import { handleAgentPassthrough } from '../../../src/mcp/tools/agent-passthrough.js';

function loadRoleRegistry(): RoleAgentRegistry {
  const registry = new RoleAgentRegistry(
    resolve('plugin/role-agents'),
    undefined,
    resolve('plugin/review-agents'),
    resolve('plugin/personas'),
  );
  registry.loadAll();
  return registry;
}

function loadPrincipleRegistry(): AgentRegistry {
  const registry = new AgentRegistry(resolve('plugin/agents'));
  registry.loadAll();
  return registry;
}

describe('handleAgentPassthrough: tier → model', () => {
  it('frontier 에이전트는 opus로 해석한다', () => {
    const raw = handleAgentPassthrough(loadRoleRegistry(), { action: 'get', name: 'architect' });
    const res = JSON.parse(raw);

    expect(res.tier).toBe('frontier');
    expect(res.model).toBe('opus');
  });

  it('standard 에이전트는 sonnet으로 해석한다', () => {
    const raw = handleAgentPassthrough(loadRoleRegistry(), {
      action: 'get',
      name: 'humanize-monolith',
    });
    const res = JSON.parse(raw);

    expect(res.tier).toBe('standard');
    expect(res.model).toBe('sonnet');
  });

  it('frugal 에이전트는 haiku로 해석한다', () => {
    const raw = handleAgentPassthrough(
      loadRoleRegistry(),
      { action: 'get', name: 'proximity-worker' },
      loadPrincipleRegistry(),
    );
    const res = JSON.parse(raw);

    expect(res.tier).toBe('frugal');
    expect(res.model).toBe('haiku');
  });

  it('설정으로 표를 바꾸면 그 값을 쓴다', () => {
    const raw = handleAgentPassthrough(
      loadRoleRegistry(),
      { action: 'get', name: 'architect' },
      undefined,
      { frugal: 'haiku', standard: 'sonnet', frontier: 'fable' },
    );
    const res = JSON.parse(raw);

    expect(res.model).toBe('fable');
  });
});

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

interface ListEntry {
  name: string;
  description: string;
  domain: string[];
  tier: string;
  model: string;
  systemPrompt?: string;
}

type ListGroups = Record<'role' | 'review' | 'persona' | 'principle', ListEntry[]>;

function listAgents(tierModels?: Record<'frugal' | 'standard' | 'frontier', string>) {
  const raw = handleAgentPassthrough(
    loadRoleRegistry(),
    { action: 'list' },
    loadPrincipleRegistry(),
    tierModels,
  );
  return JSON.parse(raw) as { status: string; total: number; groups: ListGroups };
}

function findEntry(groups: ListGroups, name: string): ListEntry | undefined {
  return Object.values(groups)
    .flat()
    .find((e) => e.name === name);
}

describe('handleAgentPassthrough: list', () => {
  it('모든 항목의 model은 표에서 tier로 찾은 값이다', () => {
    const res = listAgents();
    const table: Record<string, string> = { frugal: 'haiku', standard: 'sonnet', frontier: 'opus' };
    const entries = Object.values(res.groups).flat();

    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.model).toBe(table[e.tier]);
    }
  });

  it('유형별 대표 에이전트의 tier와 model을 돌려준다', () => {
    const { groups } = listAgents();

    expect(findEntry(groups, 'architect')).toMatchObject({ tier: 'frontier', model: 'opus' });
    expect(findEntry(groups, 'security-reviewer')).toMatchObject({
      tier: 'standard',
      model: 'sonnet',
    });
    expect(findEntry(groups, 'trickster')).toMatchObject({ tier: 'standard', model: 'sonnet' });
  });

  it('설정으로 바꾼 표가 list에도 반영된다', () => {
    const { groups } = listAgents({ frugal: 'haiku', standard: 'sonnet', frontier: 'fable' });

    expect(findEntry(groups, 'architect')?.model).toBe('fable');
  });

  it('principle 그룹에 원리 에이전트가 들어간다', () => {
    const { groups } = listAgents();
    const names = groups.principle.map((e) => e.name);

    expect(names).toContain('continuity-judge');
    expect(names).toContain('proximity-worker');
    expect(findEntry(groups, 'continuity-judge')).toMatchObject({
      tier: 'frontier',
      model: 'opus',
    });
    expect(findEntry(groups, 'proximity-worker')).toMatchObject({ tier: 'frugal', model: 'haiku' });
  });

  it('원리 레지스트리가 없으면 principle 그룹은 빈 배열이다', () => {
    const raw = handleAgentPassthrough(loadRoleRegistry(), { action: 'list' });
    const res = JSON.parse(raw) as { groups: ListGroups };

    expect(res.groups.principle).toEqual([]);
  });

  it('total은 원리 에이전트를 세지 않는다', () => {
    const res = listAgents();

    expect(res.total).toBe(loadRoleRegistry().getAll().length);
  });

  it('list 항목에는 systemPrompt가 없다', () => {
    const entries = Object.values(listAgents().groups).flat();

    for (const e of entries) {
      expect(Object.keys(e).sort()).toEqual(['description', 'domain', 'model', 'name', 'tier']);
    }
  });

  it('같은 이름이면 list와 get의 tier와 model이 같다', () => {
    const { groups } = listAgents();
    const roleReg = loadRoleRegistry();
    const principleReg = loadPrincipleRegistry();

    for (const e of Object.values(groups).flat()) {
      const got = JSON.parse(
        handleAgentPassthrough(roleReg, { action: 'get', name: e.name }, principleReg),
      ) as { tier: string; model: string };
      expect({ tier: got.tier, model: got.model }).toEqual({ tier: e.tier, model: e.model });
    }
  });
});

describe('handleAgentPassthrough: get 응답 키 순서', () => {
  it('기존 순서를 유지한다', () => {
    const res = JSON.parse(
      handleAgentPassthrough(loadRoleRegistry(), { action: 'get', name: 'architect' }),
    ) as Record<string, unknown>;

    expect(Object.keys(res)).toEqual([
      'status',
      'name',
      'description',
      'domain',
      'pipeline',
      'tier',
      'model',
      'systemPrompt',
    ]);
  });
});
