import { spawnSync } from 'node:child_process';
import { LocalCloneBackend } from './search-backend.js';
import type {
  Identifier,
  PrState,
  RelatedPR,
  SingleStateValue,
  ThreeStateVerdict,
  VerdictType,
} from './types.js';

export type GitRunner = (dir: string, args: string[]) => { status: number; stdout: string };

/** 참조 대상 레포의 로컬 clone. 연관 PR head는 이 clone에 fetch돼 있어야 한다 */
export interface ThreeStateTarget {
  /** owner/name */
  repo: string;
  dir: string;
  defaultBranch: string;
}

export interface JudgeThreeStateInput {
  /** 이번 PR이 있는 레포 owner/name */
  currentRepo: string;
  identifier: Identifier;
  target: ThreeStateTarget;
  /** findRelatedPrs 후보를 그대로 넘겨도 된다. confirmed만 판정 근거로 쓴다 */
  relatedPrs: readonly RelatedPR[];
  runGit?: GitRunner;
}

export interface ThreeStateStates {
  onMain: SingleStateValue;
  onRelatedHead: SingleStateValue;
  afterBothMerged: SingleStateValue;
}

/** 재리뷰가 같은 기준으로 다시 보도록 판정에 쓴 ref를 남긴다 */
export interface ThreeStateBasis {
  relatedPr: { repo: string; number: number; state: PrState; headSha: string };
  /** openHead: 열린 PR의 head를 main과 겹쳐 본다. mergedBranch: 이미 머지돼 그 브랜치 하나로 본다 */
  mode: 'openHead' | 'mergedBranch';
  mainRef: string;
  afterMergeRef: string;
}

export interface ThreeStateJudgment {
  identifier: Identifier;
  targetRepo: string;
  /** false면 상태를 못 봤다. verdict가 null이어도 "문제 없음"으로 읽지 않는다 */
  checked: boolean;
  states: ThreeStateStates | null;
  /** 세 상태 어디서도 문제가 없으면 null */
  verdict: ThreeStateVerdict | null;
  /** 연관 PR 없이 main만 봤으면 null */
  basis: ThreeStateBasis | null;
  /** 이 대상 레포에서 아직 확정 안 된 연관 PR. 확정되면 판정이 바뀔 수 있다 */
  unconfirmedRelatedPrs: { repo: string; number: number }[];
  limitations: string[];
}

const defaultRunGit: GitRunner = (dir, args) => {
  const r = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status ?? 1, stdout: r.stdout };
};

/**
 * 세 상태에서 판정을 고른다. 최종 상태(둘 다 머지된 뒤)가 기준이다.
 * 끝에 살아나면 main만 깨진 건 머지 순서 문제다. 끝에 깨지면 main에서 멀쩡했는지로 원인을 가른다.
 */
export function decideThreeStateVerdict(states: ThreeStateStates): VerdictType | null {
  if (states.afterBothMerged === 'ok') {
    return states.onMain === 'broken' ? 'notDefect_mergeOrder' : null;
  }
  return states.onMain === 'ok' ? 'relatedRemovesUsed' : 'defect';
}

export function notifyReposFor(
  verdict: VerdictType,
  currentRepo: string,
  targetRepo: string,
): string[] {
  if (verdict !== 'relatedRemovesUsed') return [currentRepo];
  return [...new Set([currentRepo, targetRepo])];
}

/**
 * 레포를 넘는 참조 하나를 main, 연관 PR head, 둘 다 머지된 뒤에서 확인한다.
 * 대상 레포의 확정된 연관 PR마다 판정 하나를 낸다. 확정된 게 없으면 main만 보고 하나를 낸다.
 * 연관 PR 본문이나 코멘트는 읽지 않는다. 판정은 ref의 트리만 보고 한다.
 */
