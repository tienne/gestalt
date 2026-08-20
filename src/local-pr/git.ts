import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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

/** `checkoutPrHead`가 떼어 놓은 워크트리 */
export interface PrCheckout {
  path: string;
  /** 이번 호출이 새로 뗐으면 true. 이미 있어서 그대로 돌려줬으면 false */
  created: boolean;
  headSha: string;
}

/** 떼어낸 워크트리를 모아 두는 칸. 자리를 되짚는 폴백이 이 이름으로 훑는다 */
const CHECKOUT_ROOT = 'gestalt-pr-checkout';

/**
 * PR 리뷰용 워크트리가 놓일 자리.
 *
 * repoRoot와 prId만으로 정해진다. 리뷰어가 경로를 안 적어놨어도 지울 때 같은 값이
 * 다시 나온다. 레포마다 갈라야 해서 공용 git 디렉토리의 해시를 한 칸 끼운다 —
 * 다른 레포의 PR이 우연히 같은 id를 받아도 자리가 겹치지 않는다.
 *
 * 레포 안이 아니라 tmp에 둔다. 레포 안에 두면 워킹 트리에 추적되지 않는 디렉토리가
 * 생겨 리뷰 중인 diff에 섞인다. 대신 tmp 자리는 TMPDIR를 타므로 뗄 때와 지울 때
 * 환경이 다르면 값이 갈린다. 그 경우는 `registeredCheckout`이 등록 목록으로 되짚는다.
 */
export function prCheckoutPath(repoRoot: string, prId: string): string {
  const key = createHash('sha1').update(gitCommonDir(repoRoot)).digest('hex').slice(0, 8);
  return join(tmpdir(), CHECKOUT_ROOT, key, prId);
}

/**
 * 이 PR이 실제로 떼어져 있는 자리. 등록이 없으면 null.
 *
 * 먼저 지금 환경이 계산한 자리를 본다. 없으면 등록 목록에서 `<CHECKOUT_ROOT>/<해시>/<prId>`
 * 꼴을 훑는다 — 뗄 때와 지울 때 TMPDIR가 다르면 계산값이 옛 자리를 안 가리키기 때문이다.
 * 폴백이 없으면 원래 자리가 등록된 채로 영영 남는다.
 */
function registeredCheckout(repoRoot: string, prId: string): string | null {
  const canonical = prCheckoutPath(repoRoot, prId);
  const list = worktrees(repoRoot);

  if (list.some((w) => samePath(w.path, canonical))) return canonical;

  const strayed = list.find((w) => {
    const parts = w.path.split(/[\\/]/);
    return parts.at(-1) === prId && parts.at(-3) === CHECKOUT_ROOT;
  });

  return strayed?.path ?? null;
}

/**
 * 워크트리를 지운 뒤에도 git을 부를 수 있는 자리.
 *
 * `scrub`은 자기 cwd를 지울 수 있다 — `checkout`이 알려준 경로로 `cd` 한 채
 * `--remove`를 부르는 게 이 명령의 정상 흐름이다. 사라진 cwd에서 git을 부르면
 * spawn이 ENOENT로 죽어, 정리는 됐는데 실패로 보고한다. 그래서 지우는 자리 밖인
 * 본체 워킹 트리를 잡는다. 본체가 없는 bare 레포면 공용 git 디렉토리 자신을 쓴다.
 */
function gitAnchor(repoRoot: string): string {
  const common = gitCommonDir(repoRoot);
  const main = dirname(common);
  return existsSync(join(main, '.git')) ? main : common;
}

/** 그 자리가 아직 워크트리 노릇을 하는가. 등록만 남고 속이 깨진 경우를 가른다 */
function isUsable(path: string): boolean {
  try {
    resolveSha(path, 'HEAD');
    return true;
  } catch {
    return false;
  }
}

/** 이 커밋을 품은 ref가 하나라도 있는가. 없으면 워크트리와 함께 사라진다 */
function anchoredByRef(repoRoot: string, sha: string): boolean {
  return (
    git(repoRoot, ['for-each-ref', '--contains', sha, '--count=1', '--format=%(refname)']) !== ''
  );
}

