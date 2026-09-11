import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseSkillMd } from '../../../src/skills/parser.js';
import { section, sectionStartingWith } from '../../helpers/skill-section.js';

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
      const preflight = loop.body.indexOf('### 1.0 프리플라이트');
      const phase1 = loop.body.indexOf('## Phase 1');
      expect(preflight, '프리플라이트 절을 못 찾았다').toBeGreaterThan(-1);
      for (const m of calls()) {
        if (m.index! > phase1) {
          expect(m.index!, '리뷰 호출이 프리플라이트보다 앞에 있다').toBeGreaterThan(preflight);
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

    it('게시 절이 ⓟ 확인을 전제로 둔다', () => {
      expect(post(), '2.5가 ⓟ 없이 approve를 부를 수 있다').toMatch(/ⓟ/);
    });

    it('멈추는 자리 표의 일곱 마커가 본문에도 있다', () => {
      for (const mark of ['ⓢ', 'ⓓ', 'ⓝ', 'ⓔ', 'ⓦ', 'ⓟ', 'ⓡ']) {
        const hits = loop.body.split(mark).length - 1;
        expect(hits, `${mark}가 표에만 있고 본문에 없다`).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe('reviewThreads 페이지네이션', () => {
    it('쿼리가 pageInfo와 cursor를 받는다', () => {
      expect(loop.body).toMatch(/pageInfo \{ hasNextPage endCursor \}/);
      expect(loop.body).toMatch(/\$cursor/);
    });

    it('pending을 세는 세 자리가 전량을 받은 뒤에 센다', () => {
      const decide = sectionStartingWith(loop.body, '### 2.2 판정 결정');
      const signal = section(loop.body, '### 신호 계산');
      const watch = section(loop.body, '### `--watch` 모드 — 백그라운드로 지켜본다');

      expect(decide, '2.2가 threads.jsonl을 안 쓴다').toMatch(/threads\.jsonl/);
      expect(signal, '신호 계산이 threads.jsonl을 안 쓴다').toMatch(/threads\.jsonl/);
      expect(watch, 'watch.sh가 커서로 이어받지 않는다').toMatch(/hasNextPage/);
    });

    it('스냅샷 파일을 조회할 때마다 지운다', () => {
      expect(loop.body, 'threads.jsonl truncate가 없다').toMatch(
        /rm -f "\$loopTmp\/threads\.jsonl"/,
      );
      expect(loop.body, 'watch.sh 쪽 truncate가 없다').toMatch(
        /rm -f "\$TMP\/watch-threads\.jsonl"/,
      );
    });

    it('마지막 코멘트를 보려고 comments를 뒤에서 받는다', () => {
      expect(loop.body, 'first:50이면 nodes[-1]이 실제 마지막이 아니다').not.toMatch(
        /comments\(first:50\)/,
      );
      expect(loop.body).toMatch(/comments\(last:50\)/);
    });
  });

  describe('PR 번호 검증', () => {
    /** 문서에 박힌 case 문을 그대로 떼어내 돌린다. 글자가 있는지가 아니라 거부하는지를 본다. */
    const script = `
t="$1"
case "$t" in
  */pull/*) prNumber=\${t##*/pull/}; prNumber=\${prNumber%%[!0-9]*} ;;
  *)        prNumber=\${t#\\#} ;;
esac
case "$prNumber" in
  ''|*[!0-9]*) exit 1 ;;
esac
printf '%s' "$prNumber"
`;

    it('문서의 검증 로직과 이 테스트가 같은 걸 본다', () => {
      const s = section(loop.body, '### PR 식별');
      expect(s).toMatch(/\*\[!0-9\]\*/);
      expect(s).toMatch(/\*\/pull\/\*/);
    });

    it.each([
      ['123', '123'],
      ['#789', '789'],
      ['https://github.com/o/r/pull/456', '456'],
      ['https://github.com/o/r/pull/456/files', '456'],
    ])('%s 를 %s 로 읽는다', (input, want) => {
      const r = runShell(script, input);
      expect(r.ok, `${input}이 거부됐다`).toBe(true);
      expect(r.out).toBe(want);
    });

    it.each(['../../etc', '12; rm -rf /', '1 2', '', '##1', '#a', '$(id)'])(
      '%s 를 거부한다',
      (input) => {
        expect(runShell(script, input).ok, `${input}이 통과했다`).toBe(false);
      },
    );
  });

  describe('출력 규약', () => {
    it('선언한 여섯 값을 본문이 전부 채운다', () => {
      for (const out of loop.frontmatter.outputs) {
        expect(loop.body, `${out}을 채우는 자리가 본문에 없다`).toMatch(new RegExp(out));
      }
    });

    it('loopState 다섯 값이 본문에서 대입된다', () => {
      for (const v of ['approved', 'waiting', 'blocked', 'escalated', 'closed']) {
        expect(loop.body, `loopState를 ${v}로 두는 자리가 없다`).toMatch(
          new RegExp(`\`?loopState\`?[^\\n]*\`${v}\``),
        );
      }
    });
  });
});
