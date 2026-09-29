import { afterEach, describe, expect, it } from 'vitest';
import { cleanupFakeRepos, createFakeRepo } from '../../helpers/fake-repo.js';
import {
  buildIsolatedOrg,
  buildPlaceholderOrg,
  buildReceiveOnlyOrg,
} from '../../fixtures/harness-repos/scenarios.js';
import {
  extractHeadingSlugs,
  forwardSearch,
  FORWARD_SEARCH_LIMITATIONS,
  MAX_PR_LOOKUPS,
} from '../../../src/harness-review/forward-search.js';
import { REFERENCE_CANDIDATE_KINDS } from '../../../src/harness-review/types.js';

afterEach(cleanupFakeRepos);

const noGh = () => {
  throw new Error('gh를 부르면 안 된다');
};

function ghWith(states: Record<string, string>) {
  const calls: string[][] = [];
  const gh = (args: readonly string[]) => {
    calls.push([...args]);
    const number = args[2]!;
    const state = states[number];
    if (!state) {
      throw Object.assign(new Error('failed'), {
        stderr: `Could not resolve to a PullRequest with the number of ${number}.`,
      });
    }
    return JSON.stringify({ state, mergedAt: state === 'MERGED' ? '2026-01-01T00:00:00Z' : null });
  };
  return { gh, calls };
}

function docRepo(files: Record<string, string>, name = 'acme-app') {
  const repo = createFakeRepo({ name, files });
  return { repo, own: { repo: `acme/${name}`, dir: repo.root } };
}

describe('forwardSearch 경로와 헤딩', () => {
  it('없는 경로만 후보로 올리고 kind는 forwardRef다', () => {
    const { own } = docRepo({
      'docs/a.md': '`docs/b.md`를 읽는다. `docs/gone.md`도 읽는다.\n',
      'docs/b.md': '# b\n',
    });
    const r = forwardSearch({ ownRepo: own, files: ['docs/a.md'], gh: noGh });
    expect(REFERENCE_CANDIDATE_KINDS).toContain('forwardRef');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      kind: 'forwardRef',
      sourceFile: 'docs/a.md',
      sourceLine: 1,
      targetRepo: 'acme/acme-app',
      targetPath: 'docs/gone.md',
      needsLlmJudgment: false,
    });
  });

  it('플러그인 루트 기준 상대 경로와 다른 레포에 있는 경로는 후보가 아니다', () => {
    const other = createFakeRepo({ name: 'widget-kit', files: { 'rules/x.md': '# x\n' } });
    const { own } = docRepo({
      'plugin/skills/s/SKILL.md': '`references/r.md`와 `rules/x.md`를 본다.\n',
      'plugin/skills/s/references/r.md': '# r\n',
    });
    const r = forwardSearch({
      ownRepo: own,
      otherRepos: [{ repo: 'acme/widget-kit', dir: other.root }],
      files: ['plugin/skills/s/SKILL.md'],
      gh: noGh,
    });
    expect(r.candidates).toEqual([]);
  });

  it('코드 펜스, 글롭, 절대 경로는 건너뛰고 생성 문맥은 LLM 판정으로 넘긴다', () => {
    const { own } = docRepo({
      'docs/a.md': [
        '```',
        'cat docs/in-fence.md',
        '```',
        '`skills/*/SKILL.md`와 `/usr/local/x.md`는 예시다.',
        '결과는 `out/report.md`에 저장한다.',
      ].join('\n'),
    });
    const r = forwardSearch({ ownRepo: own, files: ['docs/a.md'], gh: noGh });
    expect(r.candidates.map((c) => c.targetPath)).toEqual(['out/report.md']);
    expect(r.candidates[0]!.needsLlmJudgment).toBe(true);
  });

  it('헤딩 앵커가 없으면 후보로 올린다(같은 문서, 다른 문서)', () => {
    const { own } = docRepo({
      'docs/a.md': [
        '# 시작',
        ['[여기]', '(#시작)와 [저기]', '(#없는-절)를 본다.'].join(''),
        '`docs/b.md#second-part`와 `docs/b.md#missing`.',
      ].join('\n'),
      'docs/b.md': '# B\n\n## Second Part\n',
    });
    const r = forwardSearch({ ownRepo: own, files: ['docs/a.md'], gh: noGh });
    expect(r.candidates.map((c) => c.targetPath).sort()).toEqual(
      ['docs/a.md#없는-절', 'docs/b.md#missing'].sort(),
    );
  });

  it('헤딩 슬러그는 중복에 번호를 붙이고 펜스 안 #은 헤딩이 아니다', () => {
    const slugs = extractHeadingSlugs('# A\n## A\n```\n# no\n```\n## 한글 제목!\n');
    expect([...slugs]).toEqual(['a', 'a-1', '한글-제목']);
  });

  it('GitHub blob 링크는 로컬 체크아웃이 있는 레포만 확인한다', () => {
    const other = createFakeRepo({ name: 'widget-kit', files: { 'src/a.ts': '1\n' } });
    const { own } = docRepo({
      'docs/a.md': [
        '[ok](https://github.com/acme/widget-kit/blob/main/src/a.ts#L3)',
        '[gone](https://github.com/acme/widget-kit/blob/main/src/gone.ts)',
        '[branch](https://github.com/acme/widget-kit/blob/feature/src/gone2.ts)',
        '[unknown](https://github.com/acme/elsewhere/blob/main/x/y.ts)',
      ].join('\n'),
    });
    const r = forwardSearch({
      ownRepo: own,
      otherRepos: [{ repo: 'acme/widget-kit', dir: other.root }],
      files: ['docs/a.md'],
      gh: noGh,
    });
    expect(r.candidates.map((c) => [c.targetPath, c.needsLlmJudgment])).toEqual([
      ['src/gone.ts', false],
      // 기본 브랜치가 아닌 ref는 로컬과 다를 수 있어 판정으로 넘긴다
      ['src/gone2.ts', true],
    ]);
  });
});

