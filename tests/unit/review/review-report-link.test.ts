import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/parser.js';
import { section } from '../../helpers/skill-section.js';

const load = (name: string) => {
  const path = resolve(`plugin/skills/${name}/SKILL.md`);
  return parseSkillMd(readFileSync(path, 'utf-8'), path).body;
};
const review = load('review');
const loop = load('review-loop');

/**
 * 긴 대화에서는 앞 메시지가 압축돼 사라진다. 사용자가 마지막 보고만 보고 PR로 넘어갈 수
 * 있어야 해서 첫 줄 자리를 고정한다.
 */
describe('완료 보고 첫 줄의 PR 링크', () => {
  describe('review', () => {
    const result = () => section(review, '## 결과 표시');

    it('결과 표시가 PR 링크 규칙으로 시작하고 컨텍스트 블록이 그 아래다', () => {
      const body = result();
      const rule = body.indexOf('**마지막 메시지의 첫 줄은 PR 링크입니다.**');
      expect(rule).toBeGreaterThan(-1);
      expect(rule).toBeLessThan(body.indexOf('## 리뷰 컨텍스트'));
      expect(body).toMatch(/PR 링크 바로 아래에 리뷰 컨텍스트 블록/);
      expect(body).not.toMatch(/전체 출력 최상단에 리뷰 컨텍스트/);
    });

    it('앞에서 말했어도 다시 넣는다', () => {
      expect(result()).toMatch(/앞에서 이미 링크를 말했어도 다시 넣습니다/);
    });

    it('prTarget마다 첫 줄이 정해져 있다', () => {
      const rows = result()
        .split('\n')
        .filter((l) => /^\| `(github|local|none)` \|/.test(l));
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatch(/`url` 그대로/);
      expect(rows[1]).toMatch(/gestalt pr show <id>/);
      expect(rows[2]).toMatch(/줄을 뺍니다/);
    });

    it('링크는 gh가 낸 url을 쓰고 손수 조립하지 않는다', () => {
      // 1단계 조회가 url을 안 받으면 표가 가리키는 값이 없다
      expect(review).toMatch(/--json number,title,body,headRefName,baseRefName,headRefOid,url/);
      expect(result()).toMatch(/손수 조립하지 않습니다/);
      expect(result()).toMatch(/게시 준비 절의 `gh pr view` 결과에서 `url`/);
    });
  });

  describe('review-loop', () => {
    const report = () => section(loop, '## 완료 보고');

    it('Phase 5가 판정과 함께 url을 받는다', () => {
      const fill = section(loop, '### 출력값 채우기 — 어느 경로로 끝나든 먼저 한다');
      expect(fill).toMatch(/--json reviewDecision,url/);
      expect(fill).toMatch(/^prUrl=/m);
      expect(fill).toMatch(/손수 조립하지 않는다/);
    });

    it('어느 경로로 끝나든 첫 줄이 PR URL이다', () => {
      expect(report()).toMatch(/\*\*첫 줄은 PR URL이다\.\*\*/);
      for (const state of ['approved', 'waiting', 'blocked', 'escalated', 'closed']) {
        expect(report()).toContain(`\`${state}\``);
      }
      expect(report()).toMatch(/이미 링크를 말했어도 다시 넣는다/);
    });

    it('URL을 못 받았으면 지어내지 않는다', () => {
      expect(report()).toMatch(/링크를 못 받았다고 적는다/);
      expect(report()).toMatch(/링크를 지어내지 않는다/);
    });

    it('종료 문구 예시가 전부 PR URL로 시작한다', () => {
      const endings = [
        '#{prNumber} 아직 대응 중이에요.',
        '#{prNumber} — 같은 이슈가 3라운드 연속 남아서 여기서 멈출게요.',
        '#{prNumber} 승인했습니다. ({N}라운드)',
        '#{prNumber} — {maxRounds}라운드 안에 안 끝났어요.',
      ];
      for (const line of endings) {
        expect(loop.split(line), `${line} 예시가 하나가 아니다`).toHaveLength(2);
        expect(loop.split(line)[0]!.endsWith('```\n{prUrl}\n\n'), line).toBe(true);
      }

      const example = report().split('```')[1]!;
      expect(example.trimStart()).toMatch(/^https:\/\/github\.com\/[^\n]+\/pull\/\d+\n/);
    });
  });
});
