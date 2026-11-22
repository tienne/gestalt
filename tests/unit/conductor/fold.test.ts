import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../../../src/conductor/engine.js';
import { foldEvents } from '../../../src/conductor/fold.js';
import {
  BASE_FILE,
  ConductorStore,
  EVENTS_FILE,
  SEGMENTS_DIR,
  readBase,
} from '../../../src/conductor/store.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

afterEach(cleanupStateDirs);

const fast = { settleMs: 5 };

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

describe('foldEvents', () => {
  it('떼어 내고 반영한 뒤 다시 열어도 같은 상태가 나온다', async () => {
    const dir = tempStateDir();
    const before = seed(dir).snapshot;

    const result = await foldEvents(dir, fast);

    expect(result.status).toBe('folded');
    expect(existsSync(join(dir, EVENTS_FILE))).toBe(false);
    expect(readdirSync(join(dir, SEGMENTS_DIR))).toEqual([]);
    expect(ConductorStore.open(dir).snapshot).toEqual(before);
  });

  it('반영한 뒤 덧붙인 이벤트도 이어서 재생하고 한 번 더 떼어 내도 같다', async () => {
    const dir = tempStateDir();
    seed(dir);
    await foldEvents(dir, fast);

    const s = ConductorStore.open(dir);
    s.updateOrder('ord-2', { status: 'done' });
    s.append({ type: 'tick', at: s.timestamp() });
    const before = ConductorStore.open(dir).snapshot;
    expect(before.orders['ord-2']?.status).toBe('done');
    expect(before.ticks).toBe(2);

    await foldEvents(dir, fast);
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
    mkdirSync(join(dir, SEGMENTS_DIR));
    copyFileSync(
      join(dir, EVENTS_FILE),
      join(dir, SEGMENTS_DIR, '2026-11-01T00-00-00-000Z-a.jsonl'),
    );
    writeFileSync(join(dir, EVENTS_FILE), '');

    expect(ConductorStore.open(dir).snapshot).toEqual(before);
    expect((await foldEvents(dir, fast)).status).toBe('folded');
    expect(readdirSync(join(dir, SEGMENTS_DIR))).toEqual([]);
    expect(ConductorStore.open(dir).snapshot).toEqual(before);
  });

  it('base.json을 쓴 뒤 지우지 못한 segment는 두 번 재생하지 않는다', async () => {
    const dir = tempStateDir();
    seed(dir);
    const name = '2026-11-01T00-00-00-000Z-a.jsonl';
    mkdirSync(join(dir, SEGMENTS_DIR));
    copyFileSync(join(dir, EVENTS_FILE), join(dir, SEGMENTS_DIR, name));
    await foldEvents(dir, fast);
    const before = ConductorStore.open(dir).snapshot;
    // 반영은 끝났는데 지우기 전에 죽은 저장소
    const base = readBase(dir)!;
    expect(base.foldedSegments).toContain(name);
    writeFileSync(
      join(dir, SEGMENTS_DIR, name),
      '{"type":"tick","at":"2026-11-01T00:00:00.000Z"}\n',
    );

    expect(ConductorStore.open(dir).snapshot).toEqual(before);
    await foldEvents(dir, fast);
    expect(existsSync(join(dir, SEGMENTS_DIR, name))).toBe(false);
    expect(ConductorStore.open(dir).snapshot).toEqual(before);
  });

  it('깨진 base.json은 빈 상태로 넘기지 않고 멈춘다', () => {
    const dir = tempStateDir();
    writeFileSync(join(dir, BASE_FILE), JSON.stringify({ version: 2 }));
    expect(() => ConductorStore.open(dir)).toThrow(/깨졌어요/);
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
    const folds: Promise<unknown>[] = [];
    const timer = setInterval(() => folds.push(foldEvents(dir, { settleMs: 20 })), 15);
    try {
      await child;
    } finally {
      clearInterval(timer);
    }
    await Promise.all(folds);
    await foldEvents(dir, fast);

    expect(ConductorStore.open(dir).snapshot.ticks).toBe(total);
  }, 30_000);
});
