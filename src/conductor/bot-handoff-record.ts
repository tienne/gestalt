import { isPlainObject } from '../core/json-file.js';
import { isSessionId } from './handoff.js';
import { digest } from './orca-automation.js';

export interface BotHandoffRecord {
  id: string;
  approval: string;
  automationId: string;
  from: string;
  to: string;
  botId: string;
  settings: string;
  revision: number;
  editUncertain?: boolean;
  editAttempt?: string;
  cancelledWithoutEdit?: boolean;
  cancelPending?: boolean;
  outcome?: 'completed' | 'cancelled';
  nextRunAt?: number;
}

/** 승인 발급과 공유 기록 검증에 동일한 스냅샷 필드를 사용한다. */
export function handoffApproval(
  store: string,
  { id, automationId, from, to, botId, settings, revision }: Omit<BotHandoffRecord, 'approval'>,
): string {
  return digest({ store, id, automationId, from, to, botId, settings, revision });
}

export function isBotHandoffRecord(value: unknown): value is BotHandoffRecord {
  return (
    isPlainObject(value) &&
    ['id', 'approval', 'automationId', 'from', 'to', 'botId', 'settings'].every(
      (key) => typeof value[key] === 'string',
    ) &&
    typeof value['revision'] === 'number' &&
    Number.isSafeInteger(value['revision']) &&
    ['editUncertain', 'cancelledWithoutEdit', 'cancelPending'].every(
      (key) => value[key] === undefined || typeof value[key] === 'boolean',
    ) &&
    (value['editAttempt'] === undefined ||
      (typeof value['editAttempt'] === 'string' && isSessionId(value['editAttempt']))) &&
    (value['outcome'] === undefined ||
      value['outcome'] === 'completed' ||
      value['outcome'] === 'cancelled') &&
    (value['nextRunAt'] === undefined || Number.isFinite(value['nextRunAt']))
  );
}
