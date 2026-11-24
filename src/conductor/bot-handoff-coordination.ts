import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { isPlainObject, writeJsonAtomic } from '../core/json-file.js';
import { acquireLock } from './engine.js';
import { digest } from './orca-automation.js';

interface AutomationClaim {
  store: string;
  request: string;
}

/** 로컬 Orca에 접근하는 같은 OS 계정의 상태 저장소들이 한 장소를 공유한다. */
export function automationCoordinationRoot(): string {
  return join(userInfo().homedir, '.gestalt', 'orca-handoffs');
}

export function lockAutomationHandoff(root: string, automationId: string) {
  const dir = join(root, digest(automationId));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = acquireLock(dir);
  if (!lock.ok) return undefined;
  const path = join(dir, 'claim.json');
  return {
    release: lock.release,
    read(): AutomationClaim | undefined {
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
        typeof value['request'] !== 'string'
      )
        throw new Error('Orca 자동화의 공유 인계 기록을 읽을 수 없어요');
      return { store: value['store'], request: value['request'] };
    },
    claim(store: string, request: string) {
      writeJsonAtomic(path, { store, request }, { mode: 0o600 });
    },
    clear() {
      rmSync(path, { force: true });
    },
  };
}
