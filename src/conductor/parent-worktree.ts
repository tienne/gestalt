import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// 주문의 부모 워크트리를 접수 단계에서 확인한다. 런처까지 가서 실패하면 워커 슬롯만 쓰고 게이트로
// 올라오므로 레포가 다르거나 없는 경로는 여기서 던져 주문을 받지 않는다.

/** 동기 명령 실행기. 테스트가 바꿔 끼운다. 실패하면 던진다 */
export type SyncExec = (cmd: string, args: string[]) => string;

const EXEC_TIMEOUT_MS = 10_000;

class ExecTimeoutError extends Error {}

const defaultExec: SyncExec = (cmd, args) => {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: EXEC_TIMEOUT_MS,
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'ETIMEDOUT')
      throw new ExecTimeoutError(
        `${cmd} ${args.join(' ')}가 ${EXEC_TIMEOUT_MS / 1000}초 안에 안 끝났어요`,
        {
          cause: err,
        },
      );
    throw err;
  }
};

/** `path:`를 뺀 오르카 선택자 접두어. 이걸로 시작하면 오르카에 경로를 묻는다 */
const ORCA_SELECTOR_RE = /^(identity|id|name|branch|issue|worktree|folder):./;

export interface ResolveParentOptions {
  /** `owner/name` → 로컬 체크아웃 경로. 있으면 git 공용 디렉토리로 레포를 맞춘다 */
  repoPaths: Record<string, string>;
  /** 오르카 선택자를 풀 때 쓴다. 없으면 선택자는 거절하고 경로만 받는다 */
  orcaCommand?: string;
  cwd?: string;
  exec?: SyncExec;
}

export function resolveParentWorktree(
  input: string,
  repo: string,
  opts: ResolveParentOptions,
): string {
  const exec = opts.exec ?? defaultExec;
  const raw = input.trim();
  if (!raw) throw new Error('부모 워크트리가 비었어요');

  const path = ORCA_SELECTOR_RE.test(raw)
    ? orcaPath(raw, opts.orcaCommand, exec)
    : resolve(opts.cwd ?? process.cwd(), raw.startsWith('path:') ? raw.slice(5) : raw);
  if (!existsSync(path) || !statSync(path).isDirectory())
    throw new Error(`부모 워크트리 경로가 없어요: ${path}`);

  const top = git(exec, path, ['rev-parse', '--show-toplevel']);
  if (!top) throw new Error(`부모 워크트리가 git 워크트리가 아니에요: ${path}`);
  const root = real(top);

  const expected = opts.repoPaths[repo];
  if (expected) {
    const want = git(exec, expected, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const got = git(exec, root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!want || !got || real(want) !== real(got))
      throw new Error(`부모 워크트리 ${root}가 ${repo}(${expected})의 워크트리가 아니에요`);
    return root;
  }

  const origin = git(exec, root, ['remote', 'get-url', 'origin']);
  if (!origin || !remoteMatches(origin, repo))
    throw new Error(
      `부모 워크트리 ${root}의 origin(${origin ?? '없음'})이 ${repo}와 달라요. 맞는 워크트리를 주거나 repoPaths에 ${repo} 경로를 적어 주세요`,
    );
  return root;
}

/**
 * `git@github.com:owner/name.git`, `https://github.com/owner/name` 같은 주소가 그 레포인지 본다.
 * 호스트는 안 본다. SSH 별칭(`git@github-work:owner/name.git`)도 같은 레포로 받으려는 것이고
 * 호스트가 다른 동명 레포를 가려야 하면 repoPaths로 git 공용 디렉토리를 맞춘다
 */
export function remoteMatches(url: string, repo: string): boolean {
  const m = /[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m !== null && m[1]!.toLowerCase() === repo.toLowerCase();
}

function orcaPath(selector: string, orcaCommand: string | undefined, exec: SyncExec): string {
  if (!orcaCommand)
    throw new Error(`오르카가 없어 선택자 ${selector}를 못 풀어요. 부모 워크트리 경로로 주세요`);
  let out: string;
  try {
    out = exec(orcaCommand, ['worktree', 'show', '--worktree', selector, '--json']);
  } catch (err) {
    const why = err instanceof ExecTimeoutError ? err.message : '';
    throw new Error(
      why
        ? `오르카에서 부모 워크트리 ${selector}를 확인하지 못했어요: ${why}`
        : `오르카에서 부모 워크트리 ${selector}를 못 찾았어요`,
      { cause: err },
    );
  }
  const path = worktreeField(out, 'path');
  if (!path) throw new Error(`오르카 응답에 부모 워크트리 ${selector}의 경로가 없어요`);
  return path;
}

/** 오르카 `worktree show`나 `worktree create`의 `--json` 응답에서 워크트리 칸 하나를 꺼낸다 */
export function worktreeField(
  stdout: string,
  field: 'path' | 'id' | 'repoId' | 'branch',
): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const d = data as { ok?: boolean; result?: { worktree?: Record<string, unknown> } };
  if (d.ok === false) return undefined;
  const v = d.result?.worktree?.[field];
  return typeof v === 'string' && v ? v : undefined;
}

function git(exec: SyncExec, cwd: string, args: string[]): string | undefined {
  try {
    return exec('git', ['-C', cwd, ...args]).trim() || undefined;
  } catch (err) {
    if (err instanceof ExecTimeoutError) throw err;
    return undefined;
  }
}

/** 심링크를 푼 절대 경로. 경로가 없으면 resolve만 한다 */
export function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
