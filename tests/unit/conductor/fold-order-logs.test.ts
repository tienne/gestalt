import * as fs from 'node:fs';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORDER_LOGS_DIR, foldEvents, orderLogPath } from '../../../src/conductor/fold.js';
import { ConductorStore, replayStore } from '../../../src/conductor/store.js';
import { cleanupStateDirs, order, tempStateDir } from './fixtures.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

afterEach(cleanupStateDirs);

const fast = { settleMs: 5 };

function lines(dir: string, id: string): string[] {
  return readFileSync(orderLogPath(dir, id), 'utf-8').trim().split('\n');
}

function addOrders(dir: string, n: number, prefix: string): void {
  const s = ConductorStore.open(dir);
  for (let i = 0; i < n; i++) s.addOrder(order({ id: `${prefix}-${i}` }));
}

describe('주문별 로그', () => {
  it('주문마다 파일 하나에 반영 순서대로 덧붙인다', async () => {
    const dir = tempStateDir();
    const s = ConductorStore.open(dir);
    s.addOrder(order({ id: 'ord-1' }));
    await foldEvents(dir, fast);
    ConductorStore.open(dir).updateOrder('ord-1', { status: 'running' });
    await foldEvents(dir, fast);

    expect(readdirSync(join(dir, ORDER_LOGS_DIR)).filter((n) => !n.startsWith('.'))).toEqual([
      'ord-1.jsonl',
    ]);
    expect(lines(dir, 'ord-1').map((l) => (JSON.parse(l) as { type: string }).type)).toEqual([
      'order-added',
      'order-updated',
    ]);
  });

  it('덧붙이고 base.json을 쓰기 전에 죽으면 다음 반영이 덧붙인 줄을 걷고 한 번만 남긴다', async () => {
    const dir = tempStateDir();
    ConductorStore.open(dir).addOrder(order({ id: 'ord-1' }));
    await foldEvents(dir, fast);
    ConductorStore.open(dir).updateOrder('ord-1', { status: 'running' });
    const before = replayStore(dir);

    await expect(
      foldEvents(dir, {
        ...fast,
        beforeWrite: () => {
          throw new Error('죽음');
        },
      }),
    ).rejects.toThrow('죽음');
    expect(lines(dir, 'ord-1')).toHaveLength(2);

    await foldEvents(dir, fast);

    expect(lines(dir, 'ord-1')).toHaveLength(2);
    expect(replayStore(dir)).toEqual(before);
    // 되돌린 뒤 다음 반영이 반영된 줄을 걷지 않는다
    ConductorStore.open(dir).updateOrder('ord-1', { status: 'done' });
    await foldEvents(dir, fast);
    await foldEvents(dir, fast);
    expect(lines(dir, 'ord-1')).toHaveLength(3);
  });

  it('첫 반영이 새 파일에 덧붙이고 죽으면 다음 반영이 파일을 지웠다가 다시 쓴다', async () => {
    const dir = tempStateDir();
    ConductorStore.open(dir).addOrder(order({ id: 'ord-1' }));

    await expect(
      foldEvents(dir, {
        ...fast,
        beforeWrite: () => {
          throw new Error('죽음');
        },
      }),
    ).rejects.toThrow('죽음');
    expect(lines(dir, 'ord-1')).toHaveLength(1);

    await foldEvents(dir, fast);

    expect(lines(dir, 'ord-1').map((l) => (JSON.parse(l) as { type: string }).type)).toEqual([
      'order-added',
    ]);
  });

  it('덧붙이기 전에 파일 끝의 반쪽 줄을 잘라 낸다', async () => {
    const dir = tempStateDir();
    ConductorStore.open(dir).addOrder(order({ id: 'ord-1' }));
    await foldEvents(dir, fast);
    writeFileSync(orderLogPath(dir, 'ord-1'), '{"type":"order-up', { flag: 'a' });
    ConductorStore.open(dir).updateOrder('ord-1', { status: 'running' });

    await foldEvents(dir, fast);

    expect(lines(dir, 'ord-1').map((l) => (JSON.parse(l) as { type: string }).type)).toEqual([
      'order-added',
      'order-updated',
    ]);
  });

  it('반영 한 번의 fsync는 줄이 닿은 주문 하나에 한 번씩 는다', async () => {
    const count = async (n: number) => {
      const dir = tempStateDir();
      addOrders(dir, 1, 'ord-seed');
      await foldEvents(dir, fast);
      addOrders(dir, n, 'ord-x');
      const fsync = vi.mocked(fs.fsyncSync);
      fsync.mockClear();
      await foldEvents(dir, fast);
      return fsync.mock.calls.length;
    };
    const one = await count(1);
    const ten = await count(10);

    expect(ten - one).toBe(9);
    // 떼어 내기 2번, 기록 파일과 그 rename 2번, 새 파일 엔트리 1번, base.json과 그 rename 2번
    expect(one).toBe(1 + 7);
  });
});
