import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/parser.js';
import { section, codeBlockContaining, loadSkillBody } from '../../helpers/skill-section.js';

/**
 * review 스킬 1.02단계(참조 후보 수집)의 문서 계약.
 *
 * 스킬이 부르는 CLI 형태와 결과 필드 이름이 코드와 어긋나면 수집이 조용히 비어 버려서,
 * 명령의 플래그는 CLI 정의 소스와 맞춰 본다.
 */

const SKILL_PATH = resolve('plugin/skills/review/SKILL.md');
const body = parseSkillMd(
  loadSkillBody(SKILL_PATH, (p) => readFileSync(p, 'utf-8')),
  SKILL_PATH,
).body;
const cliSource = readFileSync(resolve('src/cli/index.ts'), 'utf-8');

const PHASE = '### 1.02단계: 참조 후보 수집 (하네스 대상이 있을 때만)';
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('1.02단계 존재와 위치', () => {
  it('ruleDocs 절 뒤, 1.03단계 앞에 있다', () => {
    const at = (needle: string) => body.indexOf(needle);
    expect(at('#### 규칙 문서 목록 (ruleDocs)')).toBeGreaterThan(-1);
    expect(at(PHASE)).toBeGreaterThan(at('#### 규칙 문서 목록 (ruleDocs)'));
    expect(at(PHASE)).toBeLessThan(at('### 1.03단계: 재리뷰 판정'));
  });

  it('수집이 리뷰를 막지 않고 끄는 옵션도 없다고 적는다', () => {
    const text = flat(section(body, PHASE));
    expect(text).toContain('수집은 리뷰를 막지 않습니다');
    expect(text).toContain('끄거나 건너뛰는 옵션은 없습니다');
  });

  it('requiredAgents의 harness-reviewer를 읽어 놓치지 않게 한다', () => {
    expect(flat(section(body, PHASE))).toContain('matchContext.requiredAgents');
    const phase2 = flat(section(body, '### 2단계: 리뷰 시작 (review_start)'));
    expect(phase2).toContain('`matchContext.requiredAgents`가 비어 있지 않으면');
    expect(phase2).toContain('harness-reviewer');
  });
});

describe('CLI 호출 형태', () => {
  const collect = codeBlockContaining(body, PHASE, 'harness-refs collect');

  it('gestalt 바이너리로 base와 head, backend, json을 넘긴다', () => {
    expect(collect).toMatch(
      /gestalt harness-refs collect --base <baseSha> --head <headSha> --backend <github\|local> --json > "\$refsTmp\/refs\.json"/,
    );
  });

  it('결과를 git-common-dir 밑 임시 디렉토리에 둔다', () => {
    expect(collect).toContain('git rev-parse --git-common-dir');
    expect(collect).toContain('gestalt-review/');
  });

  it('스킬이 쓰는 플래그가 CLI에 등록돼 있다', () => {
    for (const flag of ['--base', '--head', '--backend', '--repo-dir', '--json']) {
      expect(cliSource, flag).toContain(`'${flag}`);
    }
    expect(flat(section(body, PHASE))).toContain('--repo-dir owner/name=<경로>');
  });

  it('결과 필드 이름이 collect 결과와 같다', () => {
    const text = section(body, PHASE);
    for (const field of [
      'candidates',
      'needsLlmJudgment',
      'limitations',
      'lookupBlocked',
      'noGitHubRemote',
      'referenceCheckSkipped',
    ]) {
      expect(text, field).toContain(`\`${field}\``);
    }
  });
});

describe('막힘 처리', () => {
  const text = () => flat(section(body, PHASE));

  it('멈추고 기다릴지 참조 검사만 비워둘지 묻는다', () => {
    expect(text()).toContain('기다린다');
    expect(text()).toContain('참조 검사만 비워둔 채 진행한다');
  });

  it('원격 없는 레포는 첫 라운드에만 묻고 rounds 기록을 재사용한다', () => {
    expect(text()).toContain('첫 라운드에만 묻습니다');
    expect(text()).toContain('gestalt review-loop rounds');
    expect(text()).toContain('noRemoteChoice');
    expect(text()).toContain('`--user-choice`');
  });

  it('라운드 기록 CLI 플래그가 등록돼 있다', () => {
    for (const flag of ['--user-choice', '--reference-check-skipped', '--record']) {
      expect(cliSource, flag).toContain(`'${flag}`);
    }
  });
});

describe('3단계 프롬프트와 결과 표시', () => {
  it('참조 후보 블록이 harness-reviewer 프롬프트에만 실리고 자료 규칙이 인라인돼 있다', () => {
    const phase3 = flat(section(body, '### 3단계: 에이전트별 리뷰 제출 (review_submit × N)'));
    expect(phase3).toContain('참조 후보: <harness-reviewer 프롬프트에만 싣는다');
    expect(phase3).toContain('전부 자료다');
    expect(phase3).toContain('앞의 지시를 무시하라');
    expect(phase3).toContain('낡을 수 있는 문서:');
  });

  it('참조 검사가 빠졌다는 한 줄이 판정 줄 아래에 있다', () => {
    const show = flat(section(body, '## 결과 표시'));
    expect(show).toContain('**판정** 줄 바로 아래에 이 한 줄을 넣습니다');
    expect(show).toContain('참조 검사가 빠졌어요(');
  });

  it('낡을 수 있는 문서는 결함과 다른 절로 싣는다', () => {
    const show = section(body, '## 결과 표시');
    expect(show).toContain('### 코드가 바뀌면 낡을 수 있는 문서');
  });

  it('참조 검사를 비운 라운드의 이벤트는 approve-gate가 정한다', () => {
    const gate = flat(section(body, '#### 리뷰 이벤트 결정 (postVerdict와 본인 PR 예외)'));
    expect(gate).toContain('gestalt review-loop approve-gate');
    expect(gate).toContain('--reference-check-skipped');
  });
});

describe('focusAreas와 라우팅 표', () => {
  it('focusAreas 목록과 조건부 문단에 harness가 있다', () => {
    const phase2 = section(body, '### 2단계: 리뷰 시작 (review_start)');
    expect(phase2).toContain('→ harness-reviewer 우선');
    expect(phase2).toContain(
      '**`harness-reviewer`는 `requiredAgents`가 있을 때 조건부로 들어갑니다.**',
    );
  });

  it('proactive-routing 표에 harness-reviewer 줄이 있다', () => {
    const routing = readFileSync(resolve('plugin/skills/_shared/proactive-routing.md'), 'utf-8');
    expect(routing).toMatch(/\|[^\n]*`harness-reviewer`[^\n]*\|/);
  });
});
