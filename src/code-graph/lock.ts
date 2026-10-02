import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { logger } from '../core/logger.js';

/**
 * 주인이 살아 있어도 이보다 오래 잡힌 락은 버려진 것으로 본다.
 * pid 재사용으로 죽은 주인이 살아 있는 것처럼 보이는 경우를 막는 상한이라
 * 정상 빌드가 절대 안 닿을 만큼 넉넉하게 잡았다.
 */
export const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * 내용을 못 읽는 락을 버려진 것으로 보기까지 기다리는 시간.
 * `wx`로 만든 직후 내용을 쓰기 전에 다른 프로세스가 읽으면 빈 파일이 보인다.
 * 그걸 바로 버려진 락으로 보면 막 잡힌 남의 락을 지운다.
 */
const UNREADABLE_GRACE_MS = 5000;

interface LockContent {
  pid: number;
  token: string;
  acquiredAt: number;
}

export interface LockHandle {
  readonly path: string;
  readonly token: string;
  /** 락 파일이 아직 내 것일 때만 지운다. 지웠으면 true */
  release(): boolean;
}

export interface LockOptions {
  staleMs?: number;
  /** 테스트용. 기본은 process.pid */
  pid?: number;
}

function readLock(path: string): LockContent | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<LockContent>;
    if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string') return null;
    return {
      pid: parsed.pid,
      token: parsed.token,
      acquiredAt: typeof parsed.acquiredAt === 'number' ? parsed.acquiredAt : 0,
    };
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM은 프로세스가 있는데 신호 권한만 없는 경우다
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isStale(path: string, content: LockContent | null, staleMs: number): boolean {
  if (!content) {
    try {
      return Date.now() - statSync(path).mtimeMs > UNREADABLE_GRACE_MS;
    } catch {
      return true;
    }
  }
  if (!isAlive(content.pid)) return true;
  return Date.now() - content.acquiredAt > staleMs;
}

/**
 * 락 파일을 배타적으로 만든다. 못 잡으면 null.
 *
 * 버려진 락은 지우고 한 번 더 시도한다. 지우기 직전에 토큰을 다시 읽어
 * 판정 사이에 다른 프로세스가 새로 잡은 락을 지우지 않게 한다.
 */
export function tryAcquireLock(path: string, opts: LockOptions = {}): LockHandle | null {
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const pid = opts.pid ?? process.pid;

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = randomUUID();
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, JSON.stringify({ pid, token, acquiredAt: Date.now() }));
      } finally {
        closeSync(fd);
      }
      return makeHandle(path, pid, token);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    const held = readLock(path);
    if (!isStale(path, held, staleMs)) return null;
    const recheck = readLock(path);
    if (held && recheck?.token !== held.token) return null;
    try {
      unlinkSync(path);
      logger.warn('code_graph.lock_stale_removed', {
        module: 'code-graph/lock',
        path,
        previousPid: held?.pid,
      });
    } catch {
      // 다른 프로세스가 먼저 지웠다. 다시 만들기를 시도한다
    }
  }
  return null;
}

function makeHandle(path: string, pid: number, token: string): LockHandle {
  return {
    path,
    token,
    release(): boolean {
      // 오래 걸려 stale로 판정되면 락이 다른 프로세스로 넘어갔을 수 있다.
      // 그때 지우면 지금 주인의 락을 빼앗는 셈이라 확인 없이 지우지 않는다
      const current = readLock(path);
      if (!current || current.pid !== pid || current.token !== token) {
        logger.warn('code_graph.lock_not_owned_on_release', {
          module: 'code-graph/lock',
          path,
          ownerPid: current?.pid,
        });
        return false;
      }
      try {
        unlinkSync(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** timeoutMs 동안 pollMs 간격으로 다시 시도한다. 끝내 못 잡으면 null */
export async function acquireLock(
  path: string,
  opts: LockOptions & { timeoutMs?: number; pollMs?: number } = {},
): Promise<LockHandle | null> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const pollMs = opts.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const handle = tryAcquireLock(path, opts);
    if (handle) return handle;
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}
