import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RoleAgentRegistry } from '../../../src/agent/role-agent-registry.js';

const AGENT_DIR = resolve('plugin/role-agents/explainer');
const AUDIENCES = ['nontech', 'junior', 'peer', 'manager', 'exec', 'outsider'];

describe('explainer 에이전트', () => {
  const registry = new RoleAgentRegistry(resolve('plugin/role-agents'));
  registry.loadAll();
  const agent = registry.getByName('explainer');

  it('레지스트리가 읽어 들인다', () => {
    expect(agent).toBeDefined();
    expect(agent!.frontmatter.tier).toBe('standard');
    expect(agent!.frontmatter.pipeline).toBe('execute');
    expect(agent!.frontmatter.role).toBe(true);
    expect(agent!.frontmatter.domain).toContain('explain');
  });

  it('기본 대상이 peer라고 적혀 있다', () => {
    expect(agent!.systemPrompt).toMatch(/기본값?\s*은?\s*\*\*`peer`\*\*|`peer`\*\* ?다/);
  });

  it('대상 여섯 개를 audience.md가 모두 다룬다', () => {
    const doc = readFileSync(resolve(AGENT_DIR, 'references/audience.md'), 'utf-8');
    for (const audience of AUDIENCES) {
      expect(doc).toContain(`\`${audience}\``);
    }
  });

  it('라우팅 표가 explainer를 가리킨다', () => {
    const routing = readFileSync(resolve('plugin/skills/_shared/proactive-routing.md'), 'utf-8');
    expect(routing).toMatch(/\|\s*`explainer`\s*\|/);
  });
});