describe('forwardSearch PR 번호', () => {
  const doc = [
    '#1 은 머지 전이라 아직 쓰지 않는다.',
    '#2 는 이미 머지됐다.',
    '#3 을 참고한다.',
    '`#fff` 색을 쓴다.',
    'https://github.com/acme/widget-kit/pull/4 가 머지되면 바꾼다.',
    '#9 는 머지 전이다.',
  ].join('\n');

  it('머지 전이라는 문장과 실제 상태가 어긋나는 것만 후보로 올린다', () => {
    const { own } = docRepo({ 'docs/a.md': doc });
    const { gh, calls } = ghWith({ '1': 'MERGED', '2': 'OPEN', '3': 'MERGED', '4': 'OPEN' });
    const r = forwardSearch({ ownRepo: own, files: ['docs/a.md'], gh });
    const byLine = Object.fromEntries(r.candidates.map((c) => [c.sourceLine, c]));
    expect(byLine[1]).toMatchObject({ targetRepo: 'acme/acme-app', targetPath: 'pull/1' });
    expect(byLine[2]).toMatchObject({ targetPath: 'pull/2' });
    expect(byLine[3]).toBeUndefined();
    expect(byLine[5]).toBeUndefined();
    // 없는 번호는 이슈일 수 있어 LLM 판정으로 넘긴다
    expect(byLine[6]).toMatchObject({ targetPath: 'pull/9', needsLlmJudgment: true });
    expect(calls.every((c) => c[0] === 'pr' && c.includes('--repo'))).toBe(true);
    expect(calls.map((c) => c[2]).sort()).toEqual(['1', '2', '3', '4', '9']);
  });

  it('같은 PR은 한 번만 조회한다', () => {
    const { own } = docRepo({ 'docs/a.md': '#1 머지 전.\n#1 머지 전이다.\n' });
    const { gh, calls } = ghWith({ '1': 'OPEN' });
    forwardSearch({ ownRepo: own, files: ['docs/a.md'], gh });
    expect(calls).toHaveLength(1);
  });

  it('조회가 막히면 blocked와 한계를 싣고 경로 검사는 계속한다', () => {
    const { own } = docRepo({ 'docs/a.md': '#1 머지 전.\n`docs/gone.md`\n#2 머지 전.\n' });
    let n = 0;
    const gh = () => {
      n++;
      throw Object.assign(new Error('x'), {
        stderr: 'To get started with GitHub CLI, please run: gh auth login',
      });
    };
    const r = forwardSearch({ ownRepo: own, files: ['docs/a.md'], gh });
    expect(r.blocked?.reason).toBe('notLoggedIn');
    expect(n).toBe(1);
    expect(r.candidates.map((c) => c.targetPath)).toEqual(['docs/gone.md']);
    expect(r.limitations.some((l) => l.includes('notLoggedIn'))).toBe(true);
  });

  it('조회 상한을 넘으면 건너뛰고 한계로 적는다', () => {
    const lines = Array.from({ length: MAX_PR_LOOKUPS + 3 }, (_, i) => `#${i + 1} 머지 전.`);
    const { own } = docRepo({ 'docs/a.md': lines.join('\n') });
    const { gh, calls } = ghWith({});
    const r = forwardSearch({ ownRepo: own, files: ['docs/a.md'], gh });
    expect(calls).toHaveLength(MAX_PR_LOOKUPS);
    expect(r.limitations.some((l) => l.includes('3건은 건너뛰었다'))).toBe(true);
  });

  it('owner를 모르는 레포의 #번호는 조회하지 않고 한계로 적는다', () => {
    const repo = createFakeRepo({ name: 'solo', files: { 'docs/a.md': '#1 머지 전.\n' } });
    const r = forwardSearch({
      ownRepo: { repo: 'solo', dir: repo.root },
      files: ['docs/a.md'],
      gh: noGh,
    });
    expect(r.candidates).toEqual([]);
    expect(r.limitations.some((l) => l.includes('owner'))).toBe(true);
  });

  it('역방향에 PR 상태 대칭이 없다는 한계를 항상 싣는다', () => {
    const { own } = docRepo({ 'docs/a.md': '# a\n' });
    const r = forwardSearch({ ownRepo: own, files: ['docs/a.md'], gh: noGh });
    expect(r.limitations).toEqual(expect.arrayContaining([FORWARD_SEARCH_LIMITATIONS[0]!]));
    expect(FORWARD_SEARCH_LIMITATIONS[0]).toContain('PR 번호 상태');
  });
});

