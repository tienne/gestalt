import { afterEach, describe, expect, it } from 'vitest';
import { findRuleOverlapFromGit } from '../../../src/harness-review/rule-overlap.js';
import { cleanupFakeRepos, createCommitPair, createFakeRepo } from '../../helpers/fake-repo.js';

const RULEBOOK = 'plugin/role-agents/_shared/references/rules.md';

const rulebook = (f11: string) =>
  [
    '# 룰북',
    '',
    '| ID | 패턴 | 심각도 | 처방 |',
    '|---|---|---|---|',
    '| F-7 | 기술 비유 ("증류") | S2 | 일상 말로 되돌린다 ("추려내다") |',
    '| F-9 | 결함 별칭 ("맨몸 호출") | S2 | **예외는 남이 정의해 둔 이름이다** ("널 포인터") |',
    f11,
    '',
  ].join('\n');

const F11_BASE = '| F-11 | 직역 ("은탄환") | S2 | 걷는다 |';
const F11_HEAD =
  '| F-11 | 직역 ("은탄환") | S2 | 걷는다. **F-9와는 출처로 갈린다** — F-9는 지어낸 별칭이다 |';

describe('findRuleOverlapFromGit', () => {
  afterEach(() => cleanupFakeRepos());

  it('이번 변경에서 새로 생긴 경계 문장을 질문 후보로 싣는다', () => {
    const repo = createFakeRepo();
    const pair = createCommitPair(repo, {
      base: { [RULEBOOK]: rulebook(F11_BASE) },
      head: { [RULEBOOK]: rulebook(F11_HEAD) },
      headBranch: 'f11-boundary',
    });
    const found = findRuleOverlapFromGit(repo.root, pair.baseSha, pair.headSha, 'acme/kit');
    expect(found).toEqual([
      expect.objectContaining({
        kind: 'ruleOverlap',
        sourceFile: RULEBOOK,
        sourceLine: 7,
        targetRepo: 'acme/kit',
        needsLlmJudgment: true,
        matchedText: expect.stringContaining('[cited-no-order] F-11가 F-9와의 경계'),
      }),
    ]);
  });

  it('룰북 밖 파일만 바뀌었거나 룰북 문장이 그대로면 후보가 없다', () => {
    const repo = createFakeRepo();
    const pair = createCommitPair(repo, {
      base: { [RULEBOOK]: rulebook(F11_HEAD), 'README.md': 'a' },
      head: { 'README.md': 'b' },
      headBranch: 'readme',
    });
    expect(findRuleOverlapFromGit(repo.root, pair.baseSha, pair.headSha, 'acme/kit')).toEqual([]);
  });

  it('처방이 다른 룰 탐지기에 걸리면 판정이 끝난 후보로 싣는다', () => {
    const repo = createFakeRepo();
    const pair = createCommitPair(repo, {
      base: { [RULEBOOK]: rulebook(F11_BASE) },
      head: {
        [RULEBOOK]: rulebook(F11_BASE).replace('("추려내다")', '("증류해 둔다")'),
      },
      headBranch: 'bad-after',
    });
    const found = findRuleOverlapFromGit(repo.root, pair.baseSha, pair.headSha, 'acme/kit');
    expect(found).toContainEqual(
      expect.objectContaining({
        needsLlmJudgment: false,
        matchedText: expect.stringContaining('[after-hit] F-7 처방 "증류해 둔다"'),
      }),
    );
  });
});
