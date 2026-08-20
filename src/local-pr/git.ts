import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

/**
 * 로컬 PR이 쓰는 git 연산.
 *
 * 명령은 전부 execFileSync로 인자를 배열로 넘긴다. 셸을 안 거치므로 제목이나
 * 브랜치 이름에 따옴표와 공백이 섞여도 그대로 간다.
 */

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/**
 * 이 레포의 공용 git 디렉토리.
 *
 * 워크트리에서 `--git-dir`는 그 워크트리 전용 경로를 준다. PR 목록은 워크트리
 * 여럿이 함께 봐야 하므로 본체를 가리키는 `--git-common-dir`로 잡는다.
 */
export function gitCommonDir(repoRoot: string): string {
  const dir = git(repoRoot, ['rev-parse', '--git-common-dir']);
  return resolve(repoRoot, dir);
}

/**
 * PR 저장소 경로. 본체 git 디렉토리 옆에 둔다.
 *
 * 워크트리 어디서 불러도 같은 파일을 가리켜야 목록이 갈라지지 않는다.
 */
export function reviewsDbPath(repoRoot: string): string {
  return join(gitCommonDir(repoRoot), '..', '.gestalt', 'reviews.db');
}

export function resolveSha(repoRoot: string, rev: string): string {
  return git(repoRoot, ['rev-parse', '--verify', `${rev}^{commit}`]);
}

/** 두 갈래가 갈라진 지점. PR의 base가 된다 */
export function mergeBase(repoRoot: string, base: string, head: string): string {
  return git(repoRoot, ['merge-base', base, head]);
}

/** 지금 올라타 있는 브랜치 이름. detached HEAD면 null */
export function currentBranch(repoRoot: string): string | null {
  const name = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return name === 'HEAD' ? null : name;
}

/**
 * PR의 커밋을 ref로 붙잡는다.
 *
 * 워커가 브랜치를 지우거나 리베이스해도 이 ref가 커밋을 잡고 있어 diff가 산다.
 * GitHub이 `refs/pull/N/head`를 두는 것과 같은 이유다. 붙잡지 않으면 gc가
 * 수거해 간 뒤 PR이 빈 껍데기가 된다.
 */
export function pinRefs(repoRoot: string, prId: string, baseSha: string, headSha: string): void {
  git(repoRoot, ['update-ref', `refs/gestalt/pr/${prId}/base`, baseSha]);
  git(repoRoot, ['update-ref', `refs/gestalt/pr/${prId}/head`, headSha]);
}

export function unpinRefs(repoRoot: string, prId: string): void {
  for (const suffix of ['base', 'head']) {
    try {
      git(repoRoot, ['update-ref', '-d', `refs/gestalt/pr/${prId}/${suffix}`]);
    } catch {
      // 이미 없으면 지울 것도 없다
    }
  }
}

export function diff(repoRoot: string, baseSha: string, headSha: string): string {
  return git(repoRoot, ['diff', `${baseSha}..${headSha}`]);
}

export function changedFiles(repoRoot: string, baseSha: string, headSha: string): string[] {
  const out = git(repoRoot, ['diff', '--name-only', `${baseSha}..${headSha}`]);
  return out ? out.split('\n') : [];
}

export function diffStat(repoRoot: string, baseSha: string, headSha: string): string {
  return git(repoRoot, ['diff', '--stat', `${baseSha}..${headSha}`]);
}

export interface MergeResult {
  mergeSha: string;
}

/**
 * PR의 head를 base 쪽 브랜치에 병합한다.
 *
 * 지금 올라타 있는 브랜치에 합친다 — 브랜치를 옮겨 다니면 워크트리끼리 서로를
 * 밟기 때문이다. base 브랜치가 아닌 자리에서 부르면 그대로 실패한다.
 */
export function merge(repoRoot: string, prId: string, headSha: string, title: string): MergeResult {
  git(repoRoot, ['merge', '--no-ff', headSha, '-m', `Merge local PR ${prId}: ${title}`]);
  return { mergeSha: resolveSha(repoRoot, 'HEAD') };
}

export function deleteBranch(repoRoot: string, branch: string): void {
  git(repoRoot, ['branch', '-D', branch]);
}

/** 이 커밋이 아직 살아 있는가. ref가 안 붙었으면 gc가 가져갈 수 있다 */
export function commitExists(repoRoot: string, sha: string): boolean {
  try {
    git(repoRoot, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}
