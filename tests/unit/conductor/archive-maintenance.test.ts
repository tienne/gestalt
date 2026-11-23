import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACTIVITY_DIR } from '../../../src/conductor/activity.js';
import {
  ARCHIVE_DIR,
  PROMPTS_DIR,
  archiveLocation,
  archiveOrders,
  compressArchive,
  pruneArchive,
  runDailyArchive,
  settledMonthCutoff,
} from '../../../src/conductor/archive.js';
import { acquireLock } from '../../../src/conductor/engine.js';
import { HANDOFF_DIR } from '../../../src/conductor/handoff.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

afterEach(cleanupStateDirs);

const NOW = new Date('2026-11-20T00:00:00.000Z');
const fast = { settleMs: 5, now: () => NOW };

/** 11/1에 끝난 주문 ord-old(워커 wrk-1)와 아직 도는 주문 ord-live(워커 wrk-2) */
function seed(dir: string): void {
  const s = ConductorStore.open(dir, { now: () => new Date('2026-11-01T00:00:00.000Z') });
  s.addOrder(order({ id: 'ord-old' }));
  s.addOrder(order({ id: 'ord-live' }));
  s.startWorker(worker('ord-old', { id: 'wrk-1' }));
  s.startWorker(worker('ord-live', { id: 'wrk-2' }));
  s.updateWorker('wrk-1', { status: 'released' });
  s.updateOrder('ord-old', { status: 'done' });
}

function writeAged(path: string, body: string, at: Date): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  utimesSync(path, at, at);
}

const OLD = new Date('2026-11-01T00:00:00.000Z');

function seedOpsFiles(dir: string): void {
  for (const id of ['wrk-1', 'wrk-2', 'wrk-gone']) {
    writeAged(join(dir, PROMPTS_DIR, `${id}.md`), '# 지시\n', OLD);
    writeAged(join(dir, ACTIVITY_DIR, `${id}.json`), '{}', OLD);
    writeAged(join(dir, ACTIVITY_DIR, `${id}.summary.json`), `{"id":"${id}"}`, OLD);
  }
  // 상태에 없지만 막 쓴 파일은 남긴다
  writeAged(join(dir, PROMPTS_DIR, 'wrk-fresh.md'), '# 지시\n', NOW);
  writeAged(join(dir, HANDOFF_DIR, 'old.md'), '인계', new Date('2026-11-01T00:00:00.000Z'));
  writeAged(join(dir, HANDOFF_DIR, 'new.md'), '인계', new Date('2026-11-15T00:00:00.000Z'));
}

