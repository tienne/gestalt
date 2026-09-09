import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RoleAgentRegistry } from '../../../src/agent/role-agent-registry.js';

const WRITER_DIR = resolve('plugin/role-agents/code-review-writer');
const SKILL = readFileSync(resolve('plugin/skills/review/SKILL.md'), 'utf-8');

describe('리뷰 코멘트 audience 옵션', () => {
  const registry = new RoleAgentRegistry(resolve('plugin/role-agents'));
  registry.loadAll();
  const writer = registry.getByName('code-review-writer');

  it('code-review-writer가 대상 눈높이 절을 갖는다', () => {
    expect(writer).toBeDefined();
    expect(writer!.systemPrompt).toContain('### 대상 눈높이 (audience)');
  });

  it('값을 안 주면 peer라고 적혀 있다', () => {
    expect(writer!.systemPrompt).toMatch(/\*\*안 주면 `peer`\*\*/);
  });

  it('인라인 코멘트가 안 받는 대상 넷을 명시한다', () => {
    for (const audience of ['nontech', 'manager', 'exec', 'outsider']) {
      expect(writer!.systemPrompt).toContain(`\`${audience}\``);
    }
  });

  it('junior 절이 가리키는 explainer 대상표가 실제로 있다', () => {
    const link = writer!.systemPrompt.match(/\(([^)]*explainer\/references\/audience\.md)\)/);
    expect(link).not.toBeNull();
    expect(existsSync(resolve(WRITER_DIR, link![1]!))).toBe(true);
  });

  it('review 스킬이 audience 입력을 받는다', () => {
    expect(SKILL).toMatch(/^ {2}audience:$/m);
    expect(SKILL).toContain('peer | junior');
  });

  it('4.7단계가 서브에이전트에 audience를 넘긴다', () => {
    const step = SKILL.slice(SKILL.indexOf('### 4.7단계'));
    expect(step).toContain('audience: <peer | junior');
  });

  it('로컬 PR 경로에는 audience가 안 걸린다고 적혀 있다', () => {
    expect(SKILL).toContain('**`audience`는 이 경로에 안 걸립니다.**');
  });
});
