import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { withFileLock } from '../../../src/core/file-lock.js';

/** 지금 안 도는 pid. int32 최댓값 바로 아래라 거의 확실히 비어 있다 */
const DEAD_PID = 0x7ffffffe;

describe('withFileLock', () => {
  let dir: string;
  let lock: string;

  beforeEach(() => {
    dir = join(tmpdir(), `gestalt-file-lock-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    lock = join(dir, 'data.json.lock');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function plantLock(owner: { token: string; pid: number }, ageMs: number): void {
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), JSON.stringify(owner), 'utf-8');
    const at = (Date.now() - ageMs) / 1000;
    utimesSync(lock, at, at);
  }

  it('끝나면 잠금을 푼다', () => {
    const result = withFileLock(lock, ({ stillMine }) => stillMine());
    expect(result).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('주인이 죽은 오래된 잠금은 부수고 들어간다', () => {
    plantLock({ token: '죽은-주인', pid: DEAD_PID }, 10_000);
    expect(withFileLock(lock, () => 'ok')).toBe('ok');
    expect(existsSync(lock)).toBe(false);
  });

  it('주인이 살아 있는 잠금은 기다리다 포기한다', () => {
    plantLock({ token: '산-주인', pid: process.pid }, 0);
    expect(() => withFileLock(lock, () => 'ok', { busyMessage: '잠겨 있어요' })).toThrow(
      '잠겨 있어요',
    );
    // 남의 잠금은 그대로 남아야 한다
    expect(readFileSync(join(lock, 'owner'), 'utf-8')).toContain('산-주인');
  }, 10_000);

  it('도중에 잠금이 남의 것이 되면 끝날 때 지우지 않는다', () => {
    withFileLock(lock, () => {
      writeFileSync(join(lock, 'owner'), JSON.stringify({ token: '남의-것', pid: 1 }), 'utf-8');
    });
    expect(readFileSync(join(lock, 'owner'), 'utf-8')).toContain('남의-것');
  });
});
