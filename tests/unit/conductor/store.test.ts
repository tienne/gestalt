import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVENTS_FILE,
  ConductorStore,
  SNAPSHOT_FILE,
  replay,
} from '../../../src/conductor/store.js';
import type { Worker } from '../../../src/conductor/types.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

afterEach(cleanupStateDirs);

describe('ConductorStore', () => {
  it('새 프로세스가 로그만 읽어 주문, 워커, 체크포인트, 게이트를 같게 복원한다', () => {
    const dir = tempStateDir();
    const a = ConductorStore.open(dir);
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

    const b = ConductorStore.open(dir);
    expect(b.snapshot.orders).toEqual(a.snapshot.orders);
    expect(b.snapshot.workers).toEqual(a.snapshot.workers);
    expect(b.snapshot.checkpoints['ord-1']?.phase).toBe('2');
    expect(b.openGates().map((g) => g.id)).toEqual(['gate-1']);
    expect(b.queuedOrders().map((o) => o.id)).toEqual(['ord-2']);
    expect(b.activeWorkers().map((w) => w.id)).toEqual(['wrk-1']);
    expect(b.worker('wrk-1')?.spawnedBy).toBe('conductor');
  });

  it('스냅샷 파일은 로그와 같은 내용을 담는다', () => {
    const dir = tempStateDir();
    const s = ConductorStore.open(dir);
    s.addOrder(order({ id: 'ord-1' }));
    const snap = JSON.parse(readFileSync(join(dir, SNAPSHOT_FILE), 'utf-8'));
    expect(snap).toEqual(replay(join(dir, EVENTS_FILE)));
  });

  it('컨덕터가 아닌 쪽이 띄운 워커는 기록하지 않는다', () => {
    const s = ConductorStore.open(tempStateDir());
    s.addOrder(order({ id: 'ord-1' }));
    const w = { ...worker('ord-1'), spawnedBy: 'worker' } as unknown as Worker;
    expect(() => s.startWorker(w)).toThrow(/컨덕터만/);
    expect(s.workers()).toEqual([]);
  });

  it('모르는 주문이나 종료된 게이트를 건드리면 거절한다', () => {
    const s = ConductorStore.open(tempStateDir());
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
    ).toThrow(/이미 종료된/);
  });

  it('append 도중 끊겨 반쯤 쓴 마지막 줄은 버리고 복원한다', () => {
    const dir = tempStateDir();
    const s = ConductorStore.open(dir);
    s.addOrder(order({ id: 'ord-1' }));
    appendFileSync(join(dir, EVENTS_FILE), '{"type":"order-ad');
    expect(
      ConductorStore.open(dir)
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
    expect(() => ConductorStore.open(dir)).toThrow(/깨졌어요/);
  });

  it('reload는 다른 프로세스가 덧붙인 이벤트까지 읽는다', () => {
    const dir = tempStateDir();
    const conductor = ConductorStore.open(dir);
    conductor.addOrder(order({ id: 'ord-1' }));
    const other = ConductorStore.open(dir);
    other.updateOrder('ord-1', { status: 'running' });
    expect(conductor.order('ord-1')?.status).toBe('queued');
    conductor.reload();
    expect(conductor.order('ord-1')?.status).toBe('running');
  });

  it('깨진 꼬리 뒤에 덧붙여도 새 이벤트를 잃지 않고 다시 열 수 있다', () => {
    const dir = tempStateDir();
    const s = ConductorStore.open(dir);
    s.addOrder(order({ id: 'ord-1' }));
    appendFileSync(join(dir, EVENTS_FILE), '{"type":"order-ad');

    const after = ConductorStore.open(dir);
    after.addOrder(order({ id: 'ord-2' }));
    after.addOrder(order({ id: 'ord-3' }));

    const reopened = ConductorStore.open(dir);
    expect(
      reopened
        .orders()
        .map((o) => o.id)
        .sort(),
    ).toEqual(['ord-1', 'ord-2', 'ord-3']);
    expect(reopened.snapshot.eventCount).toBe(after.snapshot.eventCount);
  });

  it('deferSnapshot 안에서는 사본을 끝에 한 번만 쓴다', async () => {
    const dir = tempStateDir();
    const s = ConductorStore.open(dir);
    await s.deferSnapshot(async () => {
      s.addOrder(order({ id: 'ord-1' }));
      expect(existsSync(join(dir, SNAPSHOT_FILE))).toBe(false);
    });
    const snap = JSON.parse(readFileSync(join(dir, SNAPSHOT_FILE), 'utf-8'));
    expect(snap).toEqual(replay(join(dir, EVENTS_FILE)));
  });

  it('두 프로세스가 동시에 덧붙여도 모든 줄이 온전하다', async () => {
    const dir = resolve(tempStateDir());
    ConductorStore.open(dir);
    const storeUrl = pathToFileURL(resolve('src/conductor/store.ts')).href;
    const perChild = 300;
    // 줄이 길수록 write가 쪼개질 여지가 커서 일부러 길게 채운다
    const code = `
      const { ConductorStore } = await import(${JSON.stringify(storeUrl)});
      const s = ConductorStore.open(process.argv[1]);
      const pad = process.argv[2].repeat(2000);
      for (let i = 0; i < ${perChild}; i++) {
        s.append({ type: 'tick', at: process.argv[2] + '-' + i + '-' + pad });
      }
    `;
    const run = (tag: string) =>
      new Promise<void>((done, fail) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', code, dir, tag],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let err = '';
        child.stderr.on('data', (b: Buffer) => (err += b.toString()));
        child.on('error', fail);
        child.on('exit', (c) => (c === 0 ? done() : fail(new Error(`exit ${c}: ${err}`))));
      });
    await Promise.all([run('a'), run('b')]);

    const lines = readFileSync(join(dir, EVENTS_FILE), 'utf-8').split('\n').filter(Boolean);
    const events = lines.map((line) => JSON.parse(line) as { type: string });
    // 한쪽이 쓰는 도중에 다른 쪽이 파일 끝을 읽으면 꼬리가 끊긴 줄로 보여 tail-repaired가
    // 끼어들 수 있다. 줄은 안 깨지므로 tick 줄 수만 맞으면 된다
    expect(events.filter((e) => e.type === 'tick')).toHaveLength(perChild * 2);
    expect(events.every((e) => e.type === 'tick' || e.type === 'tail-repaired')).toBe(true);
    expect(ConductorStore.open(dir).snapshot.ticks).toBe(perChild * 2);
  }, 30_000);
});
