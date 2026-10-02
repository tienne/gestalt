import { spawn } from 'node:child_process';
import { mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCK_STALE_MS } from '../lock.js';
import { hooksDir } from './state.js';

export type RefreshSpawner = (repoRoot: string) => void;

/**
 * 훅 엔트리를 `refresh` 인자로 다시 띄운다. 부모는 기다리지 않는다.
 * 엔진은 typescript 파서까지 불러와 기동만 200ms를 넘게 먹으니 훅 프로세스 안에서 돌리지 않는다.
 */
export function detachedRefreshSpawner(entry: string): RefreshSpawner {
  return (repoRoot) => {
    const child = spawn(process.execPath, [entry, 'refresh', repoRoot], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.on('error', () => {});
    child.unref();
  };
}

/**
 * 직전 요청에서 minIntervalMs가 안 지났거나 다른 프로세스가 갱신 락을 쥐고 있으면 안 띄운다.
 * 연달아 Edit 하는 동안 갱신 프로세스가 줄줄이 뜨는 걸 막는다. 막힌 변경은
 * 턴 끝의 Stop 훅이 다시 요청해서 반영한다.
 *
 * 띄웠으면 true.
 */
export function requestRefresh(
  repoRoot: string,
  spawner: RefreshSpawner,
  minIntervalMs: number,
  now = Date.now(),
): boolean {
  const stamp = join(hooksDir(repoRoot), 'refresh.stamp');
  try {
    if (now - statSync(stamp).mtimeMs < minIntervalMs) return false;
  } catch {
    // 처음 요청한다
  }
  try {
    // 죽은 프로세스가 남긴 락이면 갱신이 영영 안 뜬다. 판정은 엔진 락과 같은 상한을 쓴다
    const lock = statSync(join(repoRoot, '.gestalt', 'code-graph.lock'));
    if (now - lock.mtimeMs < LOCK_STALE_MS) return false;
  } catch {
    // 락이 없다
  }

  mkdirSync(hooksDir(repoRoot), { recursive: true });
  writeFileSync(stamp, '');
  utimesSync(stamp, now / 1000, now / 1000);
  spawner(repoRoot);
  return true;
}
