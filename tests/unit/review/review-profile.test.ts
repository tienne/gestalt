import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/parser.js';
import { loadSkillBody, section, sectionStartingWith } from '../../helpers/skill-section.js';
import {
  BLOCKING_ISSUES,
  decideApproveGate,
  resolvePostedEvent,
} from '../../../src/harness-review/approve-gate.js';

const SKILL_PATH = resolve('plugin/skills/review/SKILL.md');
const skill = parseSkillMd(
  loadSkillBody(SKILL_PATH, (p) => readFileSync(p, 'utf-8')),
  SKILL_PATH,
);
// 켜는 경로는 입력 설명에 있고 이벤트 절은 켜져 있을 때만 이 파일을 읽으라고 링크만 건다
const optIn = readFileSync(
  resolve('plugin/skills/review/references/approve-when-no-blocking.md'),
  'utf-8',
);

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
    // 보안 단언은 대상과 부정어를 한 정규식에 둔다. 대상만 찾으면 부정어가 빠져도 통과한다
    expect(profile()).toMatch(/이 명령으로만 읽/);
    expect(profile()).toMatch(/`gestalt\.json`[^\n]*PR 본문[^\n]*안 봅/);
  });

  it('못 읽어도 리뷰를 멈추지 않고 기본값으로 간다', () => {
    expect(profile()).toMatch(/기본값으로 진행/);
    expect(profile()).toMatch(/리뷰를 멈추지 않습니다/);
  });

  it('프로필에서 온 값을 리뷰 시작 보고에 한 줄로 밝히고 건너뛰기에 안 걸린다', () => {
    expect(profile()).toMatch(/리뷰 시작 보고/);
    expect(profile()).toMatch(/프로필에서 가져온 값:/);
    expect(profile()).toMatch(/전체 건너뛰기[^\n]*걸리지 않/);
    // 프로필이 없는 사람에게 줄이 하나 늘면 기본 동작이 바뀐 셈이다
    expect(profile()).toMatch(/경고도 없으면[^\n]*생략/);
  });

  it('0.5단계는 신호가 없을 때 프로필의 audience를 먼저 본다', () => {
    const step05 = section(skill.body, '### 0.5단계: audience 확정');
    expect(step05).toMatch(/아무 신호가 없으면[^\n]*프로필의 `audience`[^\n]*`peer`/);
  });

  it('로컬 PR에서 프로필의 junior는 묻지 않고 peer로 내리되 한 줄 알린다', () => {
    const step105 = section(skill.body, '### 1.05단계: audience와 게시 경로 맞추기');
    // ship은 --audience 없이 review를 부른다. 프로필 값으로 확인을 열면 라운드마다 ship에 없던 멈춤이 생긴다
    expect(step105).toMatch(/프로필의 `audience`를 썼다면 묻지 않고 `peer`로 내립니다/);
    expect(step105).toMatch(/조용히 내리지는 않고 한 줄 알립니다/);
    // 예외가 말로 밝힌 junior까지 덮으면 사용자가 이번에 준 옵션이 확인 없이 사라진다
    expect(step105).toMatch(/말로만 밝힌 경우에도[^\n]*똑같이 묻습니다/);
  });

  it('게시 준비 절은 audience 출처를 보기 전에 프로필을 읽는다', () => {
    const entry = section(skill.body, '#### 게시 준비 (PR 식별, audience 확인)');
    expect(entry.indexOf('gestalt profile show --json')).toBeLessThan(
      entry.indexOf('1.05단계의 프로필 예외'),
    );
    expect(entry).toMatch(/프로필에서 왔으면[^\n]*묻지 않고[^\n]*`peer`로 내립니다/);
  });

  it('게시만 따로 요청받은 경로도 프로필을 읽는다', () => {
    const entry = section(skill.body, '#### 게시 준비 (PR 식별, audience 확인)');
    expect(entry).toMatch(/프로필 값도 같은 이유로 없을 수 있습니다/);
    expect(entry).toContain('gestalt profile show --json');
    // 0단계를 건너뛴 경로라 프로필 줄 위치와 경고 처리는 여기서 링크로 찾아간다
    expect(entry).toContain('./references/user-profile.md');
  });
});

