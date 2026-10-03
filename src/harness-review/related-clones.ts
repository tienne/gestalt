/**
 * 역방향 검색에 쓸 관련 레포 클론을 준비한다.
 *
 * GitHub 코드 검색은 분당 10회라 식별자가 수십 개인 PR은 한 번에 못 끝낸다. 관련 레포를 로컬에
 * 받아 두면 같은 질의를 git grep으로 한도 없이 돌린다. 사람이 `--repo-dir`로 준 클론을 먼저 쓰고
 * 없으면 `~/.gestalt/repos/<워크트리 키>/<owner>/<name>`에 기본 브랜치만 얕게 받는다.
 *
 * 클론은 워크트리마다 따로 둔다. 여러 워크트리에서 리뷰를 동시에 돌리면 한 클론을 두고 fetch가
 * 부딪히고 한쪽이 검색하는 사이 다른 쪽이 ref를 옮긴다.
 *
 * 어느 쪽이든 워킹트리가 아니라 origin 기본 브랜치 ref를 읽는다. GitHub 검색이 기본 브랜치만 보므로
 * 기준을 맞추고 체크아웃된 작업 브랜치나 커밋 안 한 변경이 결과에 섞이지 않게 한다.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { gestaltPath } from '../core/home.js';
import { runGh, type GhRunner } from '../review-loop/fetch.js';
import type { LocalRepoSource } from './search-backend.js';

export interface CloneTarget {
  /** owner/name */
  repo: string;
  /** 관련 레포 탐지가 알아낸 기본 브랜치. 없으면 클론의 origin/HEAD를 본다 */
  defaultBranch?: string;
  /** `--repo-dir`로 받은 클론. 있으면 관리 클론을 만들지 않는다 */
  userDir?: string;
}

export interface CloneGitRunner {
  (dir: string, args: readonly string[]): string;
}

export interface PrepareClonesOptions {
  targets: CloneTarget[];
  /** 관리 클론을 두는 자리. 부르는 쪽이 `worktreeCloneRoot`로 워크트리마다 나눠 넘긴다 */
  cloneRoot?: string;
  gh?: GhRunner;
  git?: CloneGitRunner;
  now?: Date;
  /** fetch가 잠금에 걸렸을 때 다시 시도하기 전 기다리는 함수. 테스트가 실제로 자지 않게 주입한다 */
  wait?: (ms: number) => void;
}

export interface CloneFailure {
  repo: string;
  reason: string;
}

export interface PreparedClones {
  sources: LocalRepoSource[];
  /** 클론을 못 얻은 레포. 부르는 쪽이 GitHub 검색으로 넘긴다 */
  failed: CloneFailure[];
  limitations: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TMP_PREFIX = '.clone-tmp-';
// 받다가 죽은 프로세스가 남긴 임시 클론만 치운다. 다른 수집이 지금 받고 있는 자리는 건드리면 안 된다
const STALE_TMP_MS = 60 * 60 * 1000;
// 다른 워크트리의 수집이 같은 클론을 fetch하는 중이면 git이 잠금 파일로 막는다. 끝나길 잠깐 기다린다
const LOCK_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const LOCK_ERROR_RE = /\.lock'?:? File exists|Unable to create '[^']*\.lock'/;
// 경로 조각으로 쓰므로 `..` 같은 값이 들어오면 cloneRoot 밖을 가리킨다
const SLUG_PART_RE = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

export function defaultCloneRoot(): string {
  return gestaltPath('repos');
}

// 워크트리 루트에 이 파일로 원래 경로를 적어 둔다. 그 경로가 사라졌으면 클론을 치워도 된다
const WORKTREE_MARKER = '.worktree';

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * 워크트리 하나가 쓸 클론 루트를 돌려준다. 이름은 사람이 알아보게 디렉토리 이름을 앞에 두고
 * 같은 이름의 워크트리끼리 겹치지 않게 경로 해시를 붙인다.
 */
export function worktreeCloneRoot(base: string, worktree: string): string {
  const path = canonicalPath(worktree);
  const name = basename(path).replace(/[^A-Za-z0-9_.-]/g, '_') || 'root';
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 8);
  const root = join(resolve(base), `${name}-${hash}`);
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, WORKTREE_MARKER), `${path}\n`);
  } catch {
    // 표시를 못 남겨도 클론은 받는다. 못 남긴 루트는 정리 대상에서 빠질 뿐이다
  }
  return root;
}

/** 이 기간 넘게 어느 수집도 안 쓴 클론 루트는 워크트리가 살아 있어도 치운다 */
export const DEFAULT_CLONE_MAX_IDLE_MS = 7 * DAY_MS;

export type PruneReason = 'worktreeGone' | 'idle' | 'all';

