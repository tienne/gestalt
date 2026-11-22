import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../../../src/conductor/engine.js';
import { foldEvents, type FoldResult } from '../../../src/conductor/fold.js';
import { readRecentEvents } from '../../../src/conductor/recent-events.js';
import { loadResults } from '../../../src/conductor/results.js';
import {
  BASE_FILE,
  ConductorStore,
  EVENTS_FILE,
  SEGMENTS_DIR,
  emptySnapshot,
  listSegments,
  readBase,
  storeStamp,
} from '../../../src/conductor/store.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

afterEach(cleanupStateDirs);

const fast = { settleMs: 5 };
const TICK = '{"type":"tick","at":"2026-11-01T00:00:00.000Z"}\n';

function seed(dir: string): ConductorStore {
  const s = ConductorStore.open(dir);
  s.addOrder(order({ id: 'ord-1', sourceRef: 'jira:APP-1' }));
  s.addOrder(order({ id: 'ord-2', createdAt: '2026-11-01T00:01:00.000Z' }));
  s.updateOrder('ord-1', { status: 'running', workerId: 'wrk-1' });
  s.startWorker(worker('ord-1', { id: 'wrk-1' }));
  s.openGate({
    id: 'gate-1',
    orderId: 'ord-2',
    type: 'merge',
    status: 'open',
    reason: '머지 승인',
    refs: [],
    openedAt: s.timestamp(),
  });
  s.append({ type: 'tick', at: s.timestamp() });
  return s;
}

function segPath(dir: string, name: string): string {
  return join(dir, SEGMENTS_DIR, name);
}

