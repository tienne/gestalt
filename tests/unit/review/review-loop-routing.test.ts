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