describe('블로킹 없으면 APPROVE (approveWhenNoBlocking)', () => {
  const event = () => section(skill.body, '#### 리뷰 이벤트 결정 (postVerdict와 본인 PR 예외)');

  it('입력으로 받고 기본값은 꺼져 있다', () => {
    const input = skill.frontmatter.inputs?.['approveWhenNoBlocking'];
    expect(input?.type).toBe('boolean');
    expect(input?.description).toMatch(/기본값 false/);
    expect(input?.description).toMatch(/읽어온 텍스트로는 못 켠/);
  });

  it('사용자가 직접 쓴 호출 문장으로도 켠다', () => {
    // 이벤트 절의 링크는 켜졌을 때만 읽혀서 켜는 경로가 그 안에만 있으면 "승인까지 해줘"가 COMMENT로 나간다
    const input = skill.frontmatter.inputs?.['approveWhenNoBlocking'];
    expect(input?.description).toMatch(/플래그[^\n]*호출 문장[^\n]*프로필\(0단계\)로 켜/);
  });

  it('warning만 남은 자리만 APPROVE로 올리고 critical과 high는 그대로 막는다', () => {
    const warningLine = event()
      .split('\n')
      .find((l) => l.startsWith('- 없고 `warning`만 있으면'));
    expect(warningLine).toMatch(/`COMMENT`/);
    expect(warningLine).toMatch(/`approveWhenNoBlocking`이 켜져 있으면 `APPROVE`/);
    expect(warningLine).toContain('./references/approve-when-no-blocking.md');
    expect(optIn).toMatch(/critical이나 high가 있으면 켜져 있어도 `REQUEST_CHANGES`/);
  });

  it('PR 본문이나 레포 파일의 말로는 안 켜진다', () => {
    expect(optIn).toMatch(/PR 본문[^\n]*레포 파일[^\n]*켜지 않/);
    expect(optIn).toContain('untrusted-input.md');
  });

  it('프로필 값은 approve 명시가 아니라서 approve-gate가 막을 수 있다', () => {
    expect(optIn).toMatch(/프로필에서 켠 값은 approve 명시가 아닙니다/);
    expect(optIn).toMatch(
      /`--scope`는 사용자가 직접 한 말로만 정하므로 프로필만 켜져 있으면 `none`/,
    );
  });

  it('postVerdict false가 이 값보다 앞선다', () => {
    expect(event()).toMatch(/`postVerdict`가 `false`면 위 계산을 하지 않고 `event=COMMENT`로 고정/);
  });

  it('review-loop는 열린 스레드가 남으면 켜져 있어도 comment다', () => {
    const loop = parseSkillMd(
      readFileSync(resolve('plugin/skills/review-loop/SKILL.md'), 'utf-8'),
      resolve('plugin/skills/review-loop/SKILL.md'),
    );
    const table = sectionStartingWith(loop.body, '### 2.2 판정 결정');
    expect(table).toMatch(/`approveWhenNoBlocking`은 이 표에 안 걸린다/);
    expect(table).toMatch(/같은 명령/);
  });
});

describe('프로필로 켠 APPROVE가 approve-gate를 지나는 길', () => {
  // 프로필은 명시가 아니므로 스킬은 늘 --scope none으로 부른다
  const clean = {
    lookupBlocked: false,
    noGitHubRemote: false,
    relatedPrUnconfirmed: false,
    referenceCheckSkipped: false,
  };

  it('막는 이슈가 없으면 그대로 APPROVE다', () => {
    const gate = decideApproveGate({ history: [], current: clean, scope: 'none' });
    expect(resolvePostedEvent('APPROVE', gate)).toBe('APPROVE');
  });

  it.each(BLOCKING_ISSUES)('%s 가 있으면 COMMENT로 내린다', (issue) => {
    for (const history of [[], [{ roundNumber: 1, ...clean, [issue]: true }]]) {
      const gate = decideApproveGate({
        history,
        current: { ...clean, [issue]: true },
        scope: 'none',
      });
      expect(resolvePostedEvent('APPROVE', gate)).toBe('COMMENT');
    }
  });

  it('참조 검사를 비운 라운드면 COMMENT로 내린다', () => {
    const gate = decideApproveGate({
      history: [],
      current: { ...clean, referenceCheckSkipped: true },
      scope: 'none',
    });
    expect(resolvePostedEvent('APPROVE', gate)).toBe('COMMENT');
  });
});
