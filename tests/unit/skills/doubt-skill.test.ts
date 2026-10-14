import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/parser.js';
import {
  agentBlocksWithoutEffort,
  agentBlocksWithoutModel,
} from '../../../scripts/verify-rule-refs.js';

const PATH = resolve('plugin/skills/doubt/SKILL.md');
const raw = readFileSync(PATH, 'utf-8');
const skill = parseSkillMd(raw, PATH);

// 템플릿 코드펜스 안에도 `## 산출물` 같은 줄이 있어서 펜스 밖의 `## `만 절 경계로 본다
function section(heading: string): string {
  const lines = skill.body.split('\n');
  const out: string[] = [];
  let inFence = false;
  let inside = false;
  for (const line of lines) {
    if (line.startsWith('```')) inFence = !inFence;
    if (!inFence && line.startsWith('## ')) {
      if (inside) break;
      inside = line === `## ${heading}`;
    }
    if (inside) out.push(line);
  }
  return out.join('\n');
}

describe('doubt 스킬', () => {
  it('이름과 핵심 트리거를 frontmatter에 갖는다', () => {
    expect(skill.frontmatter.name).toBe('doubt');
    for (const trigger of ['doubt', '의심해줘', '반박해줘']) {
      expect(skill.frontmatter.triggers).toContain(trigger);
    }
  });

  it('description이 다른 자리(continuity-judge, review)로 가는 길을 안내한다', () => {
    expect(skill.frontmatter.description).toContain('continuity-judge');
    expect(skill.frontmatter.description).toContain('review');
  });

  it('routing.note가 자동 발동 범위를 좁힌다', () => {
    const note = skill.frontmatter.routing?.note ?? '';
    for (const scope of [
      '배포',
      '데이터 마이그레이션',
      '공개 API 변경',
      '보안 성질',
      '분기 로직',
    ]) {
      expect(note).toContain(scope);
    }
  });

  it('단계와 멈춤 조건 절을 모두 갖는다', () => {
    for (const heading of [
      '1단계: 주장을 적는다',
      '2단계: 산출물과 계약만 떼어낸다',
      '3단계: 반박 리뷰어를 띄운다',
      '4단계: 결과를 분류한다',
      '5단계: 멈춘다',
    ]) {
      expect(section(heading), heading).not.toBe('');
    }
  });

  it('결과를 반영, 기각, 정보 부족 셋으로 나눈다', () => {
    const classify = section('4단계: 결과를 분류한다');
    for (const label of ['반영', '근거 있는 기각', '정보 부족']) {
      expect(classify).toContain(label);
    }
  });

  it('멈춤 조건에 사소한 의견, 세 회차, 사용자 중단이 있다', () => {
    const stop = section('5단계: 멈춘다');
    expect(stop).toContain('사소한 의견');
    expect(stop).toContain('세 회차');
    expect(stop).toContain('사용자가 그만하라고');
  });

  it('반박 템플릿에 산출물과 계약 자리만 있고 주장 자리는 없다', () => {
    const doubtStep = section('3단계: 반박 리뷰어를 띄운다');
    expect(doubtStep).toContain('### 반박 리뷰어 프롬프트 템플릿');
    expect(doubtStep).toContain('<산출물>');
    expect(doubtStep).toContain('<계약>');
    expect(doubtStep).toContain('주장은 넣지 않는다');
    expect(doubtStep).not.toContain('<주장>');
  });

  it('서브에이전트 안에서 쓰지 않는 규칙과 메인 세션에 올리는 블록이 있다', () => {
    const nested = section('서브에이전트 안에서는 쓰지 않는다');
    expect(nested).toContain('메인 세션 전용');
    expect(nested).toContain('## 의심 요청');
    expect(nested).toContain('스스로 반박해 보는 걸로 대신하지 않는다');
  });

  it('변명 표가 두 열이고 네 줄에서 여섯 줄 사이다', () => {
    const excuses = section('단계를 건너뛰고 싶어질 때');
    expect(excuses).toContain('| 변명 | 반박 |');
    const rows = excuses.split('\n').filter((line) => line.startsWith('| "'));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.length).toBeLessThanOrEqual(6);
  });

  it('모델 별칭을 본문에 박지 않고 tierModels에서 읽는다', () => {
    expect(raw).not.toMatch(/\b(opus|sonnet|haiku)\b/i);
    expect(raw).toContain('tierModels');
  });

  it('Agent 블록마다 model과 effort 줄이 있다', () => {
    expect(agentBlocksWithoutModel(raw)).toEqual([]);
    expect(agentBlocksWithoutEffort(raw)).toEqual([]);
  });

  it('본문 링크 대상 파일이 실제로 있다', () => {
    const targets = [
      '../_shared/agent-model.md',
      '../_shared/tool-availability.md',
      '../review/SKILL.md',
    ];
    for (const target of targets) {
      expect(raw).toContain(target);
      expect(existsSync(resolve(dirname(PATH), target)), target).toBe(true);
    }
  });

  it('라우팅 표에 doubt 행이 있다', () => {
    const routing = readFileSync(resolve('plugin/skills/_shared/proactive-routing.md'), 'utf-8');
    expect(routing).toMatch(/\|\s*`doubt` 스킬 사용/);
  });

  it('README 두 곳의 스킬 표에 doubt 행이 있다', () => {
    for (const readme of ['README.md', 'README.ko.md']) {
      expect(readFileSync(resolve(readme), 'utf-8'), readme).toContain('| `/doubt` |');
    }
  });
});