describe('보관할 때 운영 파일 정리', () => {
  it('상태에 없는 워커의 prompts와 activity, 기간 지난 handoffs를 지운다', async () => {
    const dir = tempStateDir();
    seed(dir);
    seedOpsFiles(dir);

    const result = await archiveOrders(dir, fast);

    expect(result).toMatchObject({
      status: 'archived',
      swept: { prompts: 1, activity: 2, handoffs: 1 },
    });
    expect(readdirSync(join(dir, PROMPTS_DIR)).sort()).toEqual([
      'wrk-1.md',
      'wrk-2.md',
      'wrk-fresh.md',
    ]);
    expect(existsSync(join(dir, ACTIVITY_DIR, 'wrk-gone.json'))).toBe(false);
    expect(readdirSync(join(dir, HANDOFF_DIR))).toEqual(['new.md']);
  });

  it('옮긴 주문 워커의 요약을 보관소에 복사하고 원본은 다음 보관이 지운다', async () => {
    const dir = tempStateDir();
    seed(dir);
    seedOpsFiles(dir);

    await archiveOrders(dir, fast);
    const copied = join(dir, ARCHIVE_DIR, '2026-11', 'ord-old', 'workers', 'wrk-1.summary.json');
    expect(readFileSync(copied, 'utf-8')).toBe('{"id":"wrk-1"}');
    // 옮기는 순간에는 워커가 아직 상태에 남아 있으므로 원본도 남는다
    expect(existsSync(join(dir, ACTIVITY_DIR, 'wrk-1.summary.json'))).toBe(true);

    const again = await archiveOrders(dir, fast);
    expect(again).toMatchObject({ swept: { prompts: 1, activity: 2 } });
    expect(existsSync(join(dir, ACTIVITY_DIR, 'wrk-1.summary.json'))).toBe(false);
    expect(existsSync(join(dir, PROMPTS_DIR, 'wrk-1.md'))).toBe(false);
    // 도는 워커 것은 그대로다
    expect(existsSync(join(dir, PROMPTS_DIR, 'wrk-2.md'))).toBe(true);
    expect(existsSync(join(dir, ACTIVITY_DIR, 'wrk-2.summary.json'))).toBe(true);
    expect(readFileSync(copied, 'utf-8')).toBe('{"id":"wrk-1"}');
  });

  it('심링크나 디렉토리는 지우지 않는다', async () => {
    const dir = tempStateDir();
    seed(dir);
    mkdirSync(join(dir, PROMPTS_DIR, 'wrk-dir.md'), { recursive: true });
    utimesSync(join(dir, PROMPTS_DIR, 'wrk-dir.md'), OLD, OLD);

    const result = await archiveOrders(dir, fast);

    expect(result).toMatchObject({ swept: { prompts: 0 } });
    expect(existsSync(join(dir, PROMPTS_DIR, 'wrk-dir.md'))).toBe(true);
  });
});

function monthDir(dir: string, month: string, id: string, body = '{}'): void {
  const target = join(dir, ARCHIVE_DIR, month, id);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'order.json'), body);
}

function tarList(path: string): string[] {
  return execFileSync('tar', ['-tzf', path], { encoding: 'utf-8' })
    .split('\n')
    .filter((l) => l.endsWith('order.json'))
    .sort();
}

describe('지난 달 보관소 묶기', () => {
  it('끝나고 한 달 지난 달만 묶는다', () => {
    expect(settledMonthCutoff(new Date('2026-11-23T00:00:00Z'))).toBe('2026-10');
    expect(settledMonthCutoff(new Date('2026-01-05T00:00:00Z'))).toBe('2025-12');
  });

  it('달 디렉토리를 .tar.gz로 묶고 디렉토리를 지운다', () => {
    const dir = tempStateDir();
    monthDir(dir, '2026-09', 'ord-a');
    monthDir(dir, '2026-10', 'ord-b');

    const result = compressArchive(dir, NOW);

    expect(result).toEqual({ status: 'compressed', months: ['2026-09'], warnings: [] });
    expect(readdirSync(join(dir, ARCHIVE_DIR)).sort()).toEqual(['2026-09.tar.gz', '2026-10']);
    expect(tarList(join(dir, ARCHIVE_DIR, '2026-09.tar.gz'))).toEqual(['2026-09/ord-a/order.json']);
    expect(archiveLocation(dir, '2026-09', 'ord-a')).toBe(
      join(ARCHIVE_DIR, '2026-09.tar.gz') + ' 안의 2026-09/ord-a',
    );
    expect(archiveLocation(dir, '2026-10', 'ord-b')).toBe(join(ARCHIVE_DIR, '2026-10', 'ord-b'));
  });

  it('묶은 달에 늦게 보관한 주문이 생기면 합쳐서 다시 묶는다', () => {
    const dir = tempStateDir();
    monthDir(dir, '2026-09', 'ord-a', '"old"');
    compressArchive(dir, NOW);
    monthDir(dir, '2026-09', 'ord-late');
    monthDir(dir, '2026-09', 'ord-a', '"new"');

    compressArchive(dir, NOW);

    const tarball = join(dir, ARCHIVE_DIR, '2026-09.tar.gz');
    expect(tarList(tarball)).toEqual(['2026-09/ord-a/order.json', '2026-09/ord-late/order.json']);
    const out = execFileSync('tar', ['-xzOf', tarball, '2026-09/ord-a/order.json'], {
      encoding: 'utf-8',
    });
    expect(out).toBe('"new"');
    expect(readdirSync(join(dir, ARCHIVE_DIR))).toEqual(['2026-09.tar.gz']);
  });

  it('잠금을 못 잡으면 넘긴다', () => {
    const dir = tempStateDir();
    monthDir(dir, '2026-09', 'ord-a');
    const lock = acquireLock(dir);
    try {
      expect(compressArchive(dir, NOW)).toMatchObject({ status: 'locked' });
    } finally {
      if (lock.ok) lock.release();
    }
    expect(existsSync(join(dir, ARCHIVE_DIR, '2026-09'))).toBe(true);
  });
});

