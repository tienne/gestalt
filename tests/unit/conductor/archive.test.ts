import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARCHIVE_DIR, archiveOrders } from '../../../src/conductor/archive.js';
import { acquireLock } from '../../../src/conductor/engine.js';
import { ORDER_LOGS_DIR, foldEvents, writeDurable } from '../../../src/conductor/fold.js';
import { intakeOrder } from '../../../src/conductor/intake.js';
import { pollPrs } from '../../../src/conductor/pr-watch.js';
import { REFS_DIR } from '../../../src/conductor/ref-copy.js';
import { loadResults, resolveOrderId } from '../../../src/conductor/results.js';
import {
  BASE_FILE,
  ConductorStore,
  EVENTS_FILE,
  emptySnapshot,
  listSegments,
  orderOfEvent,
  readBase,
} from '../../../src/conductor/store.js';
import type { ConductorEvent, ConductorSnapshot, Gate } from '../../../src/conductor/types.js';
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
    expect(result.blocked[0]!.reason).toBe('열린 게이트가 있어서 못 옮겨요: ord-gate');
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
    expect(ConductorStore.open(dir).snapshot.removedOrders['ord-old']).toMatchObject({
      archived: '2026-11',
    });
  });

  it('지운 주문을 옮기다 base.json 전에 죽으면 다시 돌 때 전체 이벤트로 덮어쓴다', async () => {
    const dir = tempStateDir();
    seed(dir);
    const s = ConductorStore.open(dir, { now: () => new Date('2026-11-02T00:00:00.000Z') });
    s.removeOrder('ord-old');
    await foldEvents(dir, fast);
    // 다음 반영이 앞 segment를 지운다. 앞쪽 이벤트는 이제 모아 둔 파일에만 있다
    s.append({ type: 'tick', at: s.timestamp() });
    await foldEvents(dir, fast);
    expect(listSegments(dir)).toHaveLength(1);
    // 보관 파일 일부만 쓰고 base.json을 쓰기 전에 죽은 자리를 흉내 낸다
    const target = join(dir, ARCHIVE_DIR, '2026-11', 'ord-old');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'events.jsonl'), '{"type":"order-removed"}\n');

    await archiveOrders(dir, fast);

    const types = readFileSync(join(target, 'events.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types[0]).toBe('order-added');
    expect(types.at(-1)).toBe('order-removed');
    expect(types).toHaveLength(7);
  });

  it('옮긴 주문에 늦게 온 줄은 보관 파일을 안 바꾸고 상태에도 안 붙는다', async () => {
    const dir = tempStateDir();
    seed(dir);
    const s = ConductorStore.open(dir, { now: () => new Date('2026-11-02T00:00:00.000Z') });
    s.addOrder(order({ id: 'ord-gone', sourceRef: 'jira:APP-3' }));
    s.updateOrder('ord-gone', { status: 'cancelled' });
    s.removeOrder('ord-gone');
    await archiveOrders(dir, fast);
    const oldEvents = join(dir, ARCHIVE_DIR, '2026-11', 'ord-old', 'events.jsonl');
    const goneEvents = join(dir, ARCHIVE_DIR, '2026-11', 'ord-gone', 'events.jsonl');
    const before = [readFileSync(oldEvents, 'utf-8'), readFileSync(goneEvents, 'utf-8')];

    // 보관 전 상태를 들고 있던 다른 프로세스가 늦게 쓴 줄을 흉내 낸다. append는 모르는 주문을 거절한다
    const at = '2026-11-20T00:00:01.000Z';
    const late: ConductorEvent[] = [
      { type: 'worker-started', at, worker: worker('ord-old', { id: 'wrk-late' }) },
      { type: 'gate-opened', at, gate: gate({ id: 'gate-late', orderId: 'ord-gone' }) },
      { type: 'order-updated', at, orderId: 'ord-gone', patch: { status: 'done' } },
    ];
    appendFileSync(join(dir, EVENTS_FILE), late.map((e) => `${JSON.stringify(e)}\n`).join(''));
    expect(ConductorStore.open(dir).snapshot.workers['wrk-late']).toBeUndefined();
    await archiveOrders(dir, fast);

    expect([readFileSync(oldEvents, 'utf-8'), readFileSync(goneEvents, 'utf-8')]).toEqual(before);
    expect(readdirSync(join(dir, ORDER_LOGS_DIR))).not.toContain('ord-old');
    expect(readdirSync(join(dir, ORDER_LOGS_DIR))).not.toContain('ord-gone');
    const after = ConductorStore.open(dir).snapshot;
    expect(after.workers['wrk-late']).toBeUndefined();
    expect(after.gates['gate-late']).toBeUndefined();
  });

  it('닫히고 기간이 지난 컨덕터 게이트를 상태에서 버린다', async () => {
    const dir = tempStateDir();
    const s = ConductorStore.open(dir, { now: () => new Date('2026-11-01T00:00:00.000Z') });
    s.openGate(gate({ id: 'gate-old' }));
    s.append({
      type: 'gate-resolved',
      at: s.timestamp(),
      gateId: 'gate-old',
      decision: 'approved',
    });
    s.append({ type: 'slack-posted', at: s.timestamp(), gateId: 'gate-old', ref: 'C1/1' });
    s.openGate(gate({ id: 'gate-open' }));

    const result = await archiveOrders(dir, fast);

    expect(result).toMatchObject({ gates: ['gate-old'] });
    const after = ConductorStore.open(dir).snapshot;
    expect(Object.keys(after.gates)).toEqual(['gate-open']);
    expect(after.slackPosted['gate-old']).toBeUndefined();
  });

  it('꼴이 이상한 주문 id의 줄은 저장소 밖에 안 쓴다', async () => {
    const dir = tempStateDir();
    const s = ConductorStore.open(dir);
    s.append({ type: 'order-added', at: s.timestamp(), order: order({ id: '../evil' }) });
    s.append({
      type: 'order-updated',
      at: s.timestamp(),
      orderId: '../evil',
      patch: { status: 'done' },
    });

    await foldEvents(dir, fast);

    expect(existsSync(join(dir, 'evil'))).toBe(false);
    expect(existsSync(join(dir, ORDER_LOGS_DIR))).toBe(false);
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

function gate(over: Partial<Gate> = {}): Gate {
  return {
    id: 'gate-1',
    type: 'merge',
    status: 'open',
    reason: '확인',
    refs: [],
    openedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

describe('orderOfEvent', () => {
  const at = '2026-11-01T00:00:00.000Z';
  const s = emptySnapshot();
  s.workers['wrk-1'] = worker('ord-1', { id: 'wrk-1' });
  s.gates['gate-1'] = gate({ orderId: 'ord-1' });
  s.gates['gate-c'] = gate({ id: 'gate-c' });
  const report = { workerId: 'wrk-1', status: 'done' as const, summary: '', refs: [] };
  const cases: [string, ConductorEvent, string | undefined][] = [
    ['order-added', { type: 'order-added', at, order: order({ id: 'ord-1' }) }, 'ord-1'],
    ['order-updated', { type: 'order-updated', at, orderId: 'ord-1', patch: {} }, 'ord-1'],
    ['order-removed', { type: 'order-removed', at, orderId: 'ord-1' }, 'ord-1'],
    ['worker-started', { type: 'worker-started', at, worker: worker('ord-1') }, 'ord-1'],
    ['worker-updated', { type: 'worker-updated', at, workerId: 'wrk-1', patch: {} }, 'ord-1'],
    ['모르는 워커', { type: 'worker-updated', at, workerId: 'wrk-x', patch: {} }, undefined],
    ['report-applied', { type: 'report-applied', at, name: 'r', report }, 'ord-1'],
    ['이름만 있는 report-applied', { type: 'report-applied', at, name: 'r' }, undefined],
    [
      'checkpoint-saved',
      {
        type: 'checkpoint-saved',
        at,
        checkpoint: {
          orderId: 'ord-1',
          workerId: 'wrk-1',
          skill: 's',
          next: '',
          completedSkills: [],
          refs: [],
          savedAt: at,
        },
      },
      'ord-1',
    ],
    ['gate-opened', { type: 'gate-opened', at, gate: gate({ orderId: 'ord-1' }) }, 'ord-1'],
    ['gate-updated', { type: 'gate-updated', at, gateId: 'gate-1', reason: '', refs: [] }, 'ord-1'],
    [
      'gate-resolved',
      { type: 'gate-resolved', at, gateId: 'gate-1', decision: 'approved' },
      'ord-1',
    ],
    ['gate-delivery', { type: 'gate-delivery', at, gateId: 'gate-1', pending: false }, 'ord-1'],
    ['slack-posted', { type: 'slack-posted', at, gateId: 'gate-1', ref: 'C1/1' }, 'ord-1'],
    [
      '컨덕터 게이트',
      { type: 'gate-resolved', at, gateId: 'gate-c', decision: 'approved' },
      undefined,
    ],
    ['tick', { type: 'tick', at }, undefined],
    ['tail-repaired', { type: 'tail-repaired', at }, undefined],
  ];

  it.each(cases)('%s', (_, e, expected) => {
    expect(orderOfEvent(e, s)).toBe(expected);
  });
});

describe('writeDurable', () => {
  it('새 내용으로 바꾸고 임시 파일을 안 남긴다', () => {
    const dir = tempStateDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'a.json');
    writeFileSync(path, 'old');

    writeDurable(path, 'new');

    expect(readFileSync(path, 'utf-8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['a.json']);
  });

  it('바꾸기에 실패하면 옛 자리를 그대로 두고 임시 파일을 지운다', () => {
    const dir = tempStateDir();
    const path = join(dir, 'a.json');
    // 비어 있지 않은 디렉토리 자리에는 이름을 바꿀 수 없다
    mkdirSync(join(path, 'keep'), { recursive: true });

    expect(() => writeDurable(path, 'new')).toThrow();

    expect(readdirSync(dir)).toEqual(['a.json']);
    expect(readdirSync(path)).toEqual(['keep']);
  });
});
