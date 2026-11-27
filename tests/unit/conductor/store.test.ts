import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { foldEvents } from '../../../src/conductor/fold.js';
import { resolveGate } from '../../../src/conductor/gates.js';
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

  it('append는 스냅샷을 쓰지 않고 명시적으로 쓸 때만 압축된 사본을 남긴다', () => {
    const dir = tempStateDir();
    const s = ConductorStore.open(dir);
    s.addOrder(order({ id: 'ord-1' }));
    const path = join(dir, SNAPSHOT_FILE);
    expect(existsSync(path)).toBe(false);
    expect(ConductorStore.open(dir).order('ord-1')).toBeDefined();

    s.flushSnapshot();
    const raw = readFileSync(path, 'utf-8');
    expect(raw).toBe(JSON.stringify(replay(join(dir, EVENTS_FILE))));

    s.addOrder(order({ id: 'ord-2' }));
    expect(readFileSync(path, 'utf-8')).toBe(raw);
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

  it('이전 WebAuthn 결정도 재생한 뒤 전달 대기를 처리할 수 있다', () => {
    const dir = tempStateDir();
    const a = ConductorStore.open(dir);
    expect(() =>
      a.append({ type: 'gate-delivery', at: a.timestamp(), gateId: 'gate-x', pending: true }),
    ).toThrow(/모르는 게이트/);
    a.openGate({
      id: 'gate-1',
      type: 'merge',
      status: 'open',
      reason: '',
      refs: [],
      openedAt: a.timestamp(),
    });
    const decisionVia = {
      kind: 'webauthn' as const,
      credentialId: 'legacy-credential',
      signCount: 3,
    };
    a.append({
      type: 'gate-resolved',
      at: a.timestamp(),
      gateId: 'gate-1',
      decision: 'approved',
      decisionVia,
    });
    a.append({ type: 'gate-delivery', at: a.timestamp(), gateId: 'gate-1', pending: true });
    const reopened = ConductorStore.open(dir);
    expect(reopened.snapshot.gates['gate-1']).toMatchObject({
      status: 'resolved',
      decision: 'approved',
      decisionVia,
      deliveryPending: true,
    });
    reopened.append({ type: 'gate-delivery', at: a.timestamp(), gateId: 'gate-1', pending: false });
    const delivered = ConductorStore.open(dir).snapshot.gates['gate-1'];
    expect(delivered).not.toHaveProperty('deliveryPending');
    expect(delivered).toMatchObject({ decision: 'approved', decisionVia });
  });

  it.each([true, false])(
    '승인 기록과 배포 범위가 완료·전달 이벤트 순서와 상관없이 복원된다',
    async (completeFirst) => {
      const dir = tempStateDir();
      const store = ConductorStore.open(dir);
      const at = store.timestamp();
      const gateId = 'gate-fixture';
      const receipt = {
        id: 'decision-fixture',
        deliveryId: 'transfer-fixture',
        target: 'target-fixture',
        repo: 'acme/app',
      };
      const approvedDeployment = {
        repo: 'acme/app',
        ref: 'main',
        sha: 'a'.repeat(40),
        environment: 'stage',
        runId: 12,
        attempt: 1,
        deploymentId: 13,
      };
      store.openGate({
        id: gateId,
        type: 'no-procedure',
        status: 'open',
        reason: '',
        refs: [],
        openedAt: at,
      });
      resolveGate(store, gateId, 'approved', undefined, {
        receipt,
        approvedDeployment,
        deliveryPending: true,
      });
      const complete = () =>
        store.append({
          type: 'gate-completed',
          at,
          gateId,
          evidence: {
            kind: 'github-deployment',
            target: approvedDeployment,
            statusId: 15,
            jobId: 14,
          },
        });
      const deliver = () =>
        store.append({ type: 'gate-delivery', at, gateId, pending: false, outcome: 'delivered' });
      if (completeFirst) {
        complete();
        deliver();
      } else {
        deliver();
        complete();
      }
      const expected = {
        receipt,
        approvedDeployment,
        completion: { at },
        deliveryOutcome: 'delivered',
      };
      expect(ConductorStore.open(dir).snapshot.gates[gateId]).toMatchObject(expected);
      await expect(foldEvents(dir, { settleMs: 0 })).resolves.toMatchObject({ status: 'folded' });
      expect(ConductorStore.open(dir).snapshot.gates[gateId]).toMatchObject(expected);
    },
  );

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

  it('끝난 주문을 지우면 그 주문에 딸린 기록까지 빠지고 다시 열어도 같다', () => {
    const dir = tempStateDir();
    const a = ConductorStore.open(dir);
    a.addOrder(order({ id: 'ord-1', sourceRef: 'jira:APP-1', parentOrderId: 'ord-0' }));
    a.addOrder(order({ id: 'ord-2' }));
    a.startWorker(worker('ord-1', { id: 'wrk-1', status: 'finished' }));
    a.openGate({
      id: 'gate-1',
      orderId: 'ord-1',
      type: 'merge',
      reason: '머지할까요?',
      refs: [],
      status: 'open',
      openedAt: a.timestamp(),
    });
    a.append({
      type: 'bypass',
      at: a.timestamp(),
      record: { orderId: 'ord-1', need: 'cleanup', action: '수동 정리', at: a.timestamp() },
    });
    a.saveCheckpoint({
      orderId: 'ord-1',
      workerId: 'wrk-1',
      skill: 'ship',
      phase: '5',
      round: 1,
      next: '끝',
      completedSkills: ['ship'],
      refs: [],
      savedAt: a.timestamp(),
    });
    a.append({
      type: 'jira-transition',
      at: a.timestamp(),
      record: { orderId: 'ord-1', issueKey: 'APP-1', to: 'Done', at: a.timestamp() },
    });
    a.append({
      type: 'report-applied',
      at: a.timestamp(),
      name: 'r-1.json',
      report: { workerId: 'wrk-1', status: 'done', summary: '머지함', refs: [] },
    });
    expect(a.snapshot.reports['ord-1']).toHaveLength(1);

    expect(() => a.removeOrder('ord-1')).toThrow(/끝난 주문만/);
    a.updateOrder('ord-1', { status: 'done' });
    expect(() => a.removeOrder('ord-1')).toThrow(/열린 게이트/);
    a.append({ type: 'gate-resolved', at: a.timestamp(), gateId: 'gate-1', decision: 'approved' });
    a.removeOrder('ord-1');
    expect(() => a.removeOrder('ord-1')).toThrow(/모르는 주문/);

    for (const s of [a.snapshot, ConductorStore.open(dir).snapshot]) {
      expect(Object.keys(s.orders)).toEqual(['ord-2']);
      expect(s.workers).toEqual({});
      expect(s.gates).toEqual({});
      expect(s.bypasses).toEqual([]);
      expect(s.checkpoints).toEqual({});
      expect(s.jiraTransitions).toEqual([]);
      expect(s.reports).toEqual({});
      expect(s.removedOrders['ord-1']).toMatchObject({
        sourceRef: 'jira:APP-1',
        parentOrderId: 'ord-0',
      });
    }
    expect(a.hasSourceRef('jira:APP-1')).toBe(true);
    expect(a.findOrderBySourceRef('jira:APP-1')).toBeUndefined();
  });

  it('도는 워커가 남은 주문은 끝난 상태여도 못 지운다', () => {
    const a = ConductorStore.open(tempStateDir());
    a.addOrder(order({ id: 'ord-1', status: 'failed' }));
    a.startWorker(worker('ord-1', { id: 'wrk-1', status: 'running' }));
    expect(() => a.removeOrder('ord-1')).toThrow(/도는 워커/);
  });

  it('멈춘 워커가 남은 주문은 워크트리 가드를 지키려고 못 지운다', () => {
    const a = ConductorStore.open(tempStateDir());
    a.addOrder(order({ id: 'ord-1', status: 'cancelled' }));
    a.startWorker(worker('ord-1', { id: 'wrk-1', status: 'stopped' }));
    expect(() => a.removeOrder('ord-1')).toThrow(/멈춘 워커/);
    expect(a.worker('wrk-1')).toBeDefined();
  });

  it('지우기와 경합해 게이트가 먼저 열린 로그는 재생할 때 지우기를 무시한다', () => {
    const dir = tempStateDir();
    const a = ConductorStore.open(dir);
    a.addOrder(order({ id: 'ord-1', status: 'done' }));
    // 다른 프로세스가 잠금 없이 게이트를 연 뒤 지우기가 낡은 상태로 덧붙인 꼴을 그대로 적는다
    const at = a.timestamp();
    appendFileSync(
      join(dir, EVENTS_FILE),
      `${JSON.stringify({
        type: 'gate-opened',
        at,
        gate: {
          id: 'gate-1',
          orderId: 'ord-1',
          type: 'merge',
          reason: '머지할까요?',
          refs: [],
          status: 'open',
          openedAt: at,
        },
      })}\n${JSON.stringify({ type: 'order-removed', at, orderId: 'ord-1' })}\n`,
    );
    const s = ConductorStore.open(dir).snapshot;
    expect(s.orders['ord-1']).toBeDefined();
    expect(s.gates['gate-1']).toBeDefined();
    expect(s.removedOrders).toEqual({});
  });

  it('지운 출처 색인은 새로 지운 주문과 다시 읽은 로그를 따라간다', () => {
    const dir = tempStateDir();
    const a = ConductorStore.open(dir);
    a.addOrder(order({ id: 'ord-1', status: 'done', sourceRef: 'jira:APP-1' }));
    a.addOrder(order({ id: 'ord-2', status: 'done', sourceRef: 'jira:APP-2' }));
    expect(a.removedAtOf('jira:APP-1')).toBeUndefined();
    a.removeOrder('ord-1');
    expect(a.removedAtOf('jira:APP-1')).toBeDefined();
    const b = ConductorStore.open(dir);
    b.removeOrder('ord-2');
    a.reload();
    expect(a.removedAtOf('jira:APP-2')).toBeDefined();
  });
});

