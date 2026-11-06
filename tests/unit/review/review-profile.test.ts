import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/parser.js';
import { section } from '../../helpers/skill-section.js';

const SKILL_PATH = resolve('plugin/skills/review/SKILL.md');
const skill = parseSkillMd(readFileSync(SKILL_PATH, 'utf-8'), SKILL_PATH);

/**
 * 프로필 값이 어디서 오는지가 곧 누가 리뷰 판정을 바꿀 수 있는지다. 스킬 문서가 다른 경로를
 * 열어 두면 로더를 아무리 좁혀도 소용없다.
 */
describe('review 스킬의 사용자 프로필', () => {
  const step0 = () => section(skill.body, '### 0단계: 미니 인터뷰 (reviewIntent 수집)');
  const profile = () => section(skill.body, '#### 사용자 프로필 읽기');

  it('0단계 안에서 질문보다 먼저 프로필을 읽는다', () => {
    expect(step0()).toContain('#### 사용자 프로필 읽기');
    expect(step0().indexOf('#### 사용자 프로필 읽기')).toBeLessThan(
      step0().indexOf('#### 질문 묶음'),
    );
    expect(profile()).toContain('gestalt profile show --json');
  });

  it('호출 인자가 프로필보다 앞서고 프로필이 기본값보다 앞선다', () => {
    const order = profile()
      .split('\n')
      .filter((l) => /^\d\. /.test(l));
    expect(order).toHaveLength(3);
    expect(order[0]).toMatch(/호출 인자/);
    expect(order[1]).toMatch(/프로필/);
    expect(order[2]).toMatch(/기본값/);
  });

  it('레포 파일이나 PR 본문으로는 프로필 값을 못 바꾼다', () => {
    expect(profile()).toMatch(/프로필은 이 명령으로만 읽습니다/);
    expect(profile()).toMatch(/`gestalt\.json`/);
    expect(profile()).toMatch(/PR 본문/);
  });

  it('못 읽어도 리뷰를 멈추지 않고 기본값으로 간다', () => {
    expect(profile()).toMatch(/기본값으로 진행/);
    expect(profile()).toMatch(/리뷰를 멈추지 않습니다/);
  });

  it('프로필에서 온 값을 리뷰 시작 보고에 한 줄로 밝히고 건너뛰기에 안 걸린다', () => {
    expect(profile()).toMatch(/리뷰 시작 보고에 한 줄로/);
    expect(profile()).toMatch(/프로필에서 가져온 값:/);
    expect(profile()).toMatch(/전체 건너뛰기에 함께 걸리지 않습니다/);
    // 프로필이 없는 사람에게 줄이 하나 늘면 기본 동작이 바뀐 셈이다
    expect(profile()).toMatch(/경고도 없으면 이 줄을 생략/);
  });

  it('0.5단계는 신호가 없을 때 프로필의 audience를 먼저 본다', () => {
    const step05 = section(skill.body, '### 0.5단계: audience 확정');
    expect(step05).toMatch(/아무 신호가 없으면[^\n]*프로필의 `audience`[^\n]*`peer`/);
  });

  it('게시만 따로 요청받은 경로도 프로필을 읽는다', () => {
    const entry = section(skill.body, '#### 게시 준비 (PR 식별, audience 확인)');
    expect(entry).toMatch(/프로필 값도 같은 이유로 없을 수 있습니다/);
    expect(entry).toContain('gestalt profile show --json');
  });
});
