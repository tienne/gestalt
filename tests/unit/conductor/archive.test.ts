import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARCHIVE_DIR, archiveOrders } from '../../../src/conductor/archive.js';
import { acquireLock } from '../../../src/conductor/engine.js';
import { ORDER_LOGS_DIR, foldEvents } from '../../../src/conductor/fold.js';
import { intakeOrder } from '../../../src/conductor/intake.js';
import { pollPrs } from '../../../src/conductor/pr-watch.js';
import { REFS_DIR } from '../../../src/conductor/ref-copy.js';
import { loadResults, resolveOrderId } from '../../../src/conductor/results.js';
import {
  BASE_FILE,
  ConductorStore,
  EVENTS_FILE,
  listSegments,
  readBase,
} from '../../../src/conductor/store.js';
import type { ConductorSnapshot } from '../../../src/conductor/types.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

afterEach(cleanupStateDirs);

const NOW = new Date('2026-11-20T00:00:00.000Z');
const fast = { settleMs: 5, now: () => NOW };

/** 11/1에 끝난 주문 하나(ord-old)와 11/19에 끝난 주문 하나(ord-new). 앞 주문에는 워커와 refs 사본, 보고가 있다 */
function seed(dir: string): ConductorStore {
  const s = ConductorStore.open(dir, { now: () => new Date('2026-11-01T00:00:00.000Z') });
  s.addOrder(order({ id: 'ord-old', sourceRef: 'jira:APP-1' }));
  s.addOrder(order({ id: 'ord-new', sourceRef: 'jira:APP-2' }));
  s.startWorker(worker('ord-old', { id: 'wrk-1' }));
  s.saveCheckpoint({
    orderId: 'ord-old',
    workerId: 'wrk-1',
    skill: 'ship',
    next: 'Phase 3',
    completedSkills: ['solve'],
    refs: [],
    savedAt: s.timestamp(),
  });
  const copy = join(REFS_DIR, 'ord-old', 'result.md');
  mkdirSync(join(dir, REFS_DIR, 'ord-old'), { recursive: true });
  writeFileSync(join(dir, copy), '# 결과\n');
  s.append({
    type: 'report-applied',
    at: s.timestamp(),
    name: 'r1.json',
    report: {
      workerId: 'wrk-1',
      status: 'done',
      summary: '머지했어요',
      refs: ['/tmp/result.md'],
      refCopies: [{ ref: '/tmp/result.md', path: copy }],
    },
  });
  s.updateWorker('wrk-1', { status: 'finished' });
  s.updateOrder('ord-old', { status: 'done' });
  s.append({ type: 'tick', at: s.timestamp() });
  return s;
}

function finishNew(dir: string): void {
  const s = ConductorStore.open(dir, { now: () => new Date('2026-11-19T00:00:00.000Z') });
  s.updateOrder('ord-new', { status: 'done' });
}

function withoutArchived(s: ConductorSnapshot): ConductorSnapshot {
  return { ...s, archivedOrders: {} };
}