describe('주문 id 조회 인덱스', () => {
  it('이벤트를 붙이면 workersOf와 openGates, askedSourceRef가 바로 따라온다', () => {
    const s = ConductorStore.open(tempStateDir());
    s.addOrder(order({ id: 'ord-1' }));
    expect(s.workersOf('ord-1')).toEqual([]);
    s.startWorker(worker('ord-1', { id: 'wrk-2', attempt: 2 }));
    s.startWorker(worker('ord-1', { id: 'wrk-1', attempt: 1 }));
    expect(s.workersOf('ord-1').map((w) => w.id)).toEqual(['wrk-1', 'wrk-2']);
    s.updateWorker('wrk-1', { status: 'released' });
    expect(s.workersOf('ord-1')[0]?.status).toBe('released');

    const gate = {
      id: 'gate-1',
      orderId: 'ord-1',
      type: 'merge' as const,
      status: 'open' as const,
      reason: '확인',
      refs: [],
      payload: { sourceRef: 'pr-watch:a' },
      openedAt: s.timestamp(),
    };
    s.openGate(gate);
    expect(s.openGates('ord-1').map((g) => g.id)).toEqual(['gate-1']);
    expect(s.askedSourceRef('pr-watch:a')).toBe(true);
    s.append({ type: 'gate-resolved', at: s.timestamp(), gateId: 'gate-1', decision: 'approved' });
    expect(s.openGates('ord-1')).toEqual([]);
    expect(s.askedSourceRef('pr-watch:a')).toBe(true);

    s.reload();
    expect(s.workersOf('ord-1').map((w) => w.id)).toEqual(['wrk-1', 'wrk-2']);
  });
});