export async function judgeThreeState(input: JudgeThreeStateInput): Promise<ThreeStateJudgment[]> {
  const runGit = input.runGit ?? defaultRunGit;
  const { target } = input;
  const inTarget = input.relatedPrs.filter((pr) => pr.repo === target.repo);
  const confirmed = inTarget.filter((pr) => pr.confirmation === 'confirmed');
  const unconfirmed = inTarget
    .filter((pr) => pr.confirmation !== 'confirmed')
    .map((pr) => ({ repo: pr.repo, number: pr.number }));

  const base = (): ThreeStateJudgment => {
    const limitations: string[] = [];
    if (unconfirmed.length > 0) {
      limitations.push(`확정 안 된 연관 PR이 ${unconfirmed.length}개 있다. 확정되면 다시 판정한다`);
    }
    return {
      identifier: input.identifier,
      targetRepo: target.repo,
      checked: false,
      states: null,
      verdict: null,
      basis: null,
      unconfirmedRelatedPrs: unconfirmed,
      limitations,
    };
  };

  if (input.identifier.extractedBy === 'llm') {
    const j = base();
    j.limitations.push('LLM이 뽑은 식별자는 값이 검색어가 아니라서 LLM 판정으로 넘긴다');
    return [j];
  }

  // 닫힌 PR은 머지되지 않으니 세 상태의 근거가 못 된다
  const usable = confirmed.filter((pr) => pr.state !== 'closed');
  const closed = confirmed.filter((pr) => pr.state === 'closed').map((pr) => `#${pr.number}`);

  const results =
    usable.length === 0
      ? [await guarded(base(), (j) => judgeMainOnly(input, runGit, j))]
      : await Promise.all(
          usable.map((pr) => guarded(base(), (j) => judgeWithPr(input, pr, runGit, j))),
        );
  if (closed.length > 0) {
    for (const r of results)
      r.limitations.push(`닫힌 연관 PR(${closed.join(', ')})은 판정에서 뺐다`);
  }
  return results;
}

class StateUnavailable extends Error {}

// 한 ref라도 못 보면 나머지로 판정을 내지 않는다. 빈 결과가 "참조 깨짐"으로 읽히는 걸 막는다
async function guarded(
  j: ThreeStateJudgment,
  run: (j: ThreeStateJudgment) => Promise<ThreeStateJudgment>,
): Promise<ThreeStateJudgment> {
  try {
    return await run(j);
  } catch (e) {
    if (!(e instanceof StateUnavailable)) throw e;
    j.limitations.push(e.message);
    return j;
  }
}

async function judgeMainOnly(
  input: JudgeThreeStateInput,
  runGit: GitRunner,
  j: ThreeStateJudgment,
): Promise<ThreeStateJudgment> {
  const mainRef = resolveRef(input.target.dir, input.target.defaultBranch, runGit);
  if (!mainRef) {
    j.limitations.push(`기본 브랜치 ${input.target.defaultBranch}를 로컬 clone에서 못 찾았다`);
    return j;
  }
  const onMain = await stateAt(input, mainRef, runGit);
  const states = {
    onMain: onMain,
    onRelatedHead: onMain,
    afterBothMerged: onMain,
  };
  return finish(input, j, states, null);
}

async function judgeWithPr(
  input: JudgeThreeStateInput,
  pr: RelatedPR,
  runGit: GitRunner,
  j: ThreeStateJudgment,
): Promise<ThreeStateJudgment> {
  const { dir, defaultBranch } = input.target;
  const relatedPr = { repo: pr.repo, number: pr.number, state: pr.state, headSha: pr.headSha };

  if (!hasCommit(dir, pr.headSha, runGit)) {
    j.limitations.push(
      `연관 PR #${pr.number}의 head ${pr.headSha.slice(0, 12)}가 로컬 clone에 없다. fetch한 뒤 다시 본다`,
    );
    return j;
  }

  if (pr.state === 'merged') {
    // 머지된 뒤엔 main과 머지 후가 같은 트리다. 그 레포가 실제로 머지한 브랜치를 본다
    let branch = pr.mergedBranch ?? defaultBranch;
    let mainRef = resolveRef(dir, branch, runGit);
    if (!mainRef && branch !== defaultBranch) {
      j.limitations.push(`머지된 브랜치 ${branch}가 로컬 clone에 없어 ${defaultBranch}로 봤다`);
      branch = defaultBranch;
      mainRef = resolveRef(dir, branch, runGit);
    }
    if (!mainRef) {
      j.limitations.push(`브랜치 ${branch}를 로컬 clone에서 못 찾았다`);
      return j;
    }
    const [onMain, onHead] = await Promise.all([
      stateAt(input, mainRef, runGit),
      stateAt(input, pr.headSha, runGit),
    ]);
    const states = {
      onMain: onMain,
      onRelatedHead: onHead,
      afterBothMerged: onMain,
    };
    return finish(input, j, states, {
      relatedPr,
      mode: 'mergedBranch',
      mainRef,
      afterMergeRef: mainRef,
    });
  }

  const mainRef = resolveRef(dir, defaultBranch, runGit);
  if (!mainRef) {
    j.limitations.push(`기본 브랜치 ${defaultBranch}를 로컬 clone에서 못 찾았다`);
    return j;
  }
  const [onMain, onHead] = await Promise.all([
    stateAt(input, mainRef, runGit),
    stateAt(input, pr.headSha, runGit),
  ]);

  const merged = virtualMergeTree(dir, mainRef, pr.headSha, runGit);
  let afterBothMerged: SingleStateValue;
  let afterMergeRef: string;
  if (merged.tree) {
    const after = await stateAt(input, merged.tree, runGit);
    afterBothMerged = after;
    afterMergeRef = merged.tree;
  } else {
    // 충돌 표시가 섞인 트리를 grep하면 양쪽 문장이 다 걸려 판정이 흐려진다. 연관 PR 쪽이 이긴다고 보고 head로 대신한다
    j.limitations.push(
      `가상 머지를 못 만들어 연관 PR head로 머지 후를 대신했다 (${merged.reason})`,
    );
    afterBothMerged = onHead;
    afterMergeRef = pr.headSha;
  }

  const states = { onMain: onMain, onRelatedHead: onHead, afterBothMerged };
  return finish(input, j, states, { relatedPr, mode: 'openHead', mainRef, afterMergeRef });
}

