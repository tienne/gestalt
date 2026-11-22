import { existsSync } from 'node:fs';
import { readWorkerInfo, updateWorkerInfo, type WorkerActivityInfo } from './activity.js';
import type { CommandRunner, Launcher } from './launcher.js';
import type { Order, Worker } from './types.js';

/** 고친 파일 목록 상한. 넘으면 앞에서 자르고 개수만 맞게 둔다 */
const MAX_CHANGED_FILES = 500;
const GIT_TIMEOUT_MS = 15_000;

/**
 * 워크트리에서 기준 브랜치와 갈라진 지점 이후 고친 파일을 모은다. 커밋 안 한 변경과 추적 안 한 새 파일도 넣는다.
 * 기준을 못 찾거나 git이 실패하면 undefined라 부르는 쪽은 앞 값을 그대로 둔다
 */
export async function changedFilesOf(
  runner: CommandRunner,
  cwd: string,
  baseBranch: string | undefined,
): Promise<{ files: string[]; base: string } | undefined> {
  const git = (args: string[]) => runner('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  const candidates = [
    ...(baseBranch ? [`origin/${baseBranch}`, baseBranch] : []),
    'origin/HEAD',
    'origin/main',
    'main',
  ];
  let mergeBase: string | undefined;
  let base: string | undefined;
  for (const ref of candidates) {
    const r = await git(['merge-base', 'HEAD', ref]);
    const sha = r.stdout.trim();
    if (r.code === 0 && /^[0-9a-f]{7,64}$/.test(sha)) {
      mergeBase = sha;
      base = ref;
      break;
    }
  }
  if (!mergeBase || !base) return undefined;
  const diff = await git(['diff', '--name-only', mergeBase]);
  if (diff.code !== 0) return undefined;
  const untracked = await git(['ls-files', '--others', '--exclude-standard']);
  const lines = (s: string) =>
    s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  const files = [
    ...new Set([...lines(diff.stdout), ...(untracked.code === 0 ? lines(untracked.stdout) : [])]),
  ].sort();
  return { files: files.slice(0, MAX_CHANGED_FILES), base };
}

export interface ActivityTickDeps {
  stateDir: string;
  runner: CommandRunner;
  launchers: Partial<Record<Worker['kind'], Launcher>>;
  now: Date;
}

/**
 * tick 한 번에 워커마다 워크트리 경로와 고친 파일을 저장한다. status는 이 값을 읽기만 한다.
 * 워커 하나가 실패해도 나머지는 계속 돈다
 */
export async function refreshWorkerActivity(
  workers: Worker[],
  orderOf: (w: Worker) => Order | undefined,
  deps: ActivityTickDeps,
): Promise<Map<string, WorkerActivityInfo>> {
  const out = new Map<string, WorkerActivityInfo>();
  for (const w of workers) {
    if (w.kind === 'subagent') continue;
    try {
      let info = readWorkerInfo(deps.stateDir, w.id);
      if (!info.worktreePath) {
        const path =
          w.kind === 'git-worktree' ? w.handle : await deps.launchers[w.kind]?.worktreePath?.(w);
        if (path) info = updateWorkerInfo(deps.stateDir, w.id, { worktreePath: path });
      }
      const cwd = info.worktreePath;
      if (cwd && existsSync(cwd)) {
        const changed = await changedFilesOf(deps.runner, cwd, orderOf(w)?.baseBranch);
        if (changed)
          info = updateWorkerInfo(deps.stateDir, w.id, {
            changedFiles: changed.files,
            changedBase: changed.base,
            changedAt: deps.now.toISOString(),
          });
      }
      out.set(w.id, info);
    } catch {
      // 작업 내용은 보여 주기용이라 실패해도 tick을 멈추지 않는다
    }
  }
  return out;
}