export interface PrunedClone {
  root: string;
  /** 표시 파일에 적힌 워크트리 경로. 표시가 없으면 null */
  worktree: string | null;
  reason: PruneReason;
}

export interface PruneClonesOptions {
  now?: Date;
  maxIdleMs?: number;
  /** 표시 없는 디렉토리까지 전부 지운다. 사람이 명령으로 부를 때만 쓴다 */
  all?: boolean;
}

function readMarker(root: string): { worktree: string; usedAt: number } | null {
  try {
    const marker = join(root, WORKTREE_MARKER);
    const worktree = readFileSync(marker, 'utf-8').trim();
    return worktree === '' ? null : { worktree, usedAt: statSync(marker).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * 원래 워크트리가 지워졌거나 오래 안 쓴 클론 루트를 치운다. 쓴 시각은 수집마다
 * `worktreeCloneRoot`가 표시 파일을 다시 쓰며 갱신한다. 표시 파일이 없는 디렉토리는 누가 만든
 * 건지 몰라 `all`이 아니면 건드리지 않는다. 예외를 던지지 않는다.
 */
export function pruneWorktreeClones(base: string, opts: PruneClonesOptions = {}): PrunedClone[] {
  const now = (opts.now ?? new Date()).getTime();
  const maxIdleMs = opts.maxIdleMs ?? DEFAULT_CLONE_MAX_IDLE_MS;
  const pruned: PrunedClone[] = [];
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return pruned;
  }
  for (const entry of entries) {
    const root = join(base, entry);
    const marker = readMarker(root);
    let reason: PruneReason | null = null;
    if (opts.all) reason = 'all';
    else if (marker === null) continue;
    else if (!existsSync(marker.worktree)) reason = 'worktreeGone';
    else if (now - marker.usedAt > maxIdleMs) reason = 'idle';
    if (reason === null) continue;
    try {
      rmSync(root, { recursive: true, force: true });
      pruned.push({ root, worktree: marker?.worktree ?? null, reason });
    } catch {
      // 다른 수집이 먼저 치웠다
    }
  }
  return pruned;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const defaultGit: CloneGitRunner = (dir, args) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // 인증이 필요한 원격이면 프롬프트를 띄우지 말고 실패하게 한다. 수집이 입력을 기다리며 멈춘다
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: 120_000,
  });

function errText(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const stderr = (e as { stderr?: unknown }).stderr;
    if (stderr !== undefined && stderr !== null && String(stderr).trim() !== '') {
      return String(stderr).trim();
    }
  }
  return e instanceof Error ? e.message : String(e);
}

// git은 원인을 fatal 줄에 쓰고 그 뒤에 안내 문단을 붙인다. 마지막 줄만 보면 원인이 빠진다
function errMessage(e: unknown): string {
  const lines = errText(e).split('\n');
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines.at(-1)!;
}

function originHeadBranch(git: CloneGitRunner, dir: string): string | null {
  try {
    const out = git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim();
    return out.startsWith('origin/') ? out.slice('origin/'.length) : null;
  } catch {
    return null;
  }
}

function resolveCommit(git: CloneGitRunner, dir: string, ref: string): string | null {
  try {
    const sha = git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
    return sha === '' ? null : sha;
  } catch {
    return null;
  }
}

function sweepStaleTmp(parent: string, now: Date): void {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(TMP_PREFIX)) continue;
    const path = join(parent, entry);
    try {
      if (now.getTime() - statSync(path).mtimeMs > STALE_TMP_MS)
        rmSync(path, { recursive: true, force: true });
    } catch {
      // 다른 수집이 먼저 치웠다
    }
  }
}

/**
 * 임시 자리에 받은 뒤 rename으로 옮긴다. 같은 자리에 바로 받으면 동시에 도는 다른 수집이 받다 만
 * 디렉토리를 끊긴 클론으로 보고 지울 수 있다. rename이 이미 있다고 실패하면 다른 수집이 먼저 받은
 * 것이라 그 클론을 쓴다.
 */
