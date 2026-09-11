import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseSkillMd } from '../../../src/skills/parser.js';
import {
  section,
  sectionStartingWith,
  codeBlock,
  codeBlockContaining,
} from '../../helpers/skill-section.js';

const reviewPath = resolve('plugin/skills/review/SKILL.md');
const loopPath = resolve('plugin/skills/review-loop/SKILL.md');
const review = parseSkillMd(readFileSync(reviewPath, 'utf-8'), reviewPath);
const loop = parseSkillMd(readFileSync(loopPath, 'utf-8'), loopPath);

/**
 * review 4.7단계는 GitHub PR 대상이면 인라인 코멘트와 함께 리뷰 이벤트까지 게시한다.
 * review-loop은 판정을 자기가 내므로 그 이벤트가 먼저 나가면 두 판정이 겹친다.
 * 앞선 APPROVE를 뒤이은 COMMENT가 못 되돌려 "이슈가 남으면 approve 아님"이 뒤집힌다.
 *
 * 이 파일이 지키는 건 계약 하나가 아니라 **선언과 배선이 붙어 있는지**다. 라운드 2 리뷰에서
 * 게이트와 페이지네이션과 버전 검사가 전부 설명 절에만 있고 실행 절차에는 없는 채로
 * 넘어간 적이 있다. 그래서 단언을 문서 전체가 아니라 그 판단이 수행되는 절에 묶는다.
 */

