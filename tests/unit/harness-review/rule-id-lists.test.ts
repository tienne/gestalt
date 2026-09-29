import { afterEach, describe, expect, it } from 'vitest';
import {
  changedRuleIds,
  findRuleIdListGaps,
  findRuleIdListGapsFromGit,
  findRuleIdLists,
  insertionLine,
} from '../../../src/harness-review/rule-id-lists.js';
import { cleanupFakeRepos, createCommitPair, createFakeRepo } from '../../helpers/fake-repo.js';

const RULEBOOK = 'docs/rules.md';

const rulebook = (extra = '') =>
  [
    '# 룰북',
    '',
    '| ID | 패턴 |',
    '|---|---|',
    '| W-1 | 첫 룰 |',
    '| W-2 | 둘째 룰 |',
    '| W-3 | 셋째 룰 |',
    '| W-4 | 넷째 룰 |',
    extra,
    '',
  ].join('\n');

const sortedList = ['export const PICKED = [', "  'W-1',", "  'W-2',", "  'W-4',", '];', ''].join(
  '\n',
);

const unsortedList = [
  'const CHECKS = [',
  "  { name: 'a', ids: ['W-4'] },",
  "  { name: 'b', ids: ['W-1', 'W-2'] },",
  '];',
  '',
].join('\n');

function diffAdding(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,1 +1,${lines.length + 1} @@`,
    ' # 룰북',
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

afterEach(() => cleanupFakeRepos());

describe('changedRuleIds', () => {
  it('md 추가 줄 중 룰 정의 줄의 ID만 룰북별로 모은다', () => {
    const diff = diffAdding(RULEBOOK, ['| W-3 | 셋째 룰 |', '여기서는 W-1을 언급만 한다']);
    expect([...(changedRuleIds(diff).get(RULEBOOK) ?? [])]).toEqual(['W-3']);
  });

  it('코드 파일의 추가 줄은 정의로 안 본다', () => {
    expect(changedRuleIds(diffAdding('src/a.ts', ["'W-3',"])).size).toBe(0);
  });
});

describe('findRuleIdLists', () => {
  it('따옴표 친 ID가 이어진 구간을 목록 하나로 묶고 둘 이하는 버린다', () => {
    const content = `${sortedList}\n\n\nconst TWO = ['W-1', 'W-2'];\n`;
    const lists = findRuleIdLists('a.ts', content);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ startLine: 2, endLine: 4 });
    expect([...lists[0]!.ids]).toEqual(['W-1', 'W-2', 'W-4']);
  });
});

describe('insertionLine', () => {
  it('정렬된 목록은 순서상 들어갈 줄을 준다', () => {
    const [list] = findRuleIdLists('a.ts', sortedList);
    expect(insertionLine(list!, 'W-3')).toBe(4);
    expect(insertionLine(list!, 'W-0')).toBe(2);
  });

  it('정렬되지 않은 목록은 끝 다음 줄을 준다', () => {
    const [list] = findRuleIdLists('a.ts', unsortedList);
    expect(insertionLine(list!, 'W-3')).toBe(4);
  });
});

describe('findRuleIdListGaps', () => {
  const files: Record<string, string> = {
    [RULEBOOK]: rulebook(),
    'src/picked.ts': sortedList,
    'src/checks.ts': unsortedList,
    'src/other.ts': "const X = ['Q-1', 'Q-2', 'Q-3'];\n",
    'docs/guide.md': "- 'W-1', 'W-2', 'W-4'\n",
  };
  const input = (diff: string) => ({
    diff,
    files: Object.keys(files),
    readFile: (p: string) => files[p],
    repoName: 'acme/widget-kit',
  });

  it('바뀐 룰 ID가 빠진 같은 룰북 목록을 전부 판정 대상으로 낸다', () => {
    const gaps = findRuleIdListGaps(input(diffAdding(RULEBOOK, ['| W-3 | 셋째 룰 |'])));
    expect(gaps.map((g) => [g.sourceFile, g.sourceLine])).toEqual([
      ['src/picked.ts', 4],
      ['src/checks.ts', 4],
    ]);
    expect(gaps[0]).toMatchObject({
      kind: 'ruleIdListGap',
      targetRepo: 'acme/widget-kit',
      targetPath: RULEBOOK,
      matchedText: 'W-3',
      needsLlmJudgment: true,
    });
    expect(gaps[0]!.contextLines).toContain("  'W-2',");
  });

  it('테스트와 fixture 목록, 같은 파일 다른 구간에 ID가 이미 있는 목록은 건너뛴다', () => {
    const more: Record<string, string> = {
      ...files,
      'tests/unit/rules.test.ts': sortedList,
      'src/rules.spec.ts': sortedList,
      'src/registry.ts': `${sortedList}\n\n\n\nconst EXTRA = ['W-3'];\n`,
    };
    const gaps = findRuleIdListGaps({
      ...input(diffAdding(RULEBOOK, ['| W-3 | 셋째 룰 |'])),
      files: Object.keys(more),
      readFile: (p) => more[p],
    });
    expect(gaps.map((g) => g.sourceFile)).toEqual(['src/picked.ts', 'src/checks.ts']);
  });

  it('목록에 이미 있는 ID면 후보가 없다', () => {
    expect(findRuleIdListGaps(input(diffAdding(RULEBOOK, ['| W-2 | 둘째 룰 |'])))).toEqual([]);
  });

  it('룰 정의가 안 바뀐 diff는 파일을 읽지도 않는다', () => {
    let reads = 0;
    const gaps = findRuleIdListGaps({
      diff: diffAdding('src/a.ts', ['const a = 1;']),
      files: Object.keys(files),
      readFile: (p) => {
        reads++;
        return files[p];
      },
    });
    expect(gaps).toEqual([]);
    expect(reads).toBe(0);
  });
});

describe('findRuleIdListGapsFromGit', () => {
  it('룰북 정의 줄을 고친 PR에서 그 룰이 빠진 코드 목록을 찾는다', () => {
    const repo = createFakeRepo({ name: 'widget-kit' });
    const pair = createCommitPair(repo, {
      base: { [RULEBOOK]: rulebook(), 'scripts/picked.ts': sortedList },
      head: { [RULEBOOK]: rulebook().replace('| W-3 | 셋째 룰 |', '| W-3 | 셋째 룰, 더 넓게 |') },
      headBranch: 'widen-w3',
    });
    const gaps = findRuleIdListGapsFromGit(
      repo.root,
      pair.baseSha,
      pair.headSha,
      'acme/widget-kit',
    );
    expect(gaps).toEqual([
      expect.objectContaining({
        sourceFile: 'scripts/picked.ts',
        sourceLine: 4,
        matchedText: 'W-3',
      }),
    ]);
  });
});
