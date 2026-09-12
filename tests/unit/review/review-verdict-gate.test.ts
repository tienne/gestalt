import { describe, it, expect } from 'vitest';
import { SIGNAL_ACTION } from '../../../src/review-loop/signal.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/parser.js';
import {
  section,
  sectionStartingWith,
  codeBlock,
  codeBlockContaining,
  freeVariables,
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
 * 이 파일이 지키는 건 계약 하나가 아니라 **선언한 규칙이 실행 절차에도 있는지**다. 규칙이
 * 설명 절에만 적히고 그 판단이 실제로 수행되는 절에는 빠진 채 넘어가면 문서를 읽는
 * 쪽은 규칙이 산다고 믿는다. 그래서 단언을 문서 전체가 아니라 그 절에 묶는다.
 */

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

    it('호출 자리를 적어도 하나 찾는다', () => {
      // 이 단언이 없으면 아래 postVerdict 검사가 빈 목록을 돌며 그냥 통과한다
      expect(calls().length).toBeGreaterThanOrEqual(1);
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

    it('세 선택지와 결과 매핑이 2.2 안에 있다', () => {
      // 문구만 남고 매핑이 사라지면 답을 받고도 다음에 뭘 할지가 문서에 없다.
      const d = decide();
      expect(d, '낸다 → approve 매핑이 없다').toMatch(/낸다[\s\S]{0,120}?--approve/);
      expect(d, '코멘트로만 남긴다 → comment 매핑이 없다').toMatch(
        /코멘트로만 남긴다[\s\S]{0,120}?--comment/,
      );
      expect(d, '여기서 멈춘다 → waiting 매핑이 없다').toMatch(
        /여기서 멈춘다[\s\S]{0,160}?waiting/,
      );
    });

    it('사전 점검이 frontmatter 키를 앵커로 본다', () => {
      // grep -q postVerdict 로 느슨해지면 주석이나 산문에만 있어도 구버전을 통과시킨다.
      const pre = codeBlockContaining(
        loop.body,
        '### 1.1 사전 점검 — 설치된 `review`가 `postVerdict`를 받는지',
        'grep',
      );
      expect(pre, 'frontmatter 키 앵커가 아니다').toMatch(/\^\s+postVerdict:/);
    });

    it('멈추는 자리 일곱 마커가 범례 밖 본문에도 있다', () => {
      // 범례는 CONTRACT.md 에 있다. 절차 문서에 마커가 남아 있어야 그 자리가 실제로 선다
      const rest = loop.body;

      for (const mark of ['ⓢ', 'ⓓ', 'ⓝ', 'ⓔ', 'ⓦ', 'ⓟ', 'ⓡ']) {
        const hits = rest.split(mark).length - 1;
        expect(hits, `${mark}가 범례에만 있고 절차 본문에 없다`).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('postedReview 이중 승인 감지', () => {
    const step = () => sectionStartingWith(loop.body, '### 1.2 리뷰 호출');

    it('1.2가 postedReview 를 읽는다', () => {
      expect(step(), '1.2가 postedReview 를 안 본다').toMatch(/postedReview/);
    });

    it('이미 게시됐으면 blocked 로 두고 게시로 안 내려간다', () => {
      expect(step()).toMatch(/`loopState`를 `blocked`로/);
      expect(step(), '2.5로 안 내려간다는 말이 없다').toMatch(/2\.5로 내려가지 않는다/);
    });
  });

  /**
   * 판정에 쓰는 수와 신호는 이제 `src/review-loop/` 이 만든다. 문서는 그걸 부르기만 한다.
   * 셋이 갈리면 같은 PR 을 보고 다른 수가 나오므로 여기서 붙여 둔다 — 문서가 셸로 집계를
   * 다시 적거나, 코드가 내는 신호를 문서 표가 빠뜨리거나, 상태 자리 표에 없는 파일이
   * 절차에 생기는 세 가지가 실제로 일어났던 회귀다.
   */
  describe('문서와 코드가 갈리지 않는다', () => {
    it('수를 쓰는 절마다 조회를 자기가 부른다', () => {
      // 앞 절에서 물려받으면 셸 상태가 안 넘어오는 런타임에서 빈 값이 된다. 그 값이
      // 미대응 0 으로 읽혀 승인이 열린다. 절마다 자기가 불러야 그 자리가 없다
      for (const heading of ['### 2.2', '### 신호 계산', '### 출력값 채우기']) {
        const sec = sectionStartingWith(loop.body, heading);
        expect(sec, `${heading} 가 상태 조회를 자기가 안 부른다`).toMatch(
          /gestalt review-loop state --pr/,
        );
      }
    });

    it('조회 실패를 fail-closed로 다룬다', () => {
      // 명령 치환은 stdout 만 가져간다. 실패 분기가 없으면 실패한 조회가 빈 문자열로
      // 넘어가고 그게 미대응 0 으로 읽혀 승인이 나간다
      const lines = loop.body.split('\n');
      let seen = 0;
      lines.forEach((line, i) => {
        if (!/\$\(gestalt review-loop state/.test(line)) return;
        seen++;
        // 줄이 이어지면 다음 줄까지 합쳐서 본다
        const stmt = /\\$/.test(line) ? `${line}\n${lines[i + 1] ?? ''}` : line;
        expect(stmt, `조회에 실패 분기가 없다: ${line.trim()}`).toMatch(
          /\|\|\s*\{[^}]*exit\s+1\s*;?\s*\}/,
        );
      });
      expect(seen, '조회를 부르는 자리를 하나도 못 찾았다').toBeGreaterThan(0);
    });

    it('집계를 문서가 다시 적지 않는다', () => {
      // 집계 필터를 문서가 다시 들고 있으면 한쪽만 고쳐진다. 산문 표의 `isResolved` 는
      // 무엇을 대응으로 세는지 설명하는 자리라 그대로 둔다. 실행되는 블록만 본다
      const shell = [...loop.body.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].map((m) => m[1]!);
      expect(shell.length, '셸 블록이 하나도 없다').toBeGreaterThan(0);
      for (const block of shell) {
        expect(block, 'jq 로 스레드를 직접 세고 있다').not.toMatch(/isResolved|isOutdated/);
        expect(block, '스레드 스냅샷 파일이 되살아났다').not.toMatch(/threads\.(jsonl|ok)/);
      }
    });

    it('재리뷰 판정 표가 코드가 내는 신호와 행동까지 같다', () => {
      const table = sectionStartingWith(loop.body, '## Phase 4');
      // 절 전체에서 토큰만 찾으면 하위 헤딩이 대신 만족해 표 행을 지워도 통과한다.
      // 표 행만 뽑아 양쪽 집합을 통째로 비교한다
      const rows = new Map(
        [...table.matchAll(/^\| `([A-Z_]+)` \| (.+?) \|\s*$/gm)].map((m) => [m[1]!, m[2]!]),
      );
      expect([...rows.keys()].sort()).toEqual(Object.keys(SIGNAL_ACTION).sort());

      // 이름만 맞추면 코드와 문서가 반대를 말해도 안 걸린다. 행동 문구까지 묶는다
      for (const [signal, action] of Object.entries(SIGNAL_ACTION)) {
        expect(rows.get(signal), `${signal} 행이 코드의 설명과 다르다`).toContain(action);
      }
    });

    it('상태 자리 표에 적힌 파일만 절차가 만든다', () => {
      const table = sectionStartingWith(loop.body, '## 상태 자리');
      const declared = new Set(
        [...table.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]!.replace(/<N>/g, '')),
      );
      expect(declared.size, '상태 자리 표가 비었다').toBeGreaterThan(3);

      // 절차 본문이 "$loopTmp/..." 로 건드리는 파일이 전부 표에 있어야 한다
      const rest = loop.body.replace(table, '');
      const used = new Set(
        [...rest.matchAll(/\$loopTmp\/([A-Za-z0-9_.<>-]+)/g)].map((m) => m[1]!.replace(/<N>/g, '')),
      );
      for (const file of used) {
        expect(declared, `${file} 이 상태 자리 표에 없다`).toContain(file);
      }

      // 반대 방향 — 선언만 하고 절차가 안 만드는 행은 영영 안 생기는 파일이다.
      // 백틱으로만 적힌 자리도 쓰임으로 센다
      const plain = rest.replace(/<N-?1?>/g, '');
      for (const file of declared) {
        const mentioned = used.has(file) || plain.includes(`\`${file}\``);
        expect(mentioned, `${file} 을 표에 선언해 놓고 절차가 안 쓴다`).toBe(true);
      }
    });
  });

  it('셸 블록이 앞 블록의 변수에 기대지 않는다', () => {
    // 문서의 코드블록은 각각 다른 Bash 호출로 실행된다. 앞 블록의 변수는 빈 문자열로
    // 풀리고 그 값이 판정에 실리면 조용히 틀린 수가 나온다
    const blocks = [...loop.body.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length, '셸 블록이 하나도 없다').toBeGreaterThan(0);
    for (const block of blocks) {
      // loopTmp 와 prNumber 는 문서가 "출력된 절대 경로를 적어둔다"로 채우는 자리표다.
      // CLAUDE_PLUGIN_ROOT 는 플러그인 런타임이 준다
      expect(freeVariables(block, ['loopTmp', 'prNumber', 'CLAUDE_PLUGIN_ROOT'])).toEqual([]);
    }
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