describe('보관소 지우기', () => {
  it('--before보다 앞선 달의 디렉토리와 묶음을 지운다', () => {
    const dir = tempStateDir();
    monthDir(dir, '2026-08', 'ord-a');
    compressArchive(dir, NOW);
    monthDir(dir, '2026-09', 'ord-b');
    monthDir(dir, '2026-10', 'ord-c');

    const dry = pruneArchive(dir, '2026-10', { now: NOW, dryRun: true });
    expect(dry).toEqual({
      status: 'dry-run',
      months: ['2026-08', '2026-09'],
      paths: [join(ARCHIVE_DIR, '2026-08.tar.gz'), join(ARCHIVE_DIR, '2026-09')],
    });
    expect(existsSync(join(dir, ARCHIVE_DIR, '2026-09'))).toBe(true);

    const pruned = pruneArchive(dir, '2026-10', { now: NOW });
    expect(pruned).toMatchObject({ status: 'pruned', months: ['2026-08', '2026-09'] });
    expect(readdirSync(join(dir, ARCHIVE_DIR))).toEqual(['2026-10']);
  });

  it('끝나고 한 달이 안 지난 달이나 꼴이 틀린 값은 받지 않는다', () => {
    const dir = tempStateDir();
    expect(() => pruneArchive(dir, '2026-11', { now: NOW })).toThrow('한 달이 안 지난');
    expect(() => pruneArchive(dir, '2026-9', { now: NOW })).toThrow('YYYY-MM');
  });
});

describe('tick이 부르는 하루 한 번 보관', () => {
  it('하루에 한 번만 돌고 돌린 시각을 남긴다', async () => {
    const dir = tempStateDir();
    seed(dir);

    const first = await runDailyArchive(dir, { now: NOW, settleMs: 5 });
    expect(first).toMatchObject({ orders: ['ord-old'], blocked: [], compressed: [] });

    const later = new Date(NOW.getTime() + 23 * 60 * 60 * 1000);
    expect(await runDailyArchive(dir, { now: later, settleMs: 5 })).toBeUndefined();

    const nextDay = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    expect(await runDailyArchive(dir, { now: nextDay, settleMs: 5 })).toMatchObject({
      orders: [],
    });
  });

  it('잠금을 못 잡으면 돌린 시각을 안 남겨 다음 tick이 다시 돈다', async () => {
    const dir = tempStateDir();
    seed(dir);
    const lock = acquireLock(dir);
    try {
      expect(await runDailyArchive(dir, { now: NOW, settleMs: 5 })).toBeUndefined();
    } finally {
      if (lock.ok) lock.release();
    }
    expect(await runDailyArchive(dir, { now: NOW, settleMs: 5 })).toMatchObject({
      orders: ['ord-old'],
    });
  });

  it('지난 달 보관소도 함께 묶는다', async () => {
    const dir = tempStateDir();
    seed(dir);
    monthDir(dir, '2026-09', 'ord-a');

    const r = await runDailyArchive(dir, { now: NOW, settleMs: 5 });

    expect(r?.compressed).toEqual(['2026-09']);
  });
});
