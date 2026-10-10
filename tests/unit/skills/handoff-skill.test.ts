import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/parser.js';
import { agentBlocksWithoutModel } from '../../../scripts/verify-rule-refs.js';

const PATH = resolve('plugin/skills/handoff/SKILL.md');
const DISPATCH_PATH = resolve('plugin/skills/dispatch/SKILL.md');
const raw = readFileSync(PATH, 'utf-8');
const skill = parseSkillMd(raw, PATH);
const dispatchRaw = readFileSync(DISPATCH_PATH, 'utf-8');
const dispatch = parseSkillMd(dispatchRaw, DISPATCH_PATH);

describe('handoff 스킬', () => {
  it('이름과 핵심 트리거를 frontmatter에 갖는다', () => {
    expect(skill.frontmatter.name).toBe('handoff');
    for (const trigger of ['handoff', '핸드오프', '워크트리로 넘겨']) {
      expect(skill.frontmatter.triggers).toContain(trigger);
    }
  });

  it('routing.note가 있어서 라우팅 표에 오른다', () => {
    expect(skill.frontmatter.routing?.note?.trim()).toBeTruthy();
  });

  it('트리거가 dispatch 스킬과 하나도 겹치지 않는다', () => {
    const overlap = skill.frontmatter.triggers.filter((t) =>
      dispatch.frontmatter.triggers.includes(t),
    );
    expect(overlap).toEqual([]);
  });

  it('본문이 공용 문서와 dispatch로 가는 링크를 갖는다', () => {
    expect(skill.body).toContain('../_shared/agent-model.md');
    expect(skill.body).toContain('../_shared/agent-delegation.md');
    expect(skill.body).toContain('../dispatch/SKILL.md');
  });

  it('오르카 명령의 기준을 orca skills get orca-cli로 가리킨다', () => {
    expect(skill.body).toContain('orca skills get orca-cli');
  });

  it('본문 링크 대상 파일이 실제로 있다', () => {
    const targets = [
      '../_shared/agent-model.md',
      '../_shared/agent-delegation.md',
      '../dispatch/SKILL.md',
    ];
    for (const target of targets) {
      expect(existsSync(resolve(dirname(PATH), target)), target).toBe(true);
    }
  });

  it('라우팅 표에 handoff 행이 있다', () => {
    const routing = readFileSync(resolve('plugin/skills/_shared/proactive-routing.md'), 'utf-8');
    expect(routing).toMatch(/\|\s*`handoff` 스킬 사용/);
  });

  it('dispatch 스킬이 handoff를 언급한다', () => {
    expect(dispatchRaw).toContain('handoff');
  });

  it('Agent 블록마다 model 줄이 있다', () => {
    expect(agentBlocksWithoutModel(raw)).toEqual([]);
  });
});