/** 반쯤 남은 흔적을 치운다. 등록과 디렉토리 둘 다 없앤다 */
function scrub(repoRoot: string, path: string): void {
  const anchor = gitAnchor(repoRoot);

  try {
    git(anchor, ['worktree', 'remove', '--force', path]);
  } catch {
    // 등록이 없거나 이미 깨졌다. 아래에서 손으로 치운다
  }

  rmSync(path, { recursive: true, force: true });
  git(anchor, ['worktree', 'prune']);

  // 해시 칸에는 이 레포의 PR 자리만 들어간다. 비었으면 같이 치운다 — 안 그러면
  // 레포마다 빈 디렉토리가 tmp에 쌓인다. 다른 PR이 남아 있으면 rmdir이 거부한다
  try {
    rmdirSync(dirname(path));
  } catch {
    // 비어 있지 않거나 이미 없다. 어느 쪽이든 더 할 일이 없다
  }
}

/**
 * PR head를 임시 워크트리로 떼어 놓는다.
 *
 * 리뷰어가 코드를 일부러 깨서 테스트가 잡는지 보려면 PR head가 실물 파일로 있어야
 * 한다. 리뷰어 자신의 워크트리는 자기 브랜치를 올라타고 있어 그 코드가 없다.
 *
 * `--detach`로 뗀다. 브랜치를 체크아웃하면 그 브랜치를 이미 올라탄 워크트리와
 * 부딪힌다. mergeIntoBase가 임시 워크트리에서 같은 선택을 한 이유와 같다.
 *
 * 같은 PR을 두 번 부르면 있는 워크트리를 그대로 돌려준다. 리뷰어가 거기서 하던
 * 작업을 날리지 않는다. TMPDIR가 바뀌어 계산값이 달라져도 등록된 자리를 되짚어
 * 돌려주므로 한 PR에 워크트리가 둘 생기지 않는다.
 */
export function checkoutPrHead(repoRoot: string, prId: string, headSha: string): PrCheckout {
  const existing = registeredCheckout(repoRoot, prId);

  // 리뷰어가 거기서 커밋을 얹었으면 HEAD가 PR head에서 옮겨가 있다. 인자로 받은
  // 값이 아니라 그 자리의 실제 HEAD를 돌려준다
  if (existing && isUsable(existing)) {
    return { path: existing, created: false, headSha: resolveSha(existing, 'HEAD') };
  }

  const path = prCheckoutPath(repoRoot, prId);

  // 등록이나 디렉토리 한쪽만 남은 자리. 지난번 정리가 중간에 끊긴 흔적이다.
  // 그대로 두면 `worktree add`가 거부하므로 치우고 다시 뗀다
  if (existing) scrub(repoRoot, existing);
  if (existsSync(path)) scrub(repoRoot, path);

  mkdirSync(dirname(path), { recursive: true });
  git(repoRoot, ['worktree', 'add', '--detach', '-q', path, headSha]);

  return { path, created: true, headSha };
}

/**
 * 안 지운 이유를 식별자로 가른다.
 *
 * `reason`은 사람이 읽을 산문이라 부르는 쪽이 부분 문자열로 긁으면 문장을 손볼 때마다
 * 깨진다. 갈래는 이 값으로 탄다.
 *
 * - `removed`  지웠다
 * - `absent`   지울 자리가 없었다 (정리의 목표가 이미 이뤄진 상태다)
 * - `dirty`    커밋 안 된 변경이 있어 일부러 안 지웠다
 * - `diverged` 여기서 커밋한 변경이 있어 일부러 안 지웠다
 */
export type CheckoutRemovalStatus = 'removed' | 'absent' | 'dirty' | 'diverged';

export interface CheckoutRemoval {
  path: string;
  removed: boolean;
  status: CheckoutRemovalStatus;
  /** 안 지웠으면 그 이유. 지웠으면 null */
  reason: string | null;
  /** 사라질 뻔한 커밋을 붙잡아 둔 ref. 그런 커밋이 없었으면 null */
  savedRef: string | null;
}