describe('forwardSearch 자리표시자 (AC3)', () => {
  function run(repoName: string) {
    const s = buildPlaceholderOrg();
    const all = Object.entries(s.org.repos).map(([name, r]) => ({ repo: name, dir: r.root }));
    const own = all.find((r) => r.repo === repoName)!;
    const files = Object.values(s.files)
      .filter((f) => f.repo === repoName)
      .map((f) => f.file);
    return { s, r: forwardSearch({ ownRepo: own, otherRepos: all, files, gh: noGh }) };
  }

  it('파일마다 다른 레포로 풀린 자리표시자는 후보를 만들지 않는다', () => {
    const w = run('widget-kit');
    const naming = w.s.files.pointsToDesignKit.file;
    expect(w.r.candidates.filter((c) => c.sourceFile === naming)).toEqual([]);
    const a = run('acme-app');
    // 자기 레포 우선으로 풀린 $REPO_ROOT/package.json과 다른 레포로 풀린 theme.ts
    expect(a.r.candidates).toEqual([]);
  });

  it('여러 레포에 맞거나 하나도 안 맞으면 LLM 판정 후보로 표시한다', () => {
    const { s, r } = run('widget-kit');
    const collision = r.candidates.find((c) => c.sourceFile === s.files.commonPathCollision.file)!;
    expect(collision).toMatchObject({
      kind: 'forwardRef',
      needsLlmJudgment: true,
      targetPath: 'README.md',
    });
    expect(collision.targetRepo.split(',').sort()).toEqual([
      'acme-app',
      'design-kit',
      'widget-kit',
    ]);
    const ghost = r.candidates.find((c) => c.sourceFile === s.files.matchesNothing.file)!;
    expect(ghost).toMatchObject({ needsLlmJudgment: true, targetRepo: '' });
    expect(r.candidates).toHaveLength(2);
  });
});

describe('forwardSearch 참조 없는 레포와 받기만 하는 레포 (AC7)', () => {
  it('참조를 주지도 받지도 않는 레포는 후보가 0건이다', () => {
    const s = buildIsolatedOrg();
    const lonely = s.org.repos[s.isolated]!;
    const others = Object.entries(s.org.repos).map(([name, r]) => ({ repo: name, dir: r.root }));
    const r = forwardSearch({
      ownRepo: { repo: s.isolated, dir: lonely.root },
      otherRepos: others,
      files: ['plugin/skills/tidy/SKILL.md', 'docs/notes.md'],
      gh: noGh,
    });
    expect(r.candidates).toEqual([]);
  });

  it('받기만 하는 레포는 이름이 바뀌어도 순방향 후보가 0건이다', () => {
    const s = buildReceiveOnlyOrg();
    const receiver = s.org.repos[s.receiver]!;
    const others = Object.entries(s.org.repos).map(([name, r]) => ({ repo: name, dir: r.root }));
    const r = forwardSearch({
      ownRepo: { repo: s.receiver, dir: receiver.root },
      otherRepos: others,
      files: [`plugin/skills/${s.rename.newName}/SKILL.md`, 'README.md'],
      gh: noGh,
    });
    expect(r.candidates).toEqual([]);
  });
});