describe('archiveOrders', () => {
  it('끝나고 14일 지난 주문을 옮기고 상태에서 뺀다', async () => {
    const dir = tempStateDir();
    seed(dir);
    finishNew(dir);

    const result = await archiveOrders(dir, fast);

    expect(result).toMatchObject({
      status: 'archived',
      orders: [{ id: 'ord-old', month: '2026-11', status: 'done' }],
      blocked: [],
    });
    const target = join(dir, ARCHIVE_DIR, '2026-11', 'ord-old');
    const events = readFileSync(join(target, 'events.jsonl'), 'utf-8').trim().split('\n');
    expect(events.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual([
      'order-added',
      'worker-started',
      'checkpoint-saved',
      'report-applied',
      'worker-updated',
      'order-updated',
    ]);
    const shown = JSON.parse(readFileSync(join(target, 'order.json'), 'utf-8'));
    expect(shown.order.id).toBe('ord-old');
    expect(shown.workers.map((w: { id: string }) => w.id)).toEqual(['wrk-1']);
    expect(shown.refs).toEqual(['/tmp/result.md']);
    expect(shown.reports[0].refCopies[0].path).toBe(
      join(ARCHIVE_DIR, '2026-11', 'ord-old', REFS_DIR, 'result.md'),
    );
    expect(readFileSync(join(target, REFS_DIR, 'result.md'), 'utf-8')).toBe('# 결과\n');
    // 이벤트 줄의 사본 경로는 원래 값 그대로다
    expect(events[3]).toContain(join(REFS_DIR, 'ord-old', 'result.md'));

    const after = ConductorStore.open(dir).snapshot;
    expect(after.orders['ord-old']).toBeUndefined();
    expect(after.workers['wrk-1']).toBeUndefined();
    expect(after.checkpoints['ord-old']).toBeUndefined();
    expect(after.reports['ord-old']).toBeUndefined();
    expect(after.orders['ord-new']?.status).toBe('done');
    expect(after.archivedOrders['ord-old']).toEqual({
      sourceRef: 'jira:APP-1',
      archivedAt: NOW.toISOString(),
      month: '2026-11',
    });
    expect(existsSync(join(dir, REFS_DIR, 'ord-old'))).toBe(false);
    expect(existsSync(join(dir, ORDER_LOGS_DIR, 'ord-old'))).toBe(false);
    expect(existsSync(join(dir, ORDER_LOGS_DIR, 'ord-new'))).toBe(true);
  });

  it('반영한 segment가 지워진 뒤에 옮겨도 앞쪽 이벤트가 보관소에 남는다', async () => {
    const dir = tempStateDir();
    seed(dir);
    finishNew(dir);
    // ord-new는 아직 14일이 안 지났다. 반영을 두 번 돌면 첫 segment가 지워진다
    await archiveOrders(dir, fast);
    const first = listSegments(dir);
    ConductorStore.open(dir).append({ type: 'tick', at: NOW.toISOString() });
    await foldEvents(dir, fast);
    expect(listSegments(dir).some((n) => first.includes(n))).toBe(false);

    const later = new Date('2026-12-10T00:00:00.000Z');
    const result = await archiveOrders(dir, { settleMs: 5, now: () => later });

    expect(result).toMatchObject({ orders: [{ id: 'ord-new', month: '2026-11' }] });
    const events = readFileSync(
      join(dir, ARCHIVE_DIR, '2026-11', 'ord-new', 'events.jsonl'),
      'utf-8',
    );
    expect(
      events
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).type),
    ).toEqual(['order-added', 'order-updated']);
  });

  it('보관한 뒤 다시 열면 보관 전 상태에서 그 주문만 빠진 상태가 나온다', async () => {
    const dir = tempStateDir();
    seed(dir);
    finishNew(dir);
    const before = ConductorStore.open(dir).snapshot;

    await archiveOrders(dir, { ...fast, days: 0 });

    const after = ConductorStore.open(dir).snapshot;
    expect(Object.keys(after.archivedOrders).sort()).toEqual(['ord-new', 'ord-old']);
    const expected = structuredClone(before);
    for (const id of ['ord-new', 'ord-old']) delete expected.orders[id];
    delete expected.workers['wrk-1'];
    delete expected.checkpoints['ord-old'];
    delete expected.reports['ord-old'];
    expect(withoutArchived(after)).toEqual(expected);
  });

  it('열린 게이트나 멈춘 워커가 남은 주문은 옮기지 않고 이유를 준다', async () => {
    const dir = tempStateDir();
    const s = ConductorStore.open(dir, { now: () => new Date('2026-11-01T00:00:00.000Z') });
    s.addOrder(order({ id: 'ord-gate' }));
    s.openGate({
      id: 'gate-1',
      orderId: 'ord-gate',
      type: 'merge',
      status: 'open',
      reason: '머지 승인',
      refs: [],
      openedAt: s.timestamp(),
    });
    s.updateOrder('ord-gate', { status: 'failed' });
    s.addOrder(order({ id: 'ord-stopped' }));
    s.startWorker(worker('ord-stopped', { id: 'wrk-s', status: 'stopped' }));
    s.updateOrder('ord-stopped', { status: 'cancelled' });

    const result = await archiveOrders(dir, fast);

    expect(result).toMatchObject({ status: 'archived', orders: [] });
    if (result.status !== 'archived') throw new Error('unreachable');
    expect(result.blocked.map((b) => b.id)).toEqual(['ord-gate', 'ord-stopped']);
    expect(result.blocked[0]!.reason).toContain('열린 게이트');
    expect(ConductorStore.open(dir).order('ord-gate')).toBeDefined();
  });

  it('dry-run은 아무것도 안 바꾸고 옮길 주문만 준다', async () => {
    const dir = tempStateDir();
    seed(dir);
    const events = readFileSync(join(dir, EVENTS_FILE), 'utf-8');

    const result = await archiveOrders(dir, { ...fast, dryRun: true });

    expect(result).toMatchObject({ status: 'dry-run', orders: [{ id: 'ord-old' }] });
    expect(readFileSync(join(dir, EVENTS_FILE), 'utf-8')).toBe(events);
    expect(existsSync(join(dir, BASE_FILE))).toBe(false);
    expect(existsSync(join(dir, ARCHIVE_DIR))).toBe(false);
  });

  it('잠금을 못 잡으면 넘긴다', async () => {
    const dir = tempStateDir();
    seed(dir);
    const lock = acquireLock(dir);
    try {
      expect((await archiveOrders(dir, fast)).status).toBe('locked');
    } finally {
      if (lock.ok) lock.release();
    }
  });

  it('지운 주문은 기간이 지나면 모아 둔 이벤트만 옮기고 지운 기록은 남긴다', async () => {
    const dir = tempStateDir();
    seed(dir);
    const s = ConductorStore.open(dir, { now: () => new Date('2026-11-02T00:00:00.000Z') });
    s.removeOrder('ord-old');
    await foldEvents(dir, fast);
    expect(existsSync(join(dir, ORDER_LOGS_DIR, 'ord-old'))).toBe(true);

    const result = await archiveOrders(dir, fast);

    expect(result).toMatchObject({ removed: [{ id: 'ord-old', month: '2026-11' }] });
    const events = readFileSync(
      join(dir, ARCHIVE_DIR, '2026-11', 'ord-old', 'events.jsonl'),
      'utf-8',
    );
    expect(events.trim().split('\n').at(-1)).toContain('"order-removed"');
    expect(existsSync(join(dir, ORDER_LOGS_DIR, 'ord-old'))).toBe(false);
    expect(ConductorStore.open(dir).snapshot.removedOrders['ord-old']).toBeDefined();
  });

  it('base.json을 쓰고 죽어 남은 모아 둔 이벤트와 사본은 다음 보관이 지운다', async () => {
    const dir = tempStateDir();
    seed(dir);
    await archiveOrders(dir, fast);
    // 지우기 전에 죽은 자리를 흉내 낸다
    mkdirSync(join(dir, ORDER_LOGS_DIR, 'ord-old'), { recursive: true });
    writeFileSync(join(dir, ORDER_LOGS_DIR, 'ord-old', 'x.jsonl'), '{}\n');
    mkdirSync(join(dir, REFS_DIR, 'ord-old'), { recursive: true });

    await archiveOrders(dir, fast);

    expect(existsSync(join(dir, ORDER_LOGS_DIR, 'ord-old'))).toBe(false);
    expect(existsSync(join(dir, REFS_DIR, 'ord-old'))).toBe(false);
    // 보관 파일은 그대로다
    expect(readdirSync(join(dir, ARCHIVE_DIR, '2026-11', 'ord-old')).sort()).toEqual([
      'events.jsonl',
      'order.json',
      'refs',
    ]);
  });

  it('보관 칸이 없는 옛 base.json도 읽는다', async () => {
    const dir = tempStateDir();
    seed(dir);
    await foldEvents(dir, fast);
    const base = JSON.parse(readFileSync(join(dir, BASE_FILE), 'utf-8'));
    delete base.state.archivedOrders;
    writeFileSync(join(dir, BASE_FILE), JSON.stringify(base));

    expect(readBase(dir)?.state.archivedOrders).toEqual({});
    expect(ConductorStore.open(dir).snapshot.archivedOrders).toEqual({});
  });
});