/**
 * `--force`로 지울 때 워크트리 전용 커밋을 붙잡아 둘 ref.
 *
 * 이름에 sha를 실어 바퀴마다 한 칸씩 남긴다. PR당 한 칸이면 두 번째 `--force`가
 * 첫 번째로 구한 커밋을 덮어써서, 그 커밋이 어느 ref도 안 품은 상태가 된다.
 * 뮤테이션 검증은 깨고 커밋하고 치우기를 여러 바퀴 도는 흐름이라 그 자리를 실제로 밟는다.
 */
function strandedRef(prId: string, sha: string): string {
  return `refs/gestalt/pr-checkout/${prId}/${sha.slice(0, 8)}`;
}

/**
 * 떼어 놓은 워크트리를 지운다.
 *
 * **지울 만하지 않으면 지우지 않는다.** 리뷰어가 뮤테이션 검증 중이면 그 워크트리는
 * 일부러 깨놓은 코드다. 여기서 날리면 무엇을 어떻게 깼는지가 사라진다. 두 갈래를 막는다.
 *
 * - 커밋 안 된 변경 (`dirty`)
 * - 여기서 커밋했는데 어느 ref도 안 품은 커밋 (`diverged`) — 떼어낸 자리는 detached
 *   HEAD라 브랜치 ref가 없고 워크트리 전용 reflog도 함께 죽는다. `git status`는
 *   깨끗하다고 답하므로 미커밋 검사만으로는 이 손실이 안 걸린다.
 *
 * 어느 쪽이든 왜 안 지웠는지 돌려준다. 정말 버릴 참이면 `force`로 다시 부른다. 그때도
 * ref가 안 품은 커밋은 `refs/gestalt/pr-checkout/<prId>`로 붙잡아 두고 지운다 — 막는
 * 것과 지우게 두는 것 사이에서, 되돌릴 실마리를 남기는 쪽을 골랐다. 리뷰어가 검증
 * 중간을 커밋해 두는 건 있을 법한 흐름이라 `--force` 한 번에 영영 잃게 둘 수 없다.
 *
 * git이 추적하지 않기로 한 파일(.gitignore에 걸린 node_modules 등)은 변경으로
 * 세지 않는다. `git status --porcelain`이 이미 그것들을 뺀 목록을 준다.
 */
export function removePrCheckout(
  repoRoot: string,
  prId: string,
  options: { force?: boolean; headSha?: string } = {},
): CheckoutRemoval {
  const path = registeredCheckout(repoRoot, prId);

  if (!path) {
    const guess = prCheckoutPath(repoRoot, prId);
    git(gitAnchor(repoRoot), ['worktree', 'prune']);
    rmSync(guess, { recursive: true, force: true });
    return {
      path: guess,
      removed: false,
      status: 'absent',
      reason: '떼어 놓은 워크트리가 없다',
      savedRef: null,
    };
  }

  // 속이 깨진 자리는 지킬 변경도 읽을 수 없다. 흔적만 치운다
  if (!isUsable(path)) {
    scrub(repoRoot, path);
    return { path, removed: true, status: 'removed', reason: null, savedRef: null };
  }

  if (!options.force && !isClean(path)) {
    return {
      path,
      removed: false,
      status: 'dirty',
      reason: '커밋 안 된 변경이 있다. 확인한 뒤 --force로 다시 부른다',
      savedRef: null,
    };
  }

  // PR head에서 옮겨갔고 어느 ref도 안 품은 HEAD. 지우면 되짚을 sha를 아는 데가 없다
  const head = resolveSha(path, 'HEAD');
  const stranded =
    options.headSha !== undefined && head !== options.headSha && !anchoredByRef(repoRoot, head);

  if (stranded && !options.force) {
    return {
      path,
      removed: false,
      status: 'diverged',
      reason: `여기서 커밋한 변경이 있다 (HEAD ${head.slice(0, 8)}). 확인한 뒤 --force로 다시 부른다`,
      savedRef: null,
    };
  }

  const savedRef = stranded ? strandedRef(prId, head) : null;
  if (savedRef) git(repoRoot, ['update-ref', savedRef, head]);

  scrub(repoRoot, path);
  return { path, removed: true, status: 'removed', reason: null, savedRef };
}