/** 문서 안 셸 블록을 그대로 떼어내 돌린다. 산문에 그 글자가 있는지가 아니라 동작을 본다. */
function runShell(script: string, arg: string): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gestalt-verdict-gate-'));
  try {
    const file = join(dir, 's.sh');
    writeFileSync(file, script);
    const out = execFileSync('sh', [file, arg], { encoding: 'utf-8' }).trim();
    return { ok: true, out };
  } catch {
    return { ok: false, out: '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('판정 게시 경계 (postVerdict)', () => {
  describe('review 스킬', () => {
    it('postVerdict를 선택 입력으로 받는다', () => {
      const input = review.frontmatter.inputs.postVerdict;
      expect(input, 'review 스킬에 postVerdict 입력이 없다').toBeDefined();
      expect(input!.type).toBe('boolean');
      expect(input!.required).toBe(false);
    });

    it('이벤트를 정하는 절 안에서 postVerdict가 COMMENT로 고정한다', () => {
      const s = section(review.body, '### 4.7단계: 인라인 코멘트 게시 (code-review-writer)');
      expect(s).toMatch(/postVerdict/);
      expect(s).toMatch(/COMMENT/);
    });

    it('reviewSummary를 출력으로 선언한다', () => {
      expect(review.frontmatter.outputs).toContain('reviewSummary');
    });
  });

  describe('review-loop이 review를 부르는 자리', () => {
    /** indexOf 는 같은 문자열 두 개를 구분 못 한다. 위치로 잡아야 각 호출을 따로 본다. */
    const calls = () => [...loop.body.matchAll(/^\/review <prNumber>[^\n]*$/gm)];

    it('호출 자리를 두 곳 이상 찾는다', () => {
      expect(calls().length).toBeGreaterThanOrEqual(2);
    });

    it('자리마다 postVerdict를 false로 넘긴다', () => {
      const seen = new Set<number>();
      for (const m of calls()) {
        expect(seen.has(m.index!), '같은 위치를 두 번 검사했다').toBe(false);
        seen.add(m.index!);

        // 호출 줄이 든 코드블록 안만 본다. 고정 길이로 자르면 바로 뒤 산문의
        // "postVerdict: false 를 빠뜨리지 않는다" 같은 설명이 대신 걸려, 정작
        // 코드블록에서 그 줄이 빠져도 통과한다.
        const rest = loop.body.slice(m.index!).split('\n');
        const fenceAt = rest.findIndex((l, i) => i > 0 && /^\s*(`{3,}|~{3,})/.test(l));
        expect(fenceAt, `호출 뒤 코드펜스가 안 닫혔다 (offset ${m.index})`).toBeGreaterThan(0);
        const block = rest.slice(0, fenceAt).join('\n');

        expect(block, `이 호출에 postVerdict가 안 붙었다 (offset ${m.index})`).toMatch(
          /^postVerdict:\s*false$/m,
        );
      }
    });

    it('버전 검사가 리뷰 호출보다 앞에 있다', () => {
      const preflight = loop.body.indexOf('### 1.1 사전 점검');
      const phase1 = loop.body.indexOf('## Phase 1');
      expect(preflight, '사전 점검 절을 못 찾았다').toBeGreaterThan(-1);
      for (const m of calls()) {
        if (m.index! > phase1) {
          expect(m.index!, '리뷰 호출이 사전 점검보다 앞에 있다').toBeGreaterThan(preflight);
        }
      }
    });
  });

  describe('승인 게이트 ⓟ', () => {
    const decide = () => sectionStartingWith(loop.body, '### 2.2 판정 결정');
    const post = () => sectionStartingWith(loop.body, '### 2.5 게시');

    it('판정을 정하는 절 안에 있다', () => {
      expect(decide(), 'ⓟ가 2.2 절 밖에 있다').toMatch(/ⓟ/);
      expect(decide()).toMatch(/승인\(approve\) 낼까요\?/);
    });

    it('게시 절이 ⓟ 확인 없이는 approve를 못 부르게 한다', () => {
      // 토큰만 보면 강제 문장을 참고용으로 바꿔도 통과한다. 조건을 거는 문구까지 본다.
      expect(post(), '2.5가 ⓟ 없이 approve를 부를 수 있다').toMatch(
        /`--approve`[^\n]*ⓟ[^\n]*경우에만/,
      );
    });

    it('멈추는 자리 일곱 마커가 범례 밖 본문에도 있다', () => {
      // 범례 절을 빼고 센다. 표 한 장만으로 임계값이 채워지면 실제 배선을 지워도 통과한다.
      const legend = section(loop.body, '## 멈추는 자리');
      const rest = loop.body.replace(legend, '');

      for (const mark of ['ⓢ', 'ⓓ', 'ⓝ', 'ⓔ', 'ⓦ', 'ⓟ', 'ⓡ']) {
        const hits = rest.split(mark).length - 1;
        expect(hits, `${mark}가 범례에만 있고 절차 본문에 없다`).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('스레드 조회와 pending 집계', () => {
    const query = () => section(loop.body, '### 1) 쿼리와 좌표');
    const fetch = () => section(loop.body, '### 2) 스레드를 전량 받는다');

    it('쿼리가 커서를 받고 comments를 뒤에서 가져온다', () => {
      expect(query()).toMatch(/pageInfo\{hasNextPage endCursor\}/);
      expect(query()).toMatch(/\$cursor/);
      expect(query(), 'first:50이면 마지막 코멘트 작성자를 잘못 읽는다').toMatch(
        /comments\(last:50\)/,
      );
      expect(loop.body).not.toMatch(/comments\(first:50\)/);
    });

    it('전량을 받는 루프가 스냅샷을 매번 새로 쓰고 상한을 둔다', () => {
      expect(fetch(), '스냅샷을 비우고 시작하지 않는다').toMatch(/: > "\$loopTmp\/threads\.jsonl"/);
      expect(fetch(), '커서 루프가 없다').toMatch(/hasNextPage/);
      expect(fetch(), '페이지 상한이 없다').toMatch(/pages/);
    });

    it('집계가 fail-closed다', () => {
      const b = codeBlock(loop.body, '### 3) `pending`을 센다 — 실패하면 멈춘다');
      expect(b, '스냅샷 존재 검사가 없다').toMatch(/\[ -f "\$loopTmp\/threads\.jsonl" \]/);
      expect(b, 'jq 실패를 안 잡는다').toMatch(/\|\|\s*\{[^}]*exit 1/);
    });

    it('집계가 실제로 미대응만 센다', () => {
      const jq = codeBlock(loop.body, '### 3) `pending`을 센다 — 실패하면 멈춘다')
        .split('\n')
        .filter((l) => !l.startsWith('['))
        .join('\n');

      const rows = [
        // 내가 열고 답이 없다 → 미대응
        '{"isResolved":false,"isOutdated":false,"comments":{"nodes":[{"author":{"login":"me"}}]}}',
        // 답글이 왔다 → 대응
        '{"isResolved":false,"isOutdated":false,"comments":{"nodes":[{"author":{"login":"me"}},{"author":{"login":"a"}}]}}',
        // 닫혔다 / 줄이 바뀌었다 / 남이 열었다 → 전부 제외
        '{"isResolved":true,"isOutdated":false,"comments":{"nodes":[{"author":{"login":"me"}}]}}',
        '{"isResolved":false,"isOutdated":true,"comments":{"nodes":[{"author":{"login":"me"}}]}}',
        '{"isResolved":false,"isOutdated":false,"comments":{"nodes":[{"author":{"login":"x"}}]}}',
      ].join('\n');

      const dir = mkdtempSync(join(tmpdir(), 'gestalt-pending-'));
      try {
        writeFileSync(join(dir, 'threads.jsonl'), rows + '\n');
        const out = execFileSync(
          'sh',
          [
            '-c',
            `loopTmp='${dir}' me=me; ${jq.replace(/^pending=\$\(/m, 'pending=$(')}; printf '%s' "$pending"`,
          ],
          { encoding: 'utf-8' },
        );
        expect(out, '미대응 스레드 수가 1이어야 한다').toBe('1');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('PR 스칼라 값을 별도 GraphQL로 조회한다', () => {
      const block = codeBlock(loop.body, '### 4) 나머지 셋');
      expect(block, '커서 루프의 $page를 블록 밖에서 쓴다').not.toMatch(/\$page/);

      // gh pr view 의 --jq 는 --arg 를 안 받고(accepts at most 1 arg), 그쪽
      // reviewRequests 에는 login 이 없는 팀이 섞여 온다. 드라이런에서 확인했다.
      expect(block, 'gh pr view 로는 내 로그인을 필터에 못 넘긴다').not.toMatch(/gh pr view/);
      expect(block, '사람만 거르는 인라인 프래그먼트가 없다').toMatch(/\.\.\. on User/);
    });

    it('스레드 0개인 라운드를 조회 실패로 오판하지 않는다', () => {
      const fetchBlock = codeBlock(loop.body, '### 2) 스레드를 전량 받는다');
      const countBlock = codeBlock(loop.body, '### 3) `pending`을 센다 — 실패하면 멈춘다');

      // 첫 라운드는 스레드가 0개다. >> 가 한 번도 안 돌면 파일이 안 생기므로
      // 빈 파일을 먼저 만들어 둔다. 검사는 -s(내용 있음)가 아니라 -f(있음)로 한다.
      expect(fetchBlock, '빈 파일을 먼저 만들지 않는다').toMatch(
        /^: > "\$loopTmp\/threads\.jsonl"/m,
      );
      expect(countBlock, '-s 로 검사하면 스레드 0개인 정상 라운드가 막힌다').not.toMatch(
        /\[ -s "\$loopTmp\/threads\.jsonl" \]/,
      );
      expect(countBlock).toMatch(/\[ -f "\$loopTmp\/threads\.jsonl" \]/);
    });

    it('pending 집계 사본이 하나뿐이다', () => {
      const copies = loop.body.split('select(.isResolved | not)').length - 1;
      expect(copies, `집계가 ${copies}곳에 있다 — 한쪽만 고쳐지면 판정이 갈린다`).toBe(1);
    });
  });

  describe('PR 번호 검증', () => {
    /**
     * 문서의 case 문을 그대로 떼어내 돌린다. 테스트에 사본을 두면 문서 쪽 검증을
     * 통째로 없애도 사본이 통과해, 잡겠다고 만든 회귀를 그대로 흘려보낸다.
     */
    const script = () => codeBlockContaining(loop.body, '### PR 식별', 'prNumber');

    /** 문서 블록이 마지막에 `prNumber=<값>`을 찍는다. 그 줄만 본다. */
    const readNumber = (out: string) => out.trim().split('\n').pop()!.replace('prNumber=', '');

    it('문서에서 뽑은 블록이 검증 로직이다', () => {
      expect(script(), '거부 분기가 없다').toMatch(/\*\[!0-9\]\*/);
      expect(script(), 'URL 분기가 없다').toMatch(/\*\/pull\/\*/);
    });

    it.each([
      ['123', '123'],
      ['#789', '789'],
      ['https://github.com/o/r/pull/456', '456'],
      ['https://github.com/o/r/pull/456/files', '456'],
    ])('%s 를 %s 로 읽는다', (input, want) => {
      const r = runShell(script().replace("t='<target>'", `t='${input}'`), input);
      expect(r.ok, `${input}이 거부됐다`).toBe(true);
      expect(readNumber(r.out)).toBe(want);
    });

    it.each(['../../etc', '12; rm -rf /', '1 2', '', '##1', '#a', '$(id)'])(
      '%s 를 거부한다',
      (input) => {
        const r = runShell(
          script().replace("t='<target>'", `t='${input.replace(/'/g, "'\\''")}'`),
          input,
        );
        expect(r.ok, `${input}이 통과했다`).toBe(false);
      },
    );
  });

  describe('출력 규약', () => {
    /**
     * 출력 규약 표는 여섯 이름과 다섯 값을 전부 나열한다. 그 표를 포함한 채로 세면
     * 실제로 채우는 자리를 지워도 표 문구만으로 통과한다. 표를 빼고 본다.
     */
    const outsideTable = () => loop.body.replace(section(loop.body, '## 출력 규약'), '');

    it('선언한 여섯 값을 규약 표 밖에서 채운다', () => {
      for (const out of loop.frontmatter.outputs) {
        expect(outsideTable(), `${out}을 채우는 자리가 절차 본문에 없다`).toMatch(new RegExp(out));
      }
    });

    it('loopState 다섯 값이 규약 표 밖에서 대입된다', () => {
      for (const v of ['approved', 'waiting', 'blocked', 'escalated', 'closed']) {
        expect(outsideTable(), `loopState를 ${v}로 두는 자리가 없다`).toMatch(
          new RegExp(`loopState[^\\n]*\`${v}\``),
        );
      }
    });

    it('Phase 5가 네 값을 셸로 대입한다', () => {
      const fill = codeBlock(loop.body, '### 출력값 채우기 — 어느 경로로 끝나든 먼저 한다');
      for (const v of ['rounds', 'verdicts', 'unresolvedAtEnd', 'finalDecision']) {
        expect(fill, `${v} 대입이 없다`).toMatch(new RegExp(`^${v}=`, 'm'));
      }
    });
  });
});