describe('보관한 주문의 중복 판정', () => {
  async function archived(over: Parameters<typeof order>[0]): Promise<string> {
    const dir = tempStateDir();
    const s = ConductorStore.open(dir, { now: () => new Date('2026-11-01T00:00:00.000Z') });
    s.addOrder(order({ id: 'ord-a', status: 'done', ...over }));
    await archiveOrders(dir, fast);
    return dir;
  }

  it('같은 출처를 다시 받지 않는다', async () => {
    const dir = await archived({ sourceRef: 'jira:APP-9' });
    const store = ConductorStore.open(dir);

    const out = intakeOrder(
      store,
      { source: 'jira', sourceRef: 'jira:APP-9', repo: 'acme/app', title: '다시' },
      { defaultScope: 'approval' },
    );

    expect(out).toEqual({ created: false, archivedAt: NOW.toISOString() });
    expect(store.hasSourceRef('jira:APP-9')).toBe(true);
  });

  it('하위 주문 상한이 보관한 하위 주문도 센다', async () => {
    const dir = await archived({ parentOrderId: 'ord-p' });
    expect(ConductorStore.open(dir).childOrderCount('ord-p')).toBe(1);
  });

  it('parked로 보관한 주문의 PR로는 PR 감시가 주문을 만들지 않는다', async () => {
    const dir = await archived({ status: 'parked', prRef: 'acme/app#7' });
    const store = ConductorStore.open(dir);
    expect(store.snapshot.archivedOrders['ord-a']?.humanPr).toBe('acme/app#7');

    const result = await pollPrs(
      store,
      {
        authored: async () => [
          {
            ref: 'acme/app#7',
            repo: 'acme/app',
            title: '사람이 넘겨받은 PR',
            headSha: 'abc',
            latestOtherCommentId: 'c1',
          },
        ],
        reviewing: async () => [],
      },
      { defaultScope: 'approval' },
    );

    expect(result.created).toEqual([]);
  });

  it('결과 조회가 보관한 주문을 보관소 자리로 안내한다', async () => {
    const dir = await archived({});
    expect(resolveOrderId(loadResults({ stateDir: dir }), 'ord-a')).toEqual({
      ok: false,
      reason: 'archived',
      month: '2026-11',
      candidates: [],
    });
  });
});
