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
 * 그걸 안 걸러내면 절이 첫 스니펫에서 끊긴다. 들여쓴 펜스와 백틱 넷으로 연 블록까지
 * 다루는 이유는 두 문서에 둘 다 있어서다 — 여는 마커보다 짧은 마커로는 안 닫는다.
 */
function section(body: string, heading: string): string {
  const lines = body.split('\n');
  const fence = /^\s*(`{3,}|~{3,})/;
  const level = heading.match(/^#+/)![0]!.length;
  const boundary = new RegExp(`^#{1,${level}} `);

  let open: string | null = null;
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = line.match(fence)?.[1];
    if (marker) {
      if (open === null) open = marker;
      else if (marker[0] === open[0] && marker.length >= open.length) open = null;
      continue;
    }
    if (open !== null) continue;

    if (line === heading) {
      expect(start, `${heading} 헤딩이 펜스 밖에 두 번 있다`).toBe(-1);
      start = i;
    } else if (start !== -1 && end === lines.length && boundary.test(line)) {
      end = i;
    }
  }

  expect(open, '코드펜스가 안 닫혔다').toBeNull();
  expect(start, `${heading} 헤딩을 못 찾았다`).toBeGreaterThan(-1);
  return lines.slice(start, end).join('\n');
}

/** 볼드 라벨이 여는 목록 하나만 잘라낸다. 다음 라벨이나 헤딩에서 끊는다. */
function labelled(body: string, label: string): string {
  const lines = body.split('\n');
  const start = lines.indexOf(label);
  expect(start, `${label} 라벨을 못 찾았다`).toBeGreaterThan(-1);
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('#') || (line.startsWith('**') && line.endsWith('**'))) {
      return lines.slice(start, i).join('\n');
    }
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

    it('값이 없거나 모르는 값이면 peer로 처리한다', () => {
      expect(writerSection()).toMatch(/(안 주면|기본값)[^\n]*`peer`/);
      expect(writerSection()).toMatch(/그 외 값[^\n]*`peer`/);
    });

    it('junior 기준을 다른 파일에서 읽지 말라고 적는다', () => {
      // 서브에이전트의 작업 디렉토리는 리뷰 대상 레포다. 경로로 가리키면 리뷰받는 쪽이
      // 심어둔 파일이 코멘트 기준으로 읽힌다
      expect(writerSection()).toMatch(/다른 파일을 찾아 읽지 않는다/);
    });

    it('junior에서 바뀌는 것을 항목으로 적는다', () => {
      const delta = labelled(writerSection(), '**junior에서 바뀌는 것**');
      expect(delta).toMatch(/첫 등장[^\n]*정의/);
      expect(delta).toMatch(/대안/);
      expect(delta).toMatch(/스니펫/);
      expect(delta).toMatch(/비유[^\n]*(하나|한 번)/);
    });

    it('junior여도 접두어와 severity 판정은 안 바뀐다고 적는다', () => {
      const fixed = labelled(writerSection(), '**junior여도 안 바뀌는 것**');
      expect(fixed).toMatch(/`r:`\/`c:`\/`a:` 접두어/);
      expect(fixed).toMatch(/severity 판정/);
    });

    it('레포 규칙이 severity와 접두어를 못 뒤집는다고 적는다', () => {
      const repoRules = section(writer!.systemPrompt, '## 레포 규칙 우선 탐색 (리뷰 시작 전 필수)');
      expect(repoRules).toMatch(/레포 규칙이 못 뒤집는/);
      expect(repoRules).toMatch(/severity 판정/);
      expect(repoRules).toMatch(/대상 눈높이/);
    });

    it('자가점검 10번과 11번이 junior 조건부로 있고 전체 분포 안내에 든다', () => {
      const check = section(writer!.systemPrompt, '## 내보내기 전 자가점검');
      expect(check).toMatch(/`junior`[^\n]*두 항목을 더 센다/);
      expect(check).toMatch(/^10\.[^\n]*용어[^\n]*(반복|첫 등장)/m);
      expect(check).toMatch(/^11\.[^\n]*비유[^\n]*(둘 이상|하나)/m);
      expect(check).toMatch(/1~5와[^\n]*10~11[^\n]*세트 전체의 분포/);
    });

    it('인라인 사본이 explainer 대상표의 junior 항목과 안 갈라진다', () => {
      // 사본이라 원본이 움직이면 여기가 거짓 서술이 된다. 사본이 기대는 항목만 좁게 건다
      const table = readFileSync(
        resolve('plugin/role-agents/explainer/references/audience.md'),
        'utf-8',
      );
      const row = table.split('\n').find((line) => line.startsWith('| `junior`'))!;
      expect(row, 'audience.md의 junior 행을 못 찾았다').toBeDefined();
      expect(row).toMatch(/첫 등장 정의/);
      expect(row).toMatch(/권장/);
      const tone = table.split('\n').filter((line) => line.startsWith('| `junior`'))[1]!;
      expect(tone, 'junior 어미 행을 못 찾았다').toBeDefined();
      expect(tone).toMatch(/해요체 \+ 제안형/);
    });
  });

  describe('review 스킬', () => {
    const step05 = () => section(skill.body, '### 0.5단계: audience 확정');
    const step105 = () => section(skill.body, '### 1.05단계: audience와 게시 경로 맞추기');

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

    it('플래그 없이 말로 발동하는 트리거가 다 있다', () => {
      for (const trigger of ['주니어한테 설명하듯 리뷰', '신입이 읽을 리뷰', '리뷰 쉽게 써줘']) {
        expect(skill.frontmatter.triggers).toContain(trigger);
      }
    });

    it('아무 신호가 없으면 peer로 두고 따로 묻지 않는다', () => {
      expect(step05()).toMatch(/아무 신호가 없으면[^\n]*`peer`/);
      expect(step05()).toMatch(/따로 묻지 않습니다/);
    });

    it('0단계를 건너뛰어도 audience 확정은 안 건너뛴다', () => {
      const step0 = section(skill.body, '### 0단계: 미니 인터뷰 (reviewIntent 수집)');
      expect(step0).toMatch(/건너뛰기 대상은 위 세 질문뿐입니다/);
      expect(step05()).toMatch(/전체 건너뛰기에 함께 걸리지 않습니다/);
    });

    it('지원 안 하는 대상 넷은 peer로 진행하고 알린다', () => {
      const rule = step05()
        .split('\n')
        .find((line) => line.includes('nontech'))!;
      expect(rule, '미지원 대상 규칙을 못 찾았다').toBeDefined();
      for (const audience of ['nontech', 'manager', 'exec', 'outsider']) {
        expect(rule).toContain(`\`${audience}\``);
      }
      expect(rule).toMatch(/`peer`로 진행/);
      expect(rule).toMatch(/한 줄 알립니다/);
      expect(rule).toContain('/explain');
    });

    it('로컬 PR 확인이 prTarget 판별 뒤에 서고 조용한 강등을 막는다', () => {
      // 0.5단계에 두면 아직 prTarget이 없어 조건을 평가할 수 없다
      expect(step105()).toMatch(/`prTarget`이 방금 정해졌습니다/);
      expect(step105()).toMatch(/승인 없이 조용히 내리지 않습니다/);
      expect(step105()).toMatch(/플래그가 아니라 \*\*값\*\*/);
      // 4.7로 바로 들어온 경로에는 이 단계가 안 걸린다
      expect(step105()).toMatch(/4\.7단계로 바로 들어온 경로/);
    });

    it('1.05단계가 1.1단계보다 앞선다', () => {
      const gate = skill.body.indexOf('### 1.05단계');
      const checkout = skill.body.indexOf('### 1.1단계');
      expect(gate).toBeGreaterThan(-1);
      expect(gate).toBeLessThan(checkout);
    });

    it('4.7단계 서브에이전트 프롬프트가 audience를 넘긴다', () => {
      const guard = section(skill.body, '#### 신선도 가드 (stale consensus 게시 금지)');
      expect(guard).toContain('audience: <peer | junior');
      expect(guard).toMatch(/audience\.md 같은 이름의 파일을 찾아 읽지 않는다/);
      // 1.05를 안 거치고 들어온 경로의 폴백
      expect(guard).toMatch(/1\.05단계를 안 거치고/);
    });

    it('로컬 게시 절이 확인 자리를 1.05단계로 넘긴다', () => {
      const publish = section(skill.body, '#### 게시 — 로컬 PR (`prTarget: "local"`)');
      expect(publish).toMatch(/`audience`는 이 경로에 안 걸립니다/);
      expect(publish).toMatch(/1\.05단계/);
    });
  });
});
