import { existsSync } from 'node:fs';
import { log } from '../core/log.js';
import {
  readWorkerInfo,
  refreshTranscript,
  updateWorkerInfo,
  type WorkerActivityInfo,
} from './activity.js';
import type { BackgroundGate } from './transcript.js';
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

function sameChanged(info: WorkerActivityInfo, next: { files: string[]; base: string }): boolean {
  const prev = info.changedFiles;
  return (
    info.changedBase === next.base &&
    !!prev &&
    prev.length === next.files.length &&
    prev.every((f, i) => f === next.files[i])
  );
}

export interface WorkerActivitySnapshot {
  info: WorkerActivityInfo;
  /** 트랜스크립트에서 읽은 마지막 줄의 시각. 못 읽었으면 없다 */
  lastEventAt?: string;
  backgroundGate?: BackgroundGate;
}

export interface ActivityTickDeps {
  stateDir: string;
  runner: CommandRunner;
  launchers: Partial<Record<Worker['kind'], Launcher>>;
  now: Date;
  /** 트랜스크립트를 찾을 projects 폴더. 없으면 CLAUDE_CONFIG_DIR와 ~/.claude 아래를 본다 */
  transcriptRoots?: string[];
}

/**
 * tick 한 번에 워커마다 워크트리 경로와 고친 파일을 저장하고 트랜스크립트를 새 줄까지 읽는다. status는 고친 파일을 읽기만 한다.
 * 워커 하나가 실패해도 나머지는 계속 돈다
 */
export async function refreshWorkerActivity(
  workers: Worker[],
  orderOf: (w: Worker) => Order | undefined,
  deps: ActivityTickDeps,
): Promise<Map<string, WorkerActivitySnapshot>> {
  const out = new Map<string, WorkerActivitySnapshot>();
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
        // 목록이 그대로면 쓰지 않는다. tick마다 같은 파일을 다시 쓰면 changedAt만 바뀐다
        if (changed && !sameChanged(info, changed))
          info = updateWorkerInfo(deps.stateDir, w.id, {
            changedFiles: changed.files,
            changedBase: changed.base,
            changedAt: deps.now.toISOString(),
          });
      }
      const state = refreshTranscript(
        deps.stateDir,
        w,
        info,
        deps.transcriptRoots ? { roots: deps.transcriptRoots } : {},
      );
      const d = state?.digest;
      out.set(w.id, {
        info,
        ...(d?.lastEventAt ? { lastEventAt: d.lastEventAt } : {}),
        ...(d?.backgroundGate ? { backgroundGate: d.backgroundGate } : {}),
      });
    } catch (err) {
      // 작업 내용은 보여 주기용이라 실패해도 tick을 멈추지 않는다. report.errors에 넣으면 tick이 idle로 못 쉰다
      log(`conductor activity ${w.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

export const GATE_STALL_MESSAGE =
  '백그라운드로 띄운 gate가 끝났는데 턴이 멈춰 있어요. gate를 포그라운드로 다시 돌려 결과를 확인하고 이어서 진행해 주세요';

/**
 * gate를 백그라운드로 띄우고 턴을 끝낸 채 기준 시간을 넘긴 워커. 한 워커에 한 번만 고른다.
 * 새 턴이 오면 리더가 표시를 지우니 이미 깨어난 워커는 안 고른다
 */
export function gateStalled(
  snap: WorkerActivitySnapshot | undefined,
  now: Date,
  afterMs: number,
): boolean {
  if (!snap || snap.info.gateStallNotifiedAt) return false;
  const ended = snap.backgroundGate?.turnEndedAt;
  const t = ended ? Date.parse(ended) : NaN;
  return !Number.isNaN(t) && now.getTime() - t >= afterMs;
}

export interface FileOverlap {
  /** 먼저 뜬 워커 */
  first: Worker;
  /** 뒤에 뜬 워커. 게이트는 이쪽 주문에 연다 */
  later: Worker;
  files: string[];
}

/** 같은 레포에서 도는 워커 둘씩 고친 파일의 교집합을 본다. 한 레포 안 쌍만 본다 */
export function fileOverlaps(
  workers: Worker[],
  repoOf: (w: Worker) => string | undefined,
  filesOf: (w: Worker) => string[] | undefined,
): FileOverlap[] {
  const byRepo = new Map<string, Worker[]>();
  for (const w of workers) {
    const repo = repoOf(w);
    if (!repo || !filesOf(w)?.length) continue;
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), w]);
  }
  const out: FileOverlap[] = [];
  for (const list of byRepo.values()) {
    const sorted = [...list].sort(
      (a, b) => a.startedAt.localeCompare(b.startedAt) || a.orderId.localeCompare(b.orderId),
    );
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]!;
      const mine = new Set(filesOf(a));
      for (const b of sorted.slice(i + 1)) {
        if (a.orderId === b.orderId) continue;
        const files = filesOf(b)!.filter((f) => mine.has(f));
        if (files.length > 0) out.push({ first: a, later: b, files });
      }
    }
  }
  return out;
}
