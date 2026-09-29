import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupFakeRepos } from '../../helpers/fake-repo.js';
import {
  buildThreeStateOrg,
  type ThreeStateCase,
  type ThreeStateScenario,
} from '../../fixtures/harness-repos/scenarios.js';
import {
  decideThreeStateVerdict,
  judgeThreeState,
  type JudgeThreeStateInput,
} from '../../../src/harness-review/three-state.js';
import type { RelatedPR } from '../../../src/harness-review/types.js';

afterEach(cleanupFakeRepos);

const spawnGit = (dir: string, args: string[]) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout };
};

const CURRENT = 'acme/widget-kit';
const TARGET = 'acme/design-kit';

function relatedPr(s: ThreeStateScenario, over: Partial<RelatedPR> = {}): RelatedPR {
  return {
    repo: TARGET,
    number: 7,
    headSha: s.provider.relatedHeadSha,
    state: 'open',
    foundBy: 'bodyLink',
    confirmation: 'confirmed',
    ...over,
  };
}

function input(s: ThreeStateScenario, prs: RelatedPR[]): JudgeThreeStateInput {
  return {
    currentRepo: CURRENT,
    identifier: {
      kind: 'ruleId',
      value: s.identifier,
      changeType: 'modified',
      extractedBy: 'pattern',
    },
    target: {
      repo: TARGET,
      dir: s.org.repos['design-kit']!.root,
      defaultBranch: s.provider.mainBranch,
    },
    relatedPrs: prs,
  };
}

// 연관 PR이 main이 아닌 별도 브랜치로 머지된 상태를 만든다. main은 그대로라 기준 브랜치를 잘못 고르면 결과가 달라진다
function mergeRelatedInto(s: ThreeStateScenario, branch: string): void {
  const provider = s.org.repos['design-kit']!;
  provider.git('branch', branch, s.provider.mainBranch);
  provider.git('checkout', '-q', branch);
  provider.git('merge', '-q', '--no-ff', '-m', 'merge related', s.provider.relatedBranch);
  provider.git('checkout', '-q', s.provider.mainBranch);
}

describe('decideThreeStateVerdict', () => {
  it('머지 후 상태가 기준이다', () => {
    expect(
      decideThreeStateVerdict({ onMain: 'broken', onRelatedHead: 'ok', afterBothMerged: 'ok' }),
    ).toBe('notDefect_mergeOrder');
    expect(
      decideThreeStateVerdict({
        onMain: 'broken',
        onRelatedHead: 'broken',
        afterBothMerged: 'broken',
      }),
    ).toBe('defect');
    expect(
      decideThreeStateVerdict({ onMain: 'ok', onRelatedHead: 'broken', afterBothMerged: 'broken' }),
    ).toBe('relatedRemovesUsed');
    expect(
      decideThreeStateVerdict({ onMain: 'ok', onRelatedHead: 'ok', afterBothMerged: 'ok' }),
    ).toBeNull();
  });
});

describe('judgeThreeState: 열린 연관 PR', () => {
  const cases: ThreeStateCase[] = ['mergeOrder', 'bothBroken', 'relatedRemovesUsed'];

  it.each(cases)('%s fixture가 기대한 판정을 낸다', async (kind) => {
    const s = buildThreeStateOrg(kind);
    const [j] = await judgeThreeState(input(s, [relatedPr(s)]));

    expect(j!.checked).toBe(true);
    expect(j!.states).toMatchObject({
      onMain: s.expected.onMain,
      onRelatedHead: s.expected.onRelatedHead,
    });
    expect(j!.verdict?.verdict).toBe(s.expected.verdict);
    expect(j!.verdict?.onMain).toBe(s.expected.onMain);
    expect(j!.basis?.mode).toBe('openHead');
    expect(j!.basis?.relatedPr.headSha).toBe(s.provider.relatedHeadSha);
    expect(j!.basis?.mainRef).toBe('main');
    expect(j!.basis?.afterMergeRef).toMatch(/^[0-9a-f]{40}$/);
  });

  it('머지 순서 문제와 결함은 이번 PR에만, 지운 경우는 두 레포 모두에 알린다', async () => {
    const order = buildThreeStateOrg('mergeOrder');
    const [a] = await judgeThreeState(input(order, [relatedPr(order)]));
    expect(a!.verdict?.notifyRepos).toEqual([CURRENT]);

    const broken = buildThreeStateOrg('bothBroken');
    const [b] = await judgeThreeState(input(broken, [relatedPr(broken)]));
    expect(b!.verdict?.notifyRepos).toEqual([CURRENT]);

    const removes = buildThreeStateOrg('relatedRemovesUsed');
    const [c] = await judgeThreeState(input(removes, [relatedPr(removes)]));
    expect(c!.verdict?.notifyRepos).toEqual([CURRENT, TARGET]);
    expect(c!.states?.afterBothMerged).toBe('broken');
  });
});

