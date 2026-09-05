import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/parser.js';
import { AUDIENCES } from '../../../src/explain/index.js';

const PATH = resolve('plugin/skills/explain/SKILL.md');
const raw = readFileSync(PATH, 'utf-8');
const skill = parseSkillMd(raw, PATH);

describe('explain 스킬', () => {
  it('frontmatter가 스킬 형식을 지킨다', () => {
    expect(skill.frontmatter.name).toBe('explain');
    expect(skill.frontmatter.version).toBe('1.0.0');
    expect(Object.keys(skill.frontmatter.inputs).sort()).toEqual(['audience', 'depth', 'source']);
    expect(skill.frontmatter.outputs).toContain('explanation');
  });

  it('description이 explainer 에이전트와의 경계를 밝힌다', () => {
    expect(skill.frontmatter.description).toContain('explainer 에이전트를 직접 호출한다');
  });

  it('설명 요청과 대상 지정을 둘 다 잡는 트리거가 있다', () => {
    expect(skill.frontmatter.triggers).toContain('쉽게 풀어줘');
    expect(skill.frontmatter.triggers).toContain('ELI5');
    expect(skill.frontmatter.triggers).toContain('한테 설명');
  });

  it('대상 여섯 개를 본문이 모두 적는다', () => {
    for (const audience of AUDIENCES) {
      expect(skill.body).toContain(`\`${audience}\``);
    }
  });

  it('판정 단계가 explain-check를 부른다', () => {
    expect(skill.body).toContain('gestalt explain-check --source');
    expect(skill.body).toContain('--audience');
  });

  it('메인 세션에서 에이전트를 직접 안 부른다고 적어 둔다', () => {
    expect(skill.body).toContain('서브에이전트에 위임한다');
    expect(skill.body).toContain('agent-delegation.md');
  });

  it('라우팅 표가 스킬과 에이전트를 갈라 적는다', () => {
    const routing = readFileSync(resolve('plugin/skills/_shared/proactive-routing.md'), 'utf-8');
    expect(routing).toMatch(/\|\s*`explain` 스킬 사용/);
    expect(routing).toMatch(/\|\s*`explainer` 에이전트\s*\|/);
  });
});