describe('foldEvents', () => {
  it('떼어 내고 반영한 뒤 다시 열어도 같은 상태가 나오고 segment는 다음 반영까지 남는다', async () => {
    const dir = tempStateDir();
    const before = seed(dir).snapshot;

    const result = await foldEvents(dir, fast);

    expect(result.status).toBe('folded');
    expect(existsSync(join(dir, EVENTS_FILE))).toBe(false);
    const names = listSegments(dir);
    expect(names).toHaveLength(1);
    expect(readBase(dir)?.foldedSegments.map((f) => f.name)).toEqual(names);
    expect(ConductorStore.open(dir).snapshot).toEqual(before);
  });

  it('반영한 뒤 덧붙인 이벤트도 이어서 재생하고 한 번 더 반영하면 앞 segment를 지운다', async () => {
    const dir = tempStateDir();
    seed(dir);
    await foldEvents(dir, fast);
    const [first] = listSegments(dir);

    const s = ConductorStore.open(dir);
    s.updateOrder('ord-2', { status: 'done' });
    s.append({ type: 'tick', at: s.timestamp() });
    const before = ConductorStore.open(dir).snapshot;
    expect(before.orders['ord-2']?.status).toBe('done');
    expect(before.ticks).toBe(2);

    const result = await foldEvents(dir, fast);
    expect(result).toMatchObject({ status: 'folded', removed: [first] });
    expect(listSegments(dir)).not.toContain(first);
    expect(ConductorStore.open(dir).snapshot).toEqual(before);
    expect(readBase(dir)?.state.eventCount).toBe(before.eventCount);
  });

  it('로그가 비어 있으면 아무것도 바꾸지 않는다', async () => {
    const dir = tempStateDir();
    ConductorStore.open(dir);
    expect(await foldEvents(dir, fast)).toEqual({ status: 'empty' });
    expect(existsSync(join(dir, BASE_FILE))).toBe(false);
  });

  it('tick이 잠금을 잡고 있으면 건너뛴다', async () => {
    const dir = tempStateDir();
    seed(dir);
    const lock = acquireLock(dir);
    if (!lock.ok) throw new Error('잠금을 못 잡았어요');
    try {
      expect((await foldEvents(dir, fast)).status).toBe('locked');
      expect(existsSync(join(dir, EVENTS_FILE))).toBe(true);
    } finally {
      lock.release();
    }
  });

  it('base.json을 쓰기 전에 죽어 남은 segment는 다시 열 때 재생하고 다음에 반영한다', async () => {
    const dir = tempStateDir();
    const before = seed(dir).snapshot;
    // 이름을 바꾼 직후 죽은 저장소
    const name = '0000000001-2026-11-01T00-00-00-000Z.jsonl';
    mkdirSync(join(dir, SEGMENTS_DIR));
    copyFileSync(join(dir, EVENTS_FILE), segPath(dir, name));
    writeFileSync(join(dir, EVENTS_FILE), '');

    expect(ConductorStore.open(dir).snapshot).toEqual(before);
    expect(await foldEvents(dir, fast)).toMatchObject({ status: 'folded', segments: [name] });
    expect(ConductorStore.open(dir).snapshot).toEqual(before);
  });

  it('반영한 뒤 늦게 붙은 줄은 다시 열 때 한 번 재생하고 다음 반영에서도 한 번만 반영한다', async () => {
    const dir = tempStateDir();
    seed(dir);
    await foldEvents(dir, fast);
    const [name] = listSegments(dir);
    // settle 대기보다 늦게 옛 파일에 쓴 워커
    appendFileSync(segPath(dir, name!), TICK);

    const late = ConductorStore.open(dir).snapshot;
    expect(late.ticks).toBe(2);
    expect(await foldEvents(dir, fast)).toMatchObject({ status: 'folded', segments: [name] });
    expect(existsSync(segPath(dir, name!))).toBe(false);
    expect(ConductorStore.open(dir).snapshot).toEqual(late);
  });

  it('쓰는 중인 반쪽 줄은 반영하지 않고 줄이 끝나면 그때 반영한다', async () => {
    const dir = tempStateDir();
    seed(dir);
    appendFileSync(join(dir, EVENTS_FILE), TICK.slice(0, 20));
    await foldEvents(dir, fast);
    const [name] = listSegments(dir);
    appendFileSync(segPath(dir, name!), TICK.slice(20));

    expect(ConductorStore.open(dir).snapshot.ticks).toBe(2);
    await foldEvents(dir, fast);
    expect(readBase(dir)?.state.ticks).toBe(2);
  });

  it('시계가 뒤로 가도 segment 이름 순서가 떼어 낸 순서다', async () => {
    const dir = tempStateDir();
    seed(dir);
    await foldEvents(dir, { ...fast, now: () => new Date('2026-11-02T00:00:00.000Z') });
    const s = ConductorStore.open(dir);
    s.updateOrder('ord-2', { status: 'done' });
    await foldEvents(dir, { ...fast, now: () => new Date('2026-11-01T00:00:00.000Z') });
    const names = readBase(dir)!.foldedSegments.map((f) => f.name);
    expect(names).toEqual([...names].sort());
    expect(names.at(-1)!.startsWith('0000000002-')).toBe(true);
    expect(ConductorStore.open(dir).snapshot.orders['ord-2']?.status).toBe('done');
  });

  it('깨진 base.json은 빈 상태로 넘기지 않고 경로를 붙여 멈춘다', () => {
    const cases = [
      JSON.stringify({ version: 2 }),
      '{"version":1,',
      JSON.stringify({ version: 1, foldedSegments: [], state: { orders: [] } }),
      JSON.stringify({
        version: 1,
        foldedSegments: [{ name: '../../x.jsonl', size: 0 }],
        state: emptySnapshot(),
      }),
    ];
    for (const text of cases) {
      const dir = tempStateDir();
      writeFileSync(join(dir, BASE_FILE), text);
      expect(() => ConductorStore.open(dir)).toThrow(`${join(dir, BASE_FILE)}를 못 읽어요`);
    }
  });

  it('이름 꼴이 아닌 segments 파일은 읽지 않는다', async () => {
    const dir = tempStateDir();
    const before = seed(dir).snapshot;
    mkdirSync(join(dir, SEGMENTS_DIR));
    writeFileSync(segPath(dir, 'notes.jsonl'), TICK);
    expect(ConductorStore.open(dir).snapshot).toEqual(before);
    await foldEvents(dir, fast);
    await foldEvents(dir, fast);
    expect(existsSync(segPath(dir, 'notes.jsonl'))).toBe(true);
  });

  it('떼어 낸 뒤에도 결과 보기와 최근 이벤트, 캐시 키가 반영된 주문을 본다', async () => {
    const dir = tempStateDir();
    const s = seed(dir);
    const recent = readRecentEvents(dir, s.snapshot);
    const orders = Object.keys(loadResults({ stateDir: dir }).snapshot.orders);
    const stamp = storeStamp(dir);
    expect(recent.length).toBeGreaterThan(0);

    await foldEvents(dir, fast);

    expect(existsSync(join(dir, EVENTS_FILE))).toBe(false);
    expect(Object.keys(loadResults({ stateDir: dir }).snapshot.orders)).toEqual(orders);
    expect(readRecentEvents(dir, ConductorStore.open(dir).snapshot)).toEqual(recent);
    expect(storeStamp(dir)).not.toBe(stamp);
  });

  it('떼어 내는 동안 다른 프로세스가 덧붙여도 이벤트가 빠지지 않는다', async () => {
    const dir = resolve(tempStateDir());
    ConductorStore.open(dir);
    const storeUrl = pathToFileURL(resolve('src/conductor/store.ts')).href;
    const total = 400;
    const code = `
      const { ConductorStore } = await import(${JSON.stringify(storeUrl)});
      const s = ConductorStore.open(process.argv[1]);
      for (let i = 0; i < ${total}; i++) {
        s.append({ type: 'tick', at: 'c-' + i });
        if (i % 50 === 0) await new Promise((r) => setTimeout(r, 5));
      }
    `;
    const child = new Promise<void>((done, fail) => {
      const p = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', code, dir],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let err = '';
      p.stderr.on('data', (b: Buffer) => (err += b.toString()));
      p.on('error', fail);
      p.on('exit', (c) => (c === 0 ? done() : fail(new Error(`exit ${c}: ${err}`))));
    });
    const folds: Promise<FoldResult>[] = [];
    const timer = setInterval(() => folds.push(foldEvents(dir, { settleMs: 20 })), 15);
    try {
      await child;
    } finally {
      clearInterval(timer);
    }
    const results = await Promise.all(folds);
    await foldEvents(dir, fast);

    // 자식이 덧붙이는 동안 실제로 떼어 낸 적이 있어야 이 테스트가 겹침을 본 것이다
    expect(results.filter((r) => r.status === 'folded').length).toBeGreaterThan(0);
    expect(ConductorStore.open(dir).snapshot.ticks).toBe(total);
  }, 30_000);
});
