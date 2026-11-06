import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/parser.js';
import { section } from '../../helpers/skill-section.js';

const load = (name: string) => {
  const path = resolve(`plugin/skills/${name}/SKILL.md`);
  return parseSkillMd(readFileSync(path, 'utf-8'), path);
};

/**
 * 재리뷰 시점을 손으로 확인하던 요청이 review-loop로 가게 하는 자리다. 트리거만 넣고
 * 제안 줄을 빼면 리뷰 한 번으로 끝난 PR을 다시 볼 계기가 없다.
 */
describe('review-loop 라우팅', () => {
  it('재리뷰와 리뷰 상태 확인 요청을 트리거로 받는다', () => {
    const { frontmatter } = load('review-loop');
    for (const t of ['리뷰 상태 확인', '재리뷰해줘', '다시 리뷰']) {
      expect(frontmatter.triggers).toContain(t);
    }
  });

  it('라우팅 표에도 같은 트리거가 실린다', () => {
    const table = readFileSync(resolve('plugin/skills/_shared/proactive-routing.md'), 'utf-8');
    const row = table.split('\n').find((l) => l.includes('`review-loop` 스킬 사용'));
    expect(row).toContain('"리뷰 상태 확인"');
    expect(row).toContain('"재리뷰해줘"');
    expect(row).toContain('"다시 리뷰"');
  });

  /**
   * 상태만 물어도, review 바로 뒤에 넘어와도 같은 head를 다시 리뷰하면 코멘트와 판정이 한 번
   * 더 나간다. 그래서 지난 리뷰가 남아 있으면 작성자 대응부터 보는 자리를 고정한다.
   */
  describe('이어서 부르면 작성자 대응부터 본다', () => {
    const loop = () => load('review-loop').body;
    const resume = () => section(loop(), '### 재개인지 본다');

    it('재개 판단이 ⓢ보다 앞이다', () => {
      const body = loop();
      expect(body.indexOf('### 재개인지 본다')).toBeGreaterThan(-1);
      expect(body.indexOf('### 재개인지 본다')).toBeLessThan(
        body.indexOf('### 승인 단계 ⓢ — 자동 판정 동의'),
      );
    });

    it('남은 흔적이 있으면 신호부터 보고 재리뷰일 때만 라운드를 돈다', () => {
      const rows = resume()
        .split('\n')
        .filter((l) => /^\| [123] \|/.test(l));
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatch(/`round`나 `reviewed-head`가 있다[^\n]*Phase 3 신호 계산부터/);
      expect(rows[1]).toMatch(/지금 head를 봤다[^\n]*Phase 3 신호 계산부터/);
      expect(rows[2]).toMatch(/1라운드다\. ⓢ를 거쳐 Phase 1/);
      expect(resume()).toMatch(/`WAITING`과 `REPLIES_ONLY`는 상태만 알리고 끝낸다/);
    });

    it('상태 확인과 재리뷰 요청을 문장이 아니라 신호로 가른다', () => {
      expect(resume()).toMatch(/사용자가 한 말로 가르지 않는다/);
    });

    it('이어받을 리뷰를 review 1.03단계와 같은 거르기로 찾는다', () => {
      // 거르기가 갈라지면 답글만 단 시점이 마지막 리뷰로 잡혀 이어받기 조건이 틀린다
      const filter = '(.state != \\"COMMENTED\\" or .body != \\"\\")';
      expect(section(load('review').body, '### 1.03단계: 재리뷰 판정')).toContain(filter);
      expect(resume()).toContain(filter);
      expect(resume()).toMatch(/> "\$stateDir\/reviewed-head"/);
    });

    it('round 파일이 없어도 재리뷰 라운드 번호가 풀린다', () => {
      expect(loop()).toContain('round=$(( $(cat "$stateDir/round" 2>/dev/null || echo 0) + 1 ))');
    });

    it('review의 제안 문단이 이어받는다는 걸 알린다', () => {
      expect(section(load('review').body, '## 결과 표시')).toMatch(
        /`review-loop`는 방금 남긴 리뷰를 이어받아 작성자 대응부터 봅니다/,
      );
    });
  });

  describe('review가 끝날 때 review-loop를 제안한다', () => {
    const result = () => section(load('review').body, '## 결과 표시');

    it('COMMENT나 REQUEST_CHANGES를 남겼을 때 한 줄로 묻는다', () => {
      expect(result()).toContain('작성자 대응을 지켜보다 재리뷰할까요? (review-loop)');
      expect(result()).toMatch(/`COMMENT`나 `REQUEST_CHANGES`를 남기고 끝났으면/);
    });

    it('묻기만 하고 자동으로 걸지 않는다', () => {
      expect(result()).toMatch(/묻기만 합니다/);
      expect(result()).toMatch(/대기나 재리뷰를 직접 걸지 않습니다/);
    });

    it('github가 아니거나 APPROVE, 본인 PR, 다른 스킬의 호출이면 뺀다', () => {
      const skip = result().split('아래 자리에서는 이 줄을 뺍니다.')[1]!.split('\n\n')[1]!;
      expect(skip).toMatch(/`prTarget`이 `github`이 아닐 때/);
      expect(skip).toMatch(/`APPROVE`/);
      expect(skip).toMatch(/본인 PR/);
      expect(skip).toMatch(/다른 스킬이 이 스킬을 불렀을 때/);
    });
  });
});