describe('judgeThreeState: 머지된 연관 PR (mergedBranch 기준)', () => {
  it('머지 순서 fixture를 머지된 브랜치로 보면 문제가 없다', async () => {
    const s = buildThreeStateOrg('mergeOrder');
    mergeRelatedInto(s, 'develop');

    const [j] = await judgeThreeState(
      input(s, [relatedPr(s, { state: 'merged', mergedBranch: 'develop' })]),
    );
    expect(j!.checked).toBe(true);
    expect(j!.states).toEqual({ onMain: 'ok', onRelatedHead: 'ok', afterBothMerged: 'ok' });
    expect(j!.verdict).toBeNull();
    expect(j!.basis).toMatchObject({
      mode: 'mergedBranch',
      mainRef: 'develop',
      afterMergeRef: 'develop',
      relatedPr: { number: 7, state: 'merged', headSha: s.provider.relatedHeadSha },
    });
  });

  it('지운 쪽이 이미 머지됐으면 이번 PR의 결함이다', async () => {
    const s = buildThreeStateOrg('relatedRemovesUsed');
    mergeRelatedInto(s, 'develop');

    const [j] = await judgeThreeState(
      input(s, [relatedPr(s, { state: 'merged', mergedBranch: 'develop' })]),
    );
    expect(j!.states).toEqual({
      onMain: 'broken',
      onRelatedHead: 'broken',
      afterBothMerged: 'broken',
    });
    expect(j!.verdict?.verdict).toBe('defect');
    expect(j!.verdict?.notifyRepos).toEqual([CURRENT]);
  });

  it('머지된 브랜치가 clone에 없으면 기본 브랜치로 보고 한계로 남긴다', async () => {
    const s = buildThreeStateOrg('bothBroken');
    const [j] = await judgeThreeState(
      input(s, [relatedPr(s, { state: 'merged', mergedBranch: 'release' })]),
    );
    expect(j!.basis?.mainRef).toBe('main');
    expect(j!.verdict?.verdict).toBe('defect');
    expect(j!.limitations.join('\n')).toContain('release');
  });
});

describe('judgeThreeState: 근거 제한', () => {
  it('확정 안 된 연관 PR은 판정 근거로 안 쓰고 main만 본다', async () => {
    const s = buildThreeStateOrg('mergeOrder');
    const [j] = await judgeThreeState(
      input(s, [relatedPr(s, { confirmation: 'needsAuthorAnswer' })]),
    );
    expect(j!.basis).toBeNull();
    expect(j!.verdict?.verdict).toBe('defect');
    expect(j!.unconfirmedRelatedPrs).toEqual([{ repo: TARGET, number: 7 }]);
    expect(j!.limitations.join('\n')).toContain('확정 안 된');
  });

  it('다른 레포의 연관 PR은 이 참조의 판정에 안 섞는다', async () => {
    const s = buildThreeStateOrg('mergeOrder');
    const [j] = await judgeThreeState(input(s, [relatedPr(s, { repo: 'acme/other' })]));
    expect(j!.basis).toBeNull();
    expect(j!.unconfirmedRelatedPrs).toEqual([]);
  });

  it('head가 clone에 없으면 판정하지 않는다', async () => {
    const s = buildThreeStateOrg('mergeOrder');
    const [j] = await judgeThreeState(input(s, [relatedPr(s, { headSha: 'f'.repeat(40) })]));
    expect(j!.checked).toBe(false);
    expect(j!.verdict).toBeNull();
    expect(j!.limitations.join('\n')).toContain('fetch');
  });

  it('닫힌 연관 PR은 빼고 main만 본다', async () => {
    const s = buildThreeStateOrg('mergeOrder');
    const [j] = await judgeThreeState(input(s, [relatedPr(s, { state: 'closed' })]));
    expect(j!.basis).toBeNull();
    expect(j!.verdict?.verdict).toBe('defect');
    expect(j!.limitations.join('\n')).toContain('#7');
  });

  it('가상 머지가 충돌하면 연관 PR head로 머지 후를 대신한다', async () => {
    const s = buildThreeStateOrg('relatedRemovesUsed');
    const real = spawnGit;
    const [j] = await judgeThreeState({
      ...input(s, [relatedPr(s)]),
      runGit: (dir, args) =>
        args[0] === 'merge-tree' ? { status: 1, stdout: '' } : real(dir, args),
    });
    expect(j!.basis?.afterMergeRef).toBe(s.provider.relatedHeadSha);
    expect(j!.states?.afterBothMerged).toBe('broken');
    expect(j!.limitations.join('\n')).toContain('충돌');
  });

  it('LLM이 뽑은 식별자는 검색하지 않는다', async () => {
    const s = buildThreeStateOrg('mergeOrder');
    const base = input(s, [relatedPr(s)]);
    const [j] = await judgeThreeState({
      ...base,
      identifier: { ...base.identifier, extractedBy: 'llm' },
    });
    expect(j!.checked).toBe(false);
  });

  it('path 식별자는 파일 존재로도 살아 있다고 본다', async () => {
    const s = buildThreeStateOrg('relatedRemovesUsed');
    const base = input(s, [relatedPr(s)]);
    const [j] = await judgeThreeState({
      ...base,
      identifier: { ...base.identifier, kind: 'path', value: 'rules/rule-used.md' },
    });
    expect(j!.states?.onMain).toBe('ok');
    expect(j!.verdict?.verdict).toBe('relatedRemovesUsed');
  });
});
