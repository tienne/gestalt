import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/parser.js';
import { RoleAgentRegistry } from '../../../src/agent/role-agent-registry.js';

const SKILL_PATH = resolve('plugin/skills/review/SKILL.md');
const skill = parseSkillMd(readFileSync(SKILL_PATH, 'utf-8'), SKILL_PATH);

/**
 * 헤딩 하나가 덮는 범위만 잘라낸다. 파일 끝까지 흘러가면 절 단위 단언이 뜻을 잃는다.
 *
 * 코드펜스 안의 `# 주석` 줄을 헤딩으로 세지 않는다. 이 스킬 문서는 bash 블록을 많이 써서
 * 그걸 안 걸러내면 절이 첫 스니펫에서 끊긴다.
 */
function section(body: string, heading: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line === heading);
  expect(start, `${heading} 헤딩을 못 찾았다`).toBeGreaterThan(-1);
  const level = heading.match(/^#+/)![0]!.length;
  const boundary = new RegExp(`^#{1,${level}} `);

  let fenced = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('```')) fenced = !fenced;
    if (!fenced && boundary.test(line)) return lines.slice(start, i).join('\n');
  }
  return lines.slice(start).join('\n');
}

describe('리뷰 코멘트 audience 옵션', () => {
  const registry = new RoleAgentRegistry(resolve('plugin/role-agents'));
  registry.loadAll();
  const writer = registry.getByName('code-review-writer');
  const writerSection = () => section(writer!.systemPrompt, '### 대상 눈높이 (audience)');

  describe('code-review-writer', () => {
    it('대상 눈높이 절을 갖는다', () => {
      expect(writer).toBeDefined();
      expect(writer!.systemPrompt).toContain('### 대상 눈높이 (audience)');
    });

    it('값을 안 주면 peer라고 적혀 있다', () => {
      expect(writerSection()).toMatch(/(안 주면|기본값)[^\n]*`peer`/);
    });

    it('받는 값이 peer와 junior 둘이라고 적혀 있다', () => {
      expect(writerSection()).toMatch(/`peer`[^\n]*`junior`[^\n]*둘/);
    });

    it('junior 기준을 다른 파일에서 읽지 말라고 적는다', () => {
      // 서브에이전트의 작업 디렉토리는 리뷰 대상 레포다. 경로로 가리키면 리뷰받는 쪽이
      // 심어둔 파일이 코멘트 기준으로 읽힌다
      expect(writerSection()).toMatch(/다른 파일을 찾아 읽지 않는다/);
    });

    it('junior여도 접두어와 severity 판정은 안 바뀐다고 적는다', () => {
      const fixed = writerSection().slice(writerSection().indexOf('안 바뀌는 것'));
      expect(fixed).toMatch(/`r:`\/`c:`\/`a:` 접두어/);
      expect(fixed).toMatch(/severity 판정/);
    });

    it('자가점검에 junior 조건부 항목 둘이 있다', () => {
      const check = section(writer!.systemPrompt, '## 내보내기 전 자가점검');
      expect(check).toMatch(/`junior`[^\n]*두 항목을 더 센다/);
      expect(check).toMatch(/^10\./m);
      expect(check).toMatch(/^11\./m);
      // 전체 분포를 보는 항목이라는 안내에 10~11도 들어가야 한다
      expect(check).toMatch(/1~5와[^\n]*10~11[^\n]*세트 전체의 분포/);
    });
  });

  describe('review 스킬', () => {
    const step0 = () => section(skill.body, '#### audience — 인라인 코멘트를 누가 읽는지');

    it('audience를 선택 입력으로 받는다', () => {
      expect(Object.keys(skill.frontmatter.inputs).sort()).toEqual([
        'audience',
        'local',
        'repoRoot',
        'target',
      ]);
      const audience = skill.frontmatter.inputs.audience!;
      expect(audience.required).toBe(false);
      expect(audience.type).toBe('string');
      expect(audience.description).toMatch(/peer \| junior/);
      expect(audience.description).toMatch(/기본값 peer/);
    });

    it('플래그 없이 말로 발동하는 트리거가 있다', () => {
      expect(skill.frontmatter.triggers).toContain('주니어한테 설명하듯 리뷰');
      expect(skill.frontmatter.triggers).toContain('신입이 읽을 리뷰');
    });

    it('아무 신호가 없으면 peer로 두고 따로 묻지 않는다', () => {
      expect(step0()).toMatch(/아무 신호가 없으면[^\n]*`peer`/);
      expect(step0()).toMatch(/따로 묻지 않습니다/);
    });

    it('지원 안 하는 대상 넷은 peer로 진행하고 알린다', () => {
      const rule = step0()
        .split('\n')
        .find((line) => line.includes('nontech'))!;
      expect(rule).toBeDefined();
      for (const audience of ['nontech', 'manager', 'exec', 'outsider']) {
        expect(rule).toContain(`\`${audience}\``);
      }
      expect(rule).toMatch(/`peer`로 진행/);
      expect(rule).toMatch(/한 줄 알립니다/);
      expect(rule).toContain('/explain');
    });

    it('로컬 PR이면 게시 전에 알리고 조용히 강등하지 않는다', () => {
      // 이 규칙은 불릿 하나에 안 담기고 확인 문구 스니펫과 뒤 문단까지 이어진다
      const body = step0();
      const from = body.indexOf('`junior`는 GitHub PR 게시 경로에서만');
      expect(from, '로컬 PR 규칙을 못 찾았다').toBeGreaterThan(-1);
      const to = body.indexOf('- **받는 값은', from);
      const rule = to === -1 ? body.slice(from) : body.slice(from, to);
      expect(rule).toMatch(/`prTarget`이 `local`/);
      expect(rule).toMatch(/승인 없이 조용히 내리지 않습니다/);
      // 조건은 플래그가 아니라 값이다. 말로만 밝힌 경우에도 걸려야 한다
      expect(rule).toMatch(/플래그가 아니라 \*\*값\*\*/);
    });

    it('4.7단계가 서브에이전트에 audience를 넘긴다', () => {
      const step = section(skill.body, '### 4.7단계: 인라인 코멘트 게시 (code-review-writer)');
      expect(step).toContain('audience: <peer | junior');
      expect(step).toMatch(/audience\.md 같은 이름의 파일을 찾아 읽지 않는다/);
    });

    it('로컬 게시 절이 확인 자리를 0단계로 넘긴다', () => {
      const publish = section(skill.body, '#### 게시 — 로컬 PR (`prTarget: "local"`)');
      expect(publish).toMatch(/`audience`는 이 경로에 안 걸립니다/);
      expect(publish).toMatch(/0단계/);
    });
  });
});
