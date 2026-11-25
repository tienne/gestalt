import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPlainObject, writeJsonAtomic } from '../core/json-file.js';
import { readAutomationClaim } from './bot-handoff-coordination.js';
import { currentBotOwner, readBotOwnership } from './bot-owner.js';
import { acquireLock } from './engine.js';
import { isSessionId } from './handoff.js';
import { digest, OrcaAutomationEditRejected, retargetBotAutomation } from './orca-automation.js';

interface EditJob {
  store: string;
  coordinationDir: string;
  request: string;
  approval: string;
  attempt: string;
}

interface EditReceipt {
  outcome: 'dispatched' | 'applied' | 'rejected';
  detail?: string;
  dispatchedAt?: string;
}

function requestDir(dir: string, approval: string): string {
  if (!/^[a-f0-9]{64}$/.test(approval)) throw new Error('Orca 편집 승인값을 확인해 주세요');
  return join(dir, 'edits', approval);
}

export function hasEditAttempts(dir: string, approval: string): boolean {
  try {
    return readdirSync(requestDir(dir, approval)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function attemptDir(dir: string, approval: string, attempt: string): string {
  if (!isSessionId(attempt)) throw new Error('Orca 편집 시도 ID를 확인해 주세요');
  return join(requestDir(dir, approval), attempt);
}

export function lockEditAttempt(dir: string, approval: string, attempt: string) {
  const path = attemptDir(dir, approval, attempt);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return acquireLock(path);
}

export function readEditReceipt(
  dir: string,
  approval: string,
  attempt: string,
): EditReceipt | undefined {
  let value: unknown;
  try {
    value = JSON.parse(
      readFileSync(join(attemptDir(dir, approval, attempt), 'receipt.json'), 'utf8'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (
    !isPlainObject(value) ||
    (value['outcome'] !== 'dispatched' &&
      value['outcome'] !== 'applied' &&
      value['outcome'] !== 'rejected') ||
    (value['detail'] !== undefined && typeof value['detail'] !== 'string') ||
    (value['dispatchedAt'] !== undefined && typeof value['dispatchedAt'] !== 'string')
  )
    throw new Error('Orca 편집 요청의 응답 기록을 읽을 수 없어요');
  return {
    outcome: value['outcome'],
    ...(value['detail'] ? { detail: value['detail'] } : {}),
    ...(value['dispatchedAt'] ? { dispatchedAt: value['dispatchedAt'] } : {}),
  };
}

/** 부모가 종료되어도 동일한 편집 시도가 중복 실행되지 않고 Orca 응답을 남길 수 있다. */
export async function runAutomationEdit(
  job: EditJob,
  retarget = retargetBotAutomation,
): Promise<void> {
  const { store, coordinationDir, request, approval, attempt } = job;
  const lock = lockEditAttempt(coordinationDir, approval, attempt);
  if (!lock.ok) return;
  try {
    const { active, handoffs, revision } = readBotOwnership(store);
    const pending = handoffs.find((entry) => entry.id === request);
    if (
      !pending ||
      pending.outcome ||
      pending.cancelPending ||
      pending.approval !== approval ||
      pending.editAttempt !== attempt ||
      active?.chatId !== pending.from ||
      active.botId !== pending.botId ||
      revision !== pending.revision ||
      basename(coordinationDir) !== digest(pending.automationId) ||
      readAutomationClaim(coordinationDir)?.store !== store ||
      readEditReceipt(coordinationDir, approval, attempt)
    )
      return;
    const dispatchedAt = new Date().toISOString();
    const save = (record: EditReceipt) =>
      writeJsonAtomic(
        join(attemptDir(coordinationDir, approval, attempt), 'receipt.json'),
        { ...record, dispatchedAt },
        {
          mode: 0o600,
        },
      );
    save({ outcome: 'dispatched' });
    try {
      await retarget(pending.automationId, pending.to);
    } catch (error) {
      save({
        outcome: error instanceof OrcaAutomationEditRejected ? 'rejected' : 'dispatched',
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    save({ outcome: 'applied' });
  } finally {
    lock.release();
  }
}

export function launchAutomationEdit(job: EditJob): Promise<void> {
  const loader = import.meta.url.endsWith('.ts')
    ? ['--import', createRequire(import.meta.url).resolve('tsx')]
    : [];
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        ...loader,
        fileURLToPath(import.meta.url),
        job.store,
        job.coordinationDir,
        job.request,
        job.approval,
        job.attempt,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('Orca 편집 실행 프로세스가 끝까지 응답하지 못했어요'));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [store, coordinationDir, request, approval, attempt] = process.argv.slice(2);
  void (async () => {
    if (
      !store ||
      !coordinationDir ||
      !isSessionId(request) ||
      !approval ||
      !isSessionId(attempt) ||
      process.env['GESTALT_CONDUCTOR_WORKER_ID'] ||
      (await currentBotOwner())
    )
      throw new Error('Orca 편집은 운영자 인계 요청에서 실행해 주세요');
    await runAutomationEdit({ store, coordinationDir, request, approval, attempt });
  })().catch(() => {
    process.exitCode = 1;
  });
}
