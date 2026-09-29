import { afterEach, describe, expect, it } from 'vitest';
import { extractIdentifiersFromGit } from '../../../src/harness-review/identifiers.js';
import {
  findSelfReferences,
  pathMatcher,
  vanishedDirs,
} from '../../../src/harness-review/self-references.js';
import { cleanupFakeRepos, createCommitPair, createFakeRepo } from '../../helpers/fake-repo.js';

afterEach(() => cleanupFakeRepos());

describe('vanishedDirs', () => {
  it('head에서 통째로 사라진 디렉토리 중 가장 위쪽만 남긴다', () => {
    expect(
      vanishedDirs(
        ['guides/a.md', 'guides/sub/b.md', 'keep/c.md'],
        ['kit/guides/a.md', 'keep/c.md'],
      ),
    ).toEqual(['guides']);
  });
});

describe('pathMatcher', () => {
  it('더 긴 경로의 꼬리로 걸린 건 버리고 ./ 표기는 같은 경로로 본다', () => {
    const re = pathMatcher('guides/');
    expect(re.test('find ./guides -name "*.md"')).toBe(true);
    expect(re.test('`guides/{name}.md`를 읽는다')).toBe(true);
    expect(re.test('kit/guides/a.md')).toBe(false);
    expect(re.test('myguides/a.md')).toBe(false);
  });
});

describe('findSelfReferences', () => {
  function movedRepo() {
    const repo = createFakeRepo({ name: 'widget-kit' });
    const skill = [
      '---',
      'name: widget-pick',
      'description: 위젯 고르기',
      '---',
      '',
      '1. `guides/{name}.md` 파일을 읽는다',
      '2. 목록은 `find ./guides -name "*.md"`로 만든다',
      '3. `kit/guides/`는 새 자리다',
      '',
    ].join('\n');
    const pair = createCommitPair(repo, {
      base: {
        'guides/button.md': '# 버튼\n',
        'guides/dialog.md': '# 다이얼로그\n',
        '.claude/skills/widget-pick/SKILL.md': skill,
        'docs/history.md': '예전에는 guides/button.md에 있었다\n',
      },
      head: {
        'guides/button.md': null,
        'guides/dialog.md': null,
        'kit/guides/button.md': '# 버튼\n',
        'kit/guides/dialog.md': '# 다이얼로그\n',
        '.claude/skills/new-skill/SKILL.md': '`guides/button.md`를 연다\n',
      },
    });
    return { repo, pair };
  }

  it('옮긴 디렉토리를 옛 이름으로 부르는 diff 밖 하네스 줄을 backwardRef로 낸다', () => {
    const { repo, pair } = movedRepo();
    const identifiers = extractIdentifiersFromGit(repo.root, pair.baseSha, pair.headSha);
    const found = findSelfReferences({
      repoRoot: repo.root,
      base: pair.baseSha,
      head: pair.headSha,
      repo: 'acme/widget-kit',
      identifiers,
    });
    const places = found.map((c) => `${c.sourceFile}:${c.sourceLine}`).sort();
    // 7줄의 kit/guides/는 새 경로, docs/는 하네스가 아니며 new-skill은 이번 diff가 추가한 줄이다
    expect(places).toEqual([
      '.claude/skills/widget-pick/SKILL.md:6',
      '.claude/skills/widget-pick/SKILL.md:7',
    ]);
    expect(found[0]).toMatchObject({ kind: 'backwardRef', targetRepo: 'acme/widget-kit' });
  });

  it('지우거나 바꾼 식별자가 없으면 후보가 없다', () => {
    const repo = createFakeRepo();
    const pair = createCommitPair(repo, {
      base: { 'CLAUDE.md': '# 안내\n' },
      head: { 'CLAUDE.md': '# 안내\n\n한 줄 더\n' },
    });
    expect(
      findSelfReferences({
        repoRoot: repo.root,
        base: pair.baseSha,
        head: pair.headSha,
        repo: 'acme/widget-kit',
        identifiers: extractIdentifiersFromGit(repo.root, pair.baseSha, pair.headSha),
      }),
    ).toEqual([]);
  });
});
