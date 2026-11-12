import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConductorStore } from '../../../src/conductor/store.js';
import type { Order, Worker } from '../../../src/conductor/types.js';

const made: string[] = [];

/** 테스트마다 고유 경로를 쓴다. 파일이 병렬로 돌아도 서로의 로그를 안 읽는다 */
export function tempStateDir(): string {
  const dir = join('.gestalt-test', `conductor-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  made.push(dir);
  return dir;
}

export function cleanupStateDirs(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** 시계를 손으로 돌리는 저장소. 시간 순서가 판정에 들어가는 테스트에서 쓴다 */
export function clockedStore(dir = tempStateDir(), start = Date.parse('2026-11-01T00:00:00Z')) {
  let t = start;
  const store = ConductorStore.open(dir, { now: () => new Date(t) });
  return {
    store,
    dir,
    advance(ms: number) {
      t += ms;
    },
    now: () => new Date(t),
  };
}

export function order(over: Partial<Order> = {}): Order {
  const id = over.id ?? `ord-${randomUUID().slice(0, 8)}`;
  return {
    id,
    source: 'spoken',
    sourceRef: `spoken:${id}`,
    repo: 'acme/app',
    title: '작은 버그 고치기',
    scope: 'merge-through',
    skillChain: ['solve', 'ship'],
    status: 'queued',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

export function worker(orderId: string, over: Partial<Worker> = {}): Worker {
  return {
    id: over.id ?? `wrk-${randomUUID().slice(0, 8)}`,
    orderId,
    kind: 'subagent',
    spawnedBy: 'conductor',
    attempt: 1,
    status: 'running',
    startedAt: '2026-11-01T00:00:00.000Z',
    lastSeenAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}
