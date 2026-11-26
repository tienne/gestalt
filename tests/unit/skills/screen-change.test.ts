import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(p), 'utf-8');

const judge = read('plugin/skills/_shared/screen-change.md');
const before = read('plugin/skills/_shared/before-screenshot.md');
const pr = read('plugin/skills/pr/SKILL.md');
const ship = read('plugin/skills/ship/SKILL.md');
const execute = read('plugin/skills/execute/SKILL.md');

const VERDICTS = ['changed', 'unchanged', 'unverified', 'none'] as const;

function section(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const next = doc.indexOf('\n## ', start + heading.length);
  return doc.slice(start, next === -1 ? undefined : next);
}

// pr 1단계 4번 선택지의 접두어. ship이 고르는 답은 전부 이 안에 있어야 pr 스킬이 같은 판정으로 읽는다
function prAnswerPrefixes(): string[] {
  const q = pr.slice(pr.indexOf('4. 화면이 바뀔 수 있는 파일이 있어요'));
  const block = q.slice(0, q.indexOf('```'));
  return [...block.matchAll(/^ {3}- ([^:]+):/gm)].map((m) => m[1]!.trim());
}

describe('화면 변경 판정 공용 기준', () => {
  it('수정 전 캡처와 pr, ship, execute가 같은 문서를 가리킨다', () => {
    for (const [name, doc] of [
      ['before-screenshot', before],
      ['pr', pr],
      ['ship', ship],
      ['execute', execute],
    ] as const) {
      expect(doc, name).toContain('screen-change.md');
    }
  });

  it('후보별 판정 셋과 none을 정의하고 pr 본문 지시가 같은 값을 쓴다', () => {
    for (const v of VERDICTS) {
      // changed는 unchanged의 부분 문자열이라 백틱 토큰으로 본다
      expect(judge).toContain(`\`${v}\``);
      expect(pr, v).toContain(`\`${v}\``);
    }
  });

  it('확장자는 단서로만 쓰고 .ts가 HTML을 만드는 사례를 후보로 든다', () => {
    const find = section(judge, '## 후보 찾기');
    expect(find).toContain('단서');
    // 예로 든 파일 경로가 실제로 있어야 예시가 낡지 않는다
    const paths = [...find.matchAll(/`([^`\s]*\/[^`\s]*\.ts)`/g)].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(existsSync(resolve(p)), p).toBe(true);
    expect(find).toContain('화면 문구와 표시 조건');
    expect(find).toContain('테스트와 스토리 파일');
  });

  it('표시 조건과 진행률은 상태별로 비교하고 빈 화면 하나로 결론 내지 않는다', () => {
    const states = section(judge, '## 영향받는 화면과 상태 찾기');
    expect(states).toContain('시작, 중간, 완료');
    expect(states).toContain('조건이 참인 상태와 거짓인 상태');
    expect(states).toContain('같은 데이터, 같은 뷰포트, 같은 테마');
    expect(states).toContain('빈 화면');
  });

  it('실행할 수 없어 못 본 화면은 변화 없음이 아니라 확인 필요다', () => {
    const verdict = section(judge, '## 판정');
    expect(verdict).toMatch(/못 본 화면은 `unverified`다\. `unchanged`로 적지 않는다/);
    expect(before).toContain('화면 변화 없음으로 넘기지 않는다');
    expect(pr).toContain('화면 변화 없음으로 넘기지 않습니다');
  });

  it('화면 변경이 없으면 판정만 남기고 4번을 묻지 않는다', () => {
    expect(before).toContain('"verdict": "none"');
    expect(pr).toContain('후보가 없으면(`none`) 4번은 묻지 않습니다');
    expect(ship).toMatch(/`없음`은 판정이 `none`일 때만이다/);
  });

  it('ship이 4번에 적는 답은 전부 pr 직접 호출의 선택지에 있다', () => {
    const prefixes = prAnswerPrefixes();
    expect(prefixes).toEqual(
      expect.arrayContaining(['이미지 파일', '캡처할 주소', '수정 후만', '확인 필요', '없음']),
    );
    const table = ship.slice(ship.indexOf('| 상황 | 4번에 적는 답 |'));
    const answers = [...table.slice(0, table.indexOf('\n\n')).matchAll(/\| `([^`:]+)[:`]/g)]
      .map((m) => m[1]!.trim())
      .filter((a) => !a.startsWith('manifest.json') && !a.startsWith('$shotTmp'));
    expect(answers).toEqual(
      expect.arrayContaining(['캡처할 주소', '수정 후만', '확인 필요', '없음']),
    );
    for (const a of answers) expect(prefixes, a).toContain(a);
  });

  it('첫 확인은 고치기 전, 두 번째 확인은 초안 PR 직전 최종 diff로 한다', () => {
    const when = section(judge, '## 언제 판정하나');
    expect(when).toContain('코드를 고치기 전');
    expect(when).toContain('GitHub 초안 PR을 만들기 직전');
    expect(pr).toContain('두 번째로 확인');
    expect(ship).toContain('두 번째 확인');
  });
});
