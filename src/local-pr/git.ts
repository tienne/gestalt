import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  /** 임시 워크트리에서 합쳤는지. 곧장 합쳤으면 false다 */
  viaWorktree: boolean;
}

export interface WorktreeEntry {
  path: string;
  /** 이 워크트리가 올라타 있는 브랜치. detached면 null */
  branch: string | null;
}

/** 이 레포에 딸린 워크트리 목록 */
export function worktrees(repoRoot: string): WorktreeEntry[] {
  const out = git(repoRoot, ['worktree', 'list', '--porcelain']);
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null };
      entries.push(current as WorktreeEntry);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }

  return entries;
}

/** 이 브랜치를 올라타고 있는 워크트리. 없으면 null */
export function worktreeOn(repoRoot: string, branch: string): WorktreeEntry | null {
  return worktrees(repoRoot).find((w) => w.branch === branch) ?? null;
}

/** 심볼릭 링크를 풀어 같은 자리인지 본다 */
function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(resolve(p));
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

export function isClean(repoRoot: string): boolean {
  return git(repoRoot, ['status', '--porcelain']) === '';
}

/**
 * PR의 head를 base 브랜치에 병합한다.
 *
 * 부르는 쪽이 base로 옮겨 타지 않아도 되게 임시 워크트리에서 합치고 브랜치 ref만
 * 옮긴다. 워커가 자기 워크트리에 그대로 있는 채로 머지할 수 있다.
 *
 * **base가 다른 워크트리에 체크아웃돼 있으면 ref를 밀지 않는다.** 그쪽은 파일이 옛
 * 상태인데 HEAD만 움직여서, git이 머지를 되돌리는 수정이 널려 있는 것처럼 보고한다.
 * 그 자리에서 직접 머지하도록 돌려보낸다.
 *
 * ref는 옛 값을 함께 넘겨 옮긴다. 그 사이 base가 움직였으면 git이 거부한다.
 */
export function mergeIntoBase(
  repoRoot: string,
  input: { prId: string; baseRef: string; headSha: string; title: string },
): MergeResult {
  const { prId, baseRef, headSha, title } = input;
  const message = `Merge local PR ${prId}: ${title}`;

  const holder = worktreeOn(repoRoot, baseRef);

  // 지금 이 자리가 base를 올라타고 있으면 그냥 여기서 합치는 게 제일 안전하다.
  // macOS의 /tmp처럼 심볼릭 링크를 타는 경로가 있어 실경로로 맞춰야 같은 자리인지 안다
  if (holder && samePath(holder.path, repoRoot)) {
    git(repoRoot, ['merge', '--no-ff', headSha, '-m', message]);
    return { mergeSha: resolveSha(repoRoot, 'HEAD'), viaWorktree: false };
  }

  if (holder) {
    throw new Error(
      `base 브랜치 ${baseRef}를 다른 워크트리가 올라타고 있다: ${holder.path}\n` +
        '거기서 머지하거나 그 워크트리를 정리한 뒤 다시 부른다',
    );
  }

  const before = resolveSha(repoRoot, baseRef);
  const scratch = mkdtempSync(join(tmpdir(), `gestalt-merge-${prId}-`));

  try {
    // 브랜치를 체크아웃하지 않고 그 지점만 떼어 온다. 어느 워크트리와도 안 겹친다
    git(repoRoot, ['worktree', 'add', '--detach', '-q', scratch, before]);
    git(scratch, ['merge', '--no-ff', headSha, '-m', message]);
    const mergeSha = resolveSha(scratch, 'HEAD');

    // 옛 값을 같이 넘긴다. 그 사이 base가 움직였으면 여기서 거부된다
    git(repoRoot, ['update-ref', `refs/heads/${baseRef}`, mergeSha, before]);

    return { mergeSha, viaWorktree: true };
  } finally {
    try {
      git(repoRoot, ['worktree', 'remove', '--force', scratch]);
    } catch {
      rmSync(scratch, { recursive: true, force: true });
      git(repoRoot, ['worktree', 'prune']);
    }
  }
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
