import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS_FILE, MasterStore, SNAPSHOT_FILE, replay } from '../../../src/master/store.js';
import type { Worker } from '../../../src/master/types.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

afterEach(cleanupStateDirs);

describe('MasterStore', () => {
  it('새 프로세스가 로그만 읽어 주문, 워커, 체크포인트, 게이트를 같게 복원한다', () => {
    const dir = tempStateDir();
    const a = MasterStore.open(dir);
    const o1 = order({ id: 'ord-1' });
    const o2 = order({ id: 'ord-2', repo: 'acme/web', createdAt: '2026-11-01T00:01:00.000Z' });
    a.addOrder(o1);
    a.addOrder(o2);
    a.updateOrder('ord-1', { status: 'running', workerId: 'wrk-1' });
    a.startWorker(worker('ord-1', { id: 'wrk-1' }));
    a.saveCheckpoint({
      orderId: 'ord-1',
      workerId: 'wrk-1',
      skill: 'ship',
      phase: '2',
      round: 1,
      next: '로컬 리뷰 2라운드',
      completedSkills: ['solve'],
      refs: ['.ship/checkpoint.json'],
      savedAt: a.timestamp(),
    });
    a.openGate({
      id: 'gate-1',
      orderId: 'ord-2',
      type: 'merge',
      status: 'open',
      reason: '머지 승인',
      refs: [],
      openedAt: a.timestamp(),
    });

    const b = MasterStore.open(dir);
    expect(b.snapshot.orders).toEqual(a.snapshot.orders);
    expect(b.snapshot.workers).toEqual(a.snapshot.workers);
    expect(b.snapshot.checkpoints['ord-1']?.phase).toBe('2');
    expect(b.openGates().map((g) => g.id)).toEqual(['gate-1']);
    expect(b.queuedOrders().map((o) => o.id)).toEqual(['ord-2']);
    expect(b.activeWorkers().map((w) => w.id)).toEqual(['wrk-1']);
    expect(b.worker('wrk-1')?.spawnedBy).toBe('master');
  });

  it('스냅샷 파일은 로그와 같은 내용을 담는다', () => {
    const dir = tempStateDir();
    const s = MasterStore.open(dir);
    s.addOrder(order({ id: 'ord-1' }));
    const snap = JSON.parse(readFileSync(join(dir, SNAPSHOT_FILE), 'utf-8'));
    expect(snap).toEqual(replay(join(dir, EVENTS_FILE)));
  });

  it('마스터가 아닌 쪽이 띄운 워커는 기록하지 않는다', () => {
    const s = MasterStore.open(tempStateDir());
    s.addOrder(order({ id: 'ord-1' }));
    const w = { ...worker('ord-1'), spawnedBy: 'worker' } as unknown as Worker;
    expect(() => s.startWorker(w)).toThrow(/마스터만/);
    expect(s.workers()).toEqual([]);
  });

  it('모르는 주문이나 닫힌 게이트를 건드리면 거절한다', () => {
    const s = MasterStore.open(tempStateDir());
    expect(() => s.updateOrder('ord-x', { status: 'done' })).toThrow(/모르는 주문/);
    expect(() => s.startWorker(worker('ord-x'))).toThrow(/모르는 주문/);
    s.openGate({
      id: 'gate-1',
      type: 'slack-post',
      status: 'open',
      reason: '',
      refs: [],
      openedAt: s.timestamp(),
    });
    s.append({ type: 'gate-resolved', at: s.timestamp(), gateId: 'gate-1', decision: 'approved' });
    expect(() =>
      s.append({
        type: 'gate-resolved',
        at: s.timestamp(),
        gateId: 'gate-1',
        decision: 'approved',
      }),
    ).toThrow(/이미 닫힌/);
  });

  it('append 도중 끊겨 반쯤 쓴 마지막 줄은 버리고 복원한다', () => {
    const dir = tempStateDir();
    const s = MasterStore.open(dir);
    s.addOrder(order({ id: 'ord-1' }));
    appendFileSync(join(dir, EVENTS_FILE), '{"type":"order-ad');
    expect(
      MasterStore.open(dir)
        .orders()
        .map((o) => o.id),
    ).toEqual(['ord-1']);
  });

  it('중간 줄이 깨졌으면 복원하지 않고 멈춘다', () => {
    const dir = tempStateDir();
    writeFileSync(
      join(dir, EVENTS_FILE),
      `{broken\n${JSON.stringify({ type: 'tick', at: 'x' })}\n${JSON.stringify({ type: 'tick', at: 'y' })}\n`,
    );
    expect(() => MasterStore.open(dir)).toThrow(/깨졌어요/);
  });

  it('reload는 다른 프로세스가 덧붙인 이벤트까지 읽는다', () => {
    const dir = tempStateDir();
    const master = MasterStore.open(dir);
    master.addOrder(order({ id: 'ord-1' }));
    const other = MasterStore.open(dir);
    other.updateOrder('ord-1', { status: 'running' });
    expect(master.order('ord-1')?.status).toBe('queued');
    master.reload();
    expect(master.order('ord-1')?.status).toBe('running');
  });
});
