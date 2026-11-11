import { readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tildify } from './paths.js';
import { copyPath, isEmptyDir, lstatOrNull, linkTargetOf, movePath, samePath } from './fs-ops.js';
import {
  listRuns,
  pruneRuns,
  RunWriter,
  writeRun,
  type RunAction,
  type RunRecord,
} from './run-store.js';

export class RevertError extends Error {}

/**
 * 되돌릴 sync 실행을 고른다. 아무것도 안 주면 아직 안 되돌린 가장 최근 sync다.
 * 더 새 sync가 살아 있으면 예전 실행은 거부한다. 그 사이에 바뀐 것이 뒤엉킨다.
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
    const backup = run.moveToBackup(path);
    run.log({ op: 'backup', path, backup });
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
          if (!lstatOrNull(action.path)) return;
          const backup = run.moveToBackup(action.path);
          run.log({ op: 'backup', path: action.path, backup });
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
          if (lstatOrNull(action.path)) {
            const backup = run.moveToBackup(action.path);
            run.log({ op: 'backup', path: action.path, backup });
          }
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
    default:
      return null;
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
  const target = pickRun(listRuns(), input.runId);
  const steps = [...target.actions]
    .reverse()
    .map((a) => stepFor(a, t))
    .filter((s): s is RevertStep => s !== null);
  const reverted = { runId: target.runId, dirName: target.dirName, createdAt: target.createdAt };
  const changes = steps.map((s) => s.summary);
  if (input.dryRun) return { reverted, changes, notes: [], pruned: [] };

  const now = input.now ?? new Date();
  const run = new RunWriter('revert', input.home, now, target.runId);
  const notes: string[] = [];
  for (const step of steps) {
    try {
      step.apply(run, notes);
    } catch (e) {
      run.record.changes.push(`(실패) ${step.summary}`);
      run.save();
      throw new RevertError(
        `${step.summary} 중에 멈췄어요: ${(e as Error).message}\n여기까지 한 일은 ${run.recordFile}에 있어요`,
        { cause: e },
      );
    }
    run.record.changes.push(step.summary);
  }
  run.record.changes.push(...notes.map((n) => `(참고) ${n}`));
  run.save();
  writeRun({ ...target, revertedAt: now.toISOString(), revertedBy: run.record.runId });
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
