import { afterEach, describe, expect, it } from 'vitest';
import { cleanupFakeRepos } from '../../helpers/fake-repo.js';
import { buildPlaceholderOrg } from '../../fixtures/harness-repos/scenarios.js';
import {
  extractPlaceholderRefs,
  lookupPlaceholder,
  placeholdersNeedingJudgment,
  resolvePlaceholders,
  type PlaceholderRepo,
} from '../../../src/harness-review/placeholders.js';

afterEach(cleanupFakeRepos);

function setup(ownName: string) {
  const s = buildPlaceholderOrg();
  const all: PlaceholderRepo[] = Object.entries(s.org.repos).map(([name, r]) => ({
    repo: name,
    dir: r.root,
  }));
  const own = all.find((r) => r.repo === ownName)!;
  const results = resolvePlaceholders({ ownRepo: own, otherRepos: all });
  return { s, results };
}

describe('extractPlaceholderRefs', () => {
  it('중괄호, $, ${} 꼴에서 토큰과 경로를 뽑고 문장부호는 뗀다', () => {
    const refs = extractPlaceholderRefs(
      '`{DESIGN_ROOT}/rules/a.md`를 본다.\n$REPO_ROOT/b.json, ${REPO_ROOT}/c/.\n{REPO_ROOT}만 있다',
    );
    expect(refs).toEqual([
      { token: '{DESIGN_ROOT}', path: 'rules/a.md', line: 1 },
      { token: '$REPO_ROOT', path: 'b.json', line: 2 },
      { token: '${REPO_ROOT}', path: 'c', line: 2 },
      { token: '{REPO_ROOT}', path: '', line: 3 },
    ]);
  });
});

describe('resolvePlaceholders', () => {
  it('같은 {REPO_ROOT}가 파일마다 다른 레포로 풀린다', () => {
    const w = setup('widget-kit');
    const a = setup('acme-app');
    const f = w.s.files;
    const naming = lookupPlaceholder(w.results, f.pointsToDesignKit.file, '{REPO_ROOT}')!;
    expect(naming.resolutionStatus).toBe('single');
    expect(naming.resolvedRepo).toBe('design-kit');
    expect(naming.reason).toBe('unique');

    const theme = lookupPlaceholder(a.results, f.pointsToWidgetKit.file, '{REPO_ROOT}')!;
    expect(theme.resolutionStatus).toBe('single');
    expect(theme.resolvedRepo).toBe('widget-kit');
    expect(naming.resolvedRepo).not.toBe(theme.resolvedRepo);
  });

  it('자기 레포에 경로가 있으면 다른 레포에도 있어도 자기 레포로 끝난다', () => {
    const { s, results } = setup('acme-app');
    const r = lookupPlaceholder(results, s.files.ownRepoFirst.file, '$REPO_ROOT')!;
    expect(r.resolutionStatus).toBe('single');
    expect(r.resolvedRepo).toBe('acme-app');
    expect(r.reason).toBe('ownRepo');
    expect(r.needsLlmJudgment).toBe(false);
  });

  it('README.md처럼 어디에나 있는 문서는 자기 레포 우선을 못 써서 multiple로 남는다', () => {
    const { s, results } = setup('widget-kit');
    const r = lookupPlaceholder(results, s.files.commonPathCollision.file, '{REPO_ROOT}')!;
    expect(r.resolutionStatus).toBe('multiple');
    expect(r.resolvedRepo).toBeUndefined();
    expect(r.matchedRepos.sort()).toEqual(['acme-app', 'design-kit', 'widget-kit']);
    expect(r.needsLlmJudgment).toBe(true);
  });

  it('어느 레포에도 없으면 none이고 LLM 판정 대상이다', () => {
    const { s, results } = setup('widget-kit');
    const r = lookupPlaceholder(results, s.files.matchesNothing.file, '{REPO_ROOT}')!;
    expect(r.resolutionStatus).toBe('none');
    expect(r.reason).toBe('unmatched');
    expect(r.needsLlmJudgment).toBe(true);
    expect(placeholdersNeedingJudgment(results).map((x) => x.definingFile)).toEqual(
      expect.arrayContaining([s.files.commonPathCollision.file, s.files.matchesNothing.file]),
    );
  });

  it('같은 파일의 여러 경로는 모두 있는 레포만 후보가 된다', () => {
    const s = buildPlaceholderOrg();
    const own = { repo: 'widget-kit', dir: s.org.repos['widget-kit']!.root };
    const design = { repo: 'design-kit', dir: s.org.repos['design-kit']!.root };
    s.org.repos['widget-kit']!.write(
      'plugin/skills/two/SKILL.md',
      '`{REPO_ROOT}/rules/naming.md`와 `{REPO_ROOT}/nope.md`\n',
    );
    const [r] = resolvePlaceholders({
      ownRepo: own,
      otherRepos: [design],
      files: ['plugin/skills/two/SKILL.md'],
    });
    expect(r!.paths).toEqual(['nope.md', 'rules/naming.md']);
    expect(r!.resolutionStatus).toBe('none');
  });

  it('경로 없이 토큰만 있으면 근거가 없어 none으로 넘긴다', () => {
    const s = buildPlaceholderOrg();
    const own = { repo: 'widget-kit', dir: s.org.repos['widget-kit']!.root };
    s.org.repos['widget-kit']!.write('docs/x.md', '`{REPO_ROOT}`가 뭔지 모른다\n');
    const [r] = resolvePlaceholders({ ownRepo: own, otherRepos: [], files: ['docs/x.md'] });
    expect(r!.reason).toBe('noPath');
    expect(r!.needsLlmJudgment).toBe(true);
  });
});
