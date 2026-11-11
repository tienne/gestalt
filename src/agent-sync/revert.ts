import { readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { copyPath, isEmptyDir, lstatOrNull, linkTargetOf, movePath, samePath } from './fs-ops.js';
import { isInside, sourcePaths, tildify } from './paths.js';
import {
  backupPathIn,
  listRunsNewestFirst,
  pruneRuns,
  runDir,
  RunWriter,
  writeRun,
  type CorruptRun,
  type RunAction,
  type RunRecord,
} from './run-store.js';

export class RevertError extends Error {}

/**
 * 되돌릴 sync 실행을 고른다. 아무것도 안 주면 아직 안 되돌린 가장 최근 sync다.
 * 아직 되돌리지 않은 더 새 sync가 있으면 예전 실행은 거부한다. 그 사이에 바뀐 것이 뒤엉킨다.
 */
export function pickRun(runs: RunRecord[], wanted?: string): RunRecord {
  const syncs = runs.filter((r) => r.kind === 'sync');
  if (!wanted) {
    const latest = syncs.find((r) => !r.revertedAt);
    if (!latest) throw new RevertError('되돌릴 sync 실행이 없어요');
    return latest;
  }
  const found = runs.find((r) => r.runId === wanted || r.dirName === wanted);
  if (!found) throw new RevertError(`${wanted} 실행 기록을 못 찾았어요`);
  if (found.kind === 'doctor')
    throw new RevertError('doctor가 고친 것은 되돌리기 대상이 아니에요. sync 실행만 되돌려요');
  if (found.kind !== 'sync')
    throw new RevertError(`${wanted}는 되돌리기 실행이라 다시 되돌릴 수 없어요`);
  if (found.revertedAt) throw new RevertError(`${wanted}는 이미 ${found.revertedAt}에 되돌렸어요`);
  const newer = syncs.find((r) => !r.revertedAt && r.createdAt > found.createdAt);
  if (newer) {
    throw new RevertError(
      `더 새 sync 실행 ${newer.runId}가 있어요. 그것부터 되돌린 뒤에 다시 해 주세요`,
    );
  }
  return found;
}

interface RevertStep {
  summary: string;
  apply(run: RunWriter, notes: string[]): void;
}

function stepFor(action: RunAction, t: (p: string) => string): RevertStep | null {
  /** 그 자리에 sync 뒤로 생긴 게 있으면 새 실행 폴더에 백업하고 치운다 */
  const clear = (run: RunWriter, notes: string[], path: string) => {
    if (!lstatOrNull(path)) return;
    const backup = run.moveToBackup('backup', path);
    notes.push(`${t(path)}에 sync 뒤로 바뀐 것이 있어 ${t(backup)}에 백업했어요`);
  };

  switch (action.op) {
    case 'create_link':
      return {
        summary: `sync가 만든 ${t(action.path)} 링크를 지움`,
        apply: (run, notes) => {
          const st = lstatOrNull(action.path);
          if (!st) return;
          if (st.isSymbolicLink() && samePath(linkTargetOf(action.path), action.target)) {
            unlinkSync(action.path);
            run.log({ op: 'remove', path: action.path });
            return;
          }
          clear(run, notes, action.path);
        },
      };
    case 'stash':
      return {
        summary: `백업해 둔 ${t(action.path)}를 제자리로 돌림`,
        apply: (run, notes) => {
          if (!lstatOrNull(action.backup)) {
            notes.push(`${t(action.path)}의 백업 ${t(action.backup)}가 없어 돌리지 못했어요`);
            return;
          }
          clear(run, notes, action.path);
          movePath(action.backup, action.path);
          run.log({ op: 'restore', path: action.path });
        },
      };
    case 'move':
      return {
        summary: `${t(action.to)}를 ${t(action.from)}로 다시 옮김`,
        apply: (run, notes) => {
          if (!lstatOrNull(action.to)) {
            notes.push(`옮겨 둔 ${t(action.to)}가 없어 ${t(action.from)}로 돌리지 못했어요`);
            return;
          }
          clear(run, notes, action.from);
          movePath(action.to, action.from);
          run.log({ op: 'restore', path: action.from });
        },
      };
    case 'create_file':
      return {
        summary: `sync가 만든 ${t(action.path)}를 치움 (지우지 않고 백업에 둠)`,
        apply: (run) => {
          if (lstatOrNull(action.path)) run.moveToBackup('backup', action.path);
        },
      };
    case 'write_file':
      return {
        summary: `${t(action.path)}를 sync 전 내용으로 돌림`,
        apply: (run, notes) => {
          if (!lstatOrNull(action.backup)) {
            notes.push(`${t(action.path)}의 백업 ${t(action.backup)}가 없어 돌리지 못했어요`);
            return;
          }
          if (lstatOrNull(action.path)) run.moveToBackup('backup', action.path);
          copyPath(action.backup, action.path);
          run.log({ op: 'restore', path: action.path });
        },
      };
    case 'mkdir':
      return {
        summary: `sync가 만든 ${t(action.path)} 폴더를 비어 있으면 지움`,
        apply: (run, notes) => {
          if (!lstatOrNull(action.path)) return;
          if (isEmptyDir(action.path)) {
            rmdirSync(action.path);
            run.log({ op: 'remove', path: action.path });
            return;
          }
          const left = lstatOrNull(action.path)?.isDirectory()
            ? readdirSync(action.path).sort()
            : [];
          notes.push(
            `${t(action.path)}에 sync 뒤로 생긴 항목이 있어 폴더를 남겼어요: ${left.join(', ')}`,
          );
        },
      };
    case 'pending': {
      // 옮기다 멈춘 동작. 옮겨 갈 자리가 비어 있으면 원래 것이 제자리에 있으니 할 일이 없다
      const inner = action.action;
      const landed = inner.op === 'move' ? inner.to : inner.backup;
      return lstatOrNull(landed) ? stepFor(inner, t) : null;
    }
    default:
      return null;
  }
}

const SLOT_NAMES = new Set(['skills', 'CLAUDE.md', 'AGENTS.md']);

/** sync가 남길 수 없는 동작이면 그 이유. 경로는 홈 아래로 묶지 않는다. 오르카 데이터 폴더가 홈 밖일 수 있다 */
function actionProblem(
  action: RunAction,
  ctx: { dir: string; home: string; agents: string; t: (p: string) => string },
): string | null {
  const { dir, home, agents, t } = ctx;
  const paths = Object.entries(action).flatMap(([k, v]) =>
    k !== 'op' && typeof v === 'string' ? [v] : [],
  );
  const bad = paths.find((p) => !isAbsolute(p) || resolve(p) !== p);
  if (bad) return `정리된 절대 경로가 아니에요: ${bad}`;
  const slotOk = (p: string) => SLOT_NAMES.has(basename(p));
  const backupOk = (path: string, backup: string) =>
    isInside(dir, backup) && backup === backupPathIn(dir, home, path);

  switch (action.op) {
    case 'mkdir':
      return isInside(agents, action.path)
        ? null
        : `~/.agents 밖에 만든 폴더예요: ${t(action.path)}`;
    case 'create_file':
      return slotOk(action.path) ? null : `다루지 않는 자리예요: ${t(action.path)}`;
    case 'write_file':
    case 'stash':
      if (!slotOk(action.path)) return `다루지 않는 자리예요: ${t(action.path)}`;
      return backupOk(action.path, action.backup)
        ? null
        : `백업 경로가 실행 폴더 안의 제자리가 아니에요: ${t(action.backup)}`;
    case 'create_link':
      if (!slotOk(action.path)) return `다루지 않는 자리예요: ${t(action.path)}`;
      return isInside(agents, action.target)
        ? null
        : `~/.agents 밖을 가리키는 링크예요: ${t(action.target)}`;
    case 'move':
      if (basename(dirname(action.from)) !== 'skills')
        return `skills 폴더 밖에서 옮긴 항목이에요: ${t(action.from)}`;
      return isInside(agents, action.to)
        ? null
        : `~/.agents 밖으로 옮긴 항목이에요: ${t(action.to)}`;
    case 'pending':
      return action.action.op === 'backup'
        ? 'sync 기록에 없어야 할 backup 동작이 있어요'
        : actionProblem(action.action, ctx);
    default:
      return `sync 기록에 없어야 할 ${action.op} 동작이 있어요`;
  }
}

/**
 * 기록을 믿고 옮기기 전에 sync가 남길 수 있는 모양인지 전부 본다.
 * 하나라도 어긋나면 아무것도 바꾸지 않고 멈춘다. run.json을 누가 고쳤으면 임의 경로를 옮기게 된다.
 */
function checkRevertable(target: RunRecord, home: string, t: (p: string) => string): void {
  const ctx = { dir: runDir(target), home, agents: sourcePaths(home).root, t };
  const problems = target.actions.flatMap((a, i) => {
    const p = actionProblem(a, ctx);
    return p ? [`${i}번 동작: ${p}`] : [];
  });
  if (problems.length > 0) {
    throw new RevertError(
      `${target.dirName}/run.json을 믿을 수 없어 아무것도 바꾸지 않았어요\n${problems.join('\n')}`,
    );
  }
}

/** 날짜까지만 아는 깨진 기록이 고른 실행과 같은 날이거나 더 뒤면 그 사이에 무슨 일이 있었는지 몰라 거부한다 */
function refuseNewerCorrupt(target: RunRecord, corrupt: CorruptRun[]): void {
  const day = target.dirName.slice(0, 10);
  const newer = corrupt.find((c) => c.dirName.slice(0, 10) >= day);
  if (newer) {
    throw new RevertError(
      `${newer.dirName} 기록을 읽지 못했어요 (${newer.reason}). 더 새 실행일 수 있어 되돌리지 않았어요. 그 폴더를 확인한 뒤에 다시 해 주세요`,
    );
  }
}

export interface RevertInput {
  home: string;
  runId?: string;
  dryRun: boolean;
  now?: Date;
}

export interface RevertResult {
  reverted: { runId: string; dirName: string; createdAt: string };
  changes: string[];
  notes: string[];
  pruned: string[];
  run?: { runId: string; dir: string; recordFile: string };
}

export function runRevert(input: RevertInput): RevertResult {
  const t = (p: string) => tildify(p, input.home);
  const listing = listRunsNewestFirst();
  const target = pickRun(listing.runs, input.runId);
  refuseNewerCorrupt(target, listing.corrupt);
  checkRevertable(target, input.home, t);

  // 앞서 멈춘 되돌리기가 있으면 거기서 이어간다. 되돌린 항목을 다시 치우면 상태가 꼬인다
  const todo: { index: number; step: RevertStep }[] = [];
  for (let i = (target.revertProgress ?? target.actions.length) - 1; i >= 0; i--) {
    const step = stepFor(target.actions[i]!, t);
    if (step) todo.push({ index: i, step });
  }
  const reverted = { runId: target.runId, dirName: target.dirName, createdAt: target.createdAt };
  const changes = todo.map((s) => s.step.summary);
  const warnings = listing.corrupt.map((c) => `${c.dirName} 기록을 읽지 못했어요 (${c.reason})`);
  if (input.dryRun) return { reverted, changes, notes: warnings, pruned: [] };

  const now = input.now ?? new Date();
  const run = new RunWriter('revert', input.home, now, target.runId);
  const notes: string[] = [...warnings];
  let progress: RunRecord = target;
  for (const { index, step } of todo) {
    try {
      step.apply(run, notes);
    } catch (e) {
      run.record.changes.push(`(실패) ${step.summary}`);
      run.save();
      throw new RevertError(
        `${step.summary} 중에 멈췄어요: ${(e as Error).message}\n여기까지 한 일은 ${run.recordFile}에 있어요. 다시 돌리면 멈춘 단계부터 이어서 해요`,
        { cause: e },
      );
    }
    run.record.changes.push(step.summary);
    progress = { ...progress, revertProgress: index };
    writeRun(progress);
  }
  run.record.changes.push(...notes.map((n) => `(참고) ${n}`));
  run.save();
  writeRun({ ...progress, revertedAt: now.toISOString(), revertedBy: run.record.runId });
  // 고른 실행이 보관 기간 끝자락이어도 되돌린 다음에 정리한다
  const pruned = pruneRuns(now);
  return {
    reverted,
    changes,
    notes,
    pruned,
    run: { runId: run.record.runId, dir: run.dir, recordFile: run.recordFile },
  };
}