function cloneInto(gh: GhRunner, repo: string, dir: string, now: Date): void {
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  sweepStaleTmp(parent, now);
  const tmp = join(parent, `${TMP_PREFIX}${repo.split('/')[1]}-${randomUUID()}`);
  try {
    gh(['repo', 'clone', repo, tmp, '--', '--depth', '1', '--single-branch']);
    try {
      renameSync(tmp, dir);
    } catch (e) {
      if (!existsSync(join(dir, '.git'))) throw e;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function fetchWithRetry(
  git: CloneGitRunner,
  dir: string,
  args: readonly string[],
  wait: (ms: number) => void,
): { error: string | null; locked: boolean } {
  for (let attempt = 0; ; attempt++) {
    try {
      git(dir, args);
      return { error: null, locked: false };
    } catch (e) {
      const error = errMessage(e);
      const locked = LOCK_ERROR_RE.test(errText(e));
      const delay = LOCK_RETRY_DELAYS_MS[attempt];
      if (!locked || delay === undefined) return { error, locked };
      wait(delay);
    }
  }
}

function ageInDays(git: CloneGitRunner, dir: string, ref: string, now: Date): number | null {
  try {
    const seconds = Number(git(dir, ['log', '-1', '--format=%ct', ref]).trim());
    if (!Number.isFinite(seconds)) return null;
    return Math.max(0, Math.floor((now.getTime() - seconds * 1000) / DAY_MS));
  } catch {
    return null;
  }
}

/**
 * 대상마다 클론을 확보하고 origin 기본 브랜치를 받아 온다. 예외를 던지지 않는다 — 실패는 failed와
 * limitations로 돌려준다.
 */
export function prepareRelatedClones(opts: PrepareClonesOptions): PreparedClones {
  const gh = opts.gh ?? runGh;
  const git = opts.git ?? defaultGit;
  const now = opts.now ?? new Date();
  const wait = opts.wait ?? sleepSync;
  const cloneRoot = resolve(opts.cloneRoot ?? defaultCloneRoot());
  const result: PreparedClones = { sources: [], failed: [], limitations: [] };
  const seen = new Set<string>();

  const fail = (repo: string, reason: string) => {
    result.failed.push({ repo, reason });
    result.limitations.push(`${repo}: 로컬 클론을 못 얻어 GitHub 검색으로 넘겼다 (${reason})`);
  };

  for (const target of opts.targets) {
    const key = target.repo.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const [owner, name, ...rest] = target.repo.split('/');
    if (
      !owner ||
      !name ||
      rest.length > 0 ||
      !SLUG_PART_RE.test(owner) ||
      !SLUG_PART_RE.test(name)
    ) {
      fail(target.repo, 'owner/name 꼴이 아니다');
      continue;
    }

    const managed = target.userDir === undefined;
    const dir = managed ? join(cloneRoot, owner, name) : resolve(target.userDir!);
    let fresh = false;

    if (!managed && !existsSync(dir)) {
      fail(target.repo, `--repo-dir 경로가 없다: ${dir}`);
      continue;
    }
    if (managed && !existsSync(join(dir, '.git'))) {
      // 클론은 rename으로만 이 자리에 오므로 .git 없는 디렉토리는 이전 버전이 남긴 끊긴 클론이다
      if (existsSync(dir) && dir.startsWith(cloneRoot + sep))
        rmSync(dir, { recursive: true, force: true });
      try {
        cloneInto(gh, target.repo, dir, now);
        fresh = true;
      } catch (e) {
        fail(target.repo, `클론 실패: ${errMessage(e)}`);
        continue;
      }
    }

    const branch = target.defaultBranch ?? originHeadBranch(git, dir) ?? 'main';
    const ref = `refs/remotes/origin/${branch}`;

    let fetchError: string | null = null;
    let fetchLocked = false;
    // 방금 받은 클론은 기본 브랜치가 이미 있다. 탐지한 기본 브랜치가 원격 HEAD와 다를 때만 더 받는다
    if (!(fresh && resolveCommit(git, dir, ref) !== null)) {
      // 사람이 준 클론은 이력을 잘라 얕게 만들면 안 된다. depth는 관리 클론에만 건다
      const depth = managed ? ['--depth', '1'] : [];
      const fetched = fetchWithRetry(
        git,
        dir,
        ['fetch', '--quiet', ...depth, 'origin', `+refs/heads/${branch}:${ref}`],
        wait,
      );
      fetchError = fetched.error;
      fetchLocked = fetched.locked;
    }

    // ref 이름이 아니라 커밋으로 고정한다. 검색 도중 다른 수집이 같은 클론을 fetch해 ref를 옮기면
    // 질의마다 다른 커밋을 보게 된다
    const commit = resolveCommit(git, dir, ref);
    if (commit === null) {
      fail(
        target.repo,
        fetchError
          ? `origin/${branch}가 없고 fetch도 실패했다: ${fetchError}`
          : `origin/${branch}가 없다`,
      );
      continue;
    }
    if (fetchError) {
      const days = ageInDays(git, dir, commit, now);
      const age = days === null ? '언제인지 모르는' : `${days}일 전`;
      const cause = fetchLocked
        ? '다른 수집이 같은 클론을 받는 중이라 fetch를 못 해'
        : 'fetch가 실패해';
      result.limitations.push(
        `${target.repo}: ${cause} origin/${branch}를 ${age} 커밋 기준으로 봤다 (${fetchError})`,
      );
    }
    result.sources.push({ repo: target.repo, dir, ref: commit });
  }
  return result;
}
