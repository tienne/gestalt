import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/parser.js';

const reviewPath = resolve('plugin/skills/review/SKILL.md');
const loopPath = resolve('plugin/skills/review-loop/SKILL.md');
const review = parseSkillMd(readFileSync(reviewPath, 'utf-8'), reviewPath);
const loop = parseSkillMd(readFileSync(loopPath, 'utf-8'), loopPath);

/**
 * review 4.7단계는 GitHub PR 대상이면 인라인 코멘트와 함께 리뷰 이벤트까지 게시한다.
 * review-loop은 판정을 자기가 내므로 그 이벤트가 먼저 나가면 두 판정이 겹친다.
 * 앞선 APPROVE를 뒤이은 COMMENT가 못 되돌려 "이슈가 남으면 approve 아님"이 뒤집힌다.
 * postVerdict 계약이 그걸 막는 유일한 자리라 양쪽을 함께 묶어둔다.
 */
describe('판정 게시 경계 (postVerdict)', () => {
  describe('review 스킬', () => {
    it('postVerdict를 선택 입력으로 받는다', () => {
      const input = review.frontmatter.inputs.postVerdict;
      expect(input, 'review 스킬에 postVerdict 입력이 없다').toBeDefined();
      expect(input!.type).toBe('boolean');
      expect(input!.required).toBe(false);
      expect(input!.description).toMatch(/기본값 true/);
    });

    it('false일 때 event를 COMMENT로 고정한다고 적혀 있다', () => {
      expect(review.body).toMatch(/`postVerdict`가 `false`면[^\n]*`event=COMMENT`로 고정/);
    });

    it('reviewSummary를 출력으로 선언한다', () => {
      expect(review.frontmatter.outputs).toContain('reviewSummary');
    });
  });

  describe('review-loop 스킬', () => {
    it('review를 부르는 자리마다 postVerdict를 false로 넘긴다', () => {
      const calls = loop.body.match(/^\/review <prNumber>[^\n]*$/gm) ?? [];
      expect(calls.length, 'review 호출 자리를 못 찾았다').toBeGreaterThan(0);

      for (const call of calls) {
        const idx = loop.body.indexOf(call);
        const after = loop.body.slice(idx, idx + 200);
        expect(after, `이 호출에 postVerdict가 안 붙었다: ${call}`).toMatch(/postVerdict:\s*false/);
      }
    });

    it('postVerdict를 안 받는 review 버전이면 멈춘다고 적혀 있다', () => {
      expect(loop.body).toMatch(/`postVerdict`를 안 받/);
    });

    it('approve 라운드에 별도 승인 자리를 둔다', () => {
      expect(loop.body).toMatch(/ⓟ/);
      expect(loop.body).toMatch(/승인\(approve\) 낼까요\?/);
    });
  });

  describe('reviewThreads 페이지네이션', () => {
    it('쿼리가 pageInfo와 cursor를 받는다', () => {
      expect(loop.body).toMatch(/pageInfo \{ hasNextPage endCursor \}/);
      expect(loop.body).toMatch(/\$cursor/);
    });
  });

  describe('PR 번호 검증', () => {
    it('정수가 아니면 거부한다고 적혀 있다', () => {
      expect(loop.body).toMatch(/\*\[!0-9\]\*/);
    });
  });
});
