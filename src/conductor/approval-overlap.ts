import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { changedFilesOf } from './activity-tick.js';
import { readWorkerInfo } from './activity.js';
import type { CommandRunner, LauncherSet } from './launcher.js';
import type { ConductorStore } from './store.js';
import { TERMINAL_ORDER_STATUSES, type Gate } from './types.js';

export function overlapScope(other: string, files: string[]) {
  const sorted = [...files].sort();
  return {
    count: sorted.length,
    refs: sorted,
    payload: {
      overlapWith: other,
      overlapDigest: createHash('sha256').update(JSON.stringify(sorted)).digest('hex'),
    },
  };
}

export async function changedApprovalOverlap(
  store: ConductorStore,
  gate: Gate,
  runner: CommandRunner,
  launchers: LauncherSet,
): Promise<ReturnType<typeof overlapScope> | undefined> {
  if (gate.type !== 'file-overlap') return;
  const order = gate.orderId ? store.order(gate.orderId) : undefined;
  const other = gate.payload?.overlapWith;
  if (!order || !other) throw new Error('승인한 파일 중첩 범위를 다시 읽을 수 없어요');
  const peer = store.order(other);
  let files: string[] = [];
  if (peer && !TERMINAL_ORDER_STATUSES.has(peer.status)) {
    const lists = await Promise.all(
      [order, peer].map(async (o) => {
        const worker = o.workerId ? store.worker(o.workerId) : undefined;
        if (!worker) return undefined;
        const cwd =
          worker.kind === 'git-worktree'
            ? worker.handle
            : (readWorkerInfo(store.dir, worker.id).worktreePath ??
              (await launchers[worker.kind]?.worktreePath?.(worker)));
        return cwd && existsSync(cwd)
          ? (await changedFilesOf(runner, cwd, o.baseBranch, true))?.files
          : undefined;
      }),
    );
    const [mine, theirs] = lists;
    if (!mine || !theirs) throw new Error('승인 대상 두 워크트리의 변경 파일을 확인하지 못했어요');
    const mineSet = new Set(mine);
    files = theirs.filter((file) => mineSet.has(file));
  }
  const current = overlapScope(other, files);
  const digest = gate.payload?.overlapDigest;
  const same = digest
    ? digest === current.payload.overlapDigest
    : files.length < 20 && JSON.stringify(gate.refs) === JSON.stringify(current.refs);
  if (!same) return current;
}