function finish(
  input: JudgeThreeStateInput,
  j: ThreeStateJudgment,
  states: ThreeStateStates,
  basis: ThreeStateBasis | null,
): ThreeStateJudgment {
  const verdict = decideThreeStateVerdict(states);
  return {
    ...j,
    checked: true,
    states,
    basis,
    verdict: verdict
      ? {
          identifier: input.identifier,
          ...states,
          verdict,
          notifyRepos: notifyReposFor(verdict, input.currentRepo, input.target.repo),
        }
      : null,
  };
}

async function stateAt(
  input: JudgeThreeStateInput,
  ref: string,
  runGit: GitRunner,
): Promise<SingleStateValue> {
  const { repo, dir } = input.target;
  const backend = new LocalCloneBackend([{ repo, dir, ref }]);
  const res = await backend.search(input.identifier.value, [repo], { maxHitsPerRepo: 1 });
  const skip = res.skipped[0];
  if (skip) throw new StateUnavailable(`${repo}@${ref.slice(0, 12)} 검색 실패: ${skip.reason}`);
  if (res.hits.length > 0) return 'ok';
  if (input.identifier.kind === 'path' || input.identifier.kind === 'uniqueFileName') {
    if (pathExists(dir, ref, input.identifier, runGit)) return 'ok';
  }
  return 'broken';
}

// 경로 식별자는 파일 안에 그 문자열이 없어도 파일만 있으면 살아 있다
function pathExists(dir: string, ref: string, id: Identifier, runGit: GitRunner): boolean {
  const r = runGit(dir, ['ls-tree', '-r', '--name-only', ref]);
  if (r.status !== 0) return false;
  const want = id.value.replace(/^\.\//, '').replace(/\/+$/, '');
  const files = r.stdout.split('\n').filter(Boolean);
  if (id.kind === 'uniqueFileName') {
    return files.some((f) => f === want || f.endsWith(`/${want}`));
  }
  return files.some((f) => f === want || f.startsWith(`${want}/`) || f.endsWith(`/${want}`));
}

function hasCommit(dir: string, sha: string, runGit: GitRunner): boolean {
  if (sha === '') return false;
  return runGit(dir, ['cat-file', '-e', `${sha}^{commit}`]).status === 0;
}

// 로컬 브랜치가 없고 원격 추적 브랜치만 있는 clone도 흔하다
// 로컬 브랜치는 오래됐을 수 있다. 방금 fetch한 원격 추적 ref가 있으면 그걸 먼저 본다
function resolveRef(dir: string, ref: string, runGit: GitRunner): string | null {
  for (const candidate of [`origin/${ref}`, ref]) {
    const r = runGit(dir, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
    if (r.status === 0) return candidate;
  }
  return null;
}

function virtualMergeTree(
  dir: string,
  mainRef: string,
  headSha: string,
  runGit: GitRunner,
): { tree: string; reason?: undefined } | { tree?: undefined; reason: string } {
  const r = runGit(dir, ['merge-tree', '--write-tree', '--no-messages', mainRef, headSha]);
  if (r.status === 1) return { reason: '충돌' };
  const tree = r.stdout.split('\n')[0]?.trim() ?? '';
  if (r.status !== 0 || !/^[0-9a-f]{40,64}$/.test(tree)) {
    return { reason: `git merge-tree 실패 (status ${r.status})` };
  }
  return { tree };
}
