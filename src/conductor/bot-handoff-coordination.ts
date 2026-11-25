import { mkdirSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { isPlainObject, writeJsonAtomic } from '../core/json-file.js';
import { isBotHandoffRecord, type BotHandoffRecord } from './bot-handoff-record.js';
import { acquireLock } from './engine.js';
import { digest } from './orca-automation.js';

interface AutomationClaim {
  store: string;
  request: string;
  intent?: BotHandoffRecord;
}

/** 로컬 Orca에 접근하는 같은 OS 계정의 상태 저장소들이 한 장소를 공유한다. */
export function automationCoordinationRoot(): string {
  return join(userInfo().homedir, '.gestalt', 'orca-handoffs');
}

export function automationCoordinationDir(root: string, automationId: string): string {
  return join(root, digest(automationId));
}

export function lockAutomationHandoff(root: string, automationId: string) {
  const dir = automationCoordinationDir(root, automationId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = acquireLock(dir);
  if (!lock.ok) return undefined;
  return {
    dir,
    release: lock.release,
    read: () => readAutomationClaim(dir),
    claim(store: string, intent: BotHandoffRecord) {
      writeJsonAtomic(
        join(dir, 'claim.json'),
        { store, request: intent.id, intent },
        { mode: 0o600 },
      );
    },
    readRelease(approval: string) {
      return readClaimFile(releasePath(dir, approval));
    },
    releaseClaim(approval: string) {
      const released = releasePath(dir, approval);
      if (readClaimFile(released)) throw new Error('같은 인계 요청의 예약 해제 기록이 이미 있어요');
      mkdirSync(join(dir, 'released'), { recursive: true, mode: 0o700 });
      renameSync(join(dir, 'claim.json'), released);
    },
  };
}

export function readAutomationClaim(dir: string): AutomationClaim | undefined {
  return readClaimFile(join(dir, 'claim.json'));
}

function releasePath(dir: string, approval: string): string {
  if (!/^[a-f0-9]{64}$/.test(approval)) throw new Error('Orca 인계 승인값을 확인해 주세요');
  return join(dir, 'released', `${approval}.json`);
}

function readClaimFile(path: string): AutomationClaim | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (
    !isPlainObject(value) ||
    typeof value['store'] !== 'string' ||
    typeof value['request'] !== 'string' ||
    (value['intent'] !== undefined &&
      (!isBotHandoffRecord(value['intent']) || value['intent'].id !== value['request']))
  )
    throw new Error('Orca 자동화의 공유 인계 기록을 읽을 수 없어요');
  return {
    store: value['store'],
    request: value['request'],
    ...(value['intent'] ? { intent: value['intent'] } : {}),
  };
}

/** 취소 기록을 먼저 쓰던 버전에서도 아직 예약이 남았다면 복구가 끝나지 않았다. */
export function handoffCancellationPending(
  dir: string,
  record: BotHandoffRecord,
  root: string,
): boolean {
  if (record.cancelPending) return true;
  if (record.outcome !== 'cancelled') return false;
  try {
    const claim = readAutomationClaim(automationCoordinationDir(root, record.automationId));
    return claim?.store === realpathSync(dir) && claim.request === record.id;
  } catch {
    return true;
  }
}
