import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
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
  dailyArchiveFor,
  pruneArchive,
  runDailyArchive,
  settledMonthCutoff,
  tarLinkViolation,
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
  writeAged(join(dir, HANDOFF_DIR, HANDOFF_OLD), '인계', OLD);
  writeAged(join(dir, HANDOFF_DIR, HANDOFF_NEW), '인계', new Date('2026-11-15T00:00:00.000Z'));
  // 인계 파일 꼴이 아니거나 .md가 아니면 오래됐어도 사람이 둔 것으로 본다
  writeAged(join(dir, HANDOFF_DIR, 'note.md'), '메모', OLD);
  writeAged(join(dir, PROMPTS_DIR, 'wrk-gone.txt'), '메모', OLD);
}

const HANDOFF_OLD = '2026-11-01T00-00-00-000Z-sess-a.md';
const HANDOFF_NEW = '2026-11-15T00-00-00-000Z-sess-b.md';

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
      'wrk-gone.txt',
    ]);
    expect(existsSync(join(dir, ACTIVITY_DIR, 'wrk-gone.json'))).toBe(false);
    expect(readdirSync(join(dir, HANDOFF_DIR)).sort()).toEqual([HANDOFF_NEW, 'note.md']);
  });

  it('--older-than 0이어도 하루 안 된 인계 파일은 남긴다', async () => {
    const dir = tempStateDir();
    seed(dir);
    const hour = 60 * 60 * 1000;
    const recent = '2026-11-19T01-00-00-000Z-sess-c.md';
    const dayOld = '2026-11-18T23-00-00-000Z-sess-d.md';
    writeAged(join(dir, HANDOFF_DIR, recent), '인계', new Date(NOW.getTime() - 23 * hour));
    writeAged(join(dir, HANDOFF_DIR, dayOld), '인계', new Date(NOW.getTime() - 25 * hour));

    const result = await archiveOrders(dir, { ...fast, days: 0 });

    expect(result).toMatchObject({ swept: { handoffs: 1 } });
    expect(readdirSync(join(dir, HANDOFF_DIR))).toEqual([recent]);
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
    expect(archiveLocation(dir, '2026-09', 'ord-a')).toEqual({
      status: 'tarball',
      path: join(ARCHIVE_DIR, '2026-09.tar.gz') + ' 안의 2026-09/ord-a',
    });
    expect(archiveLocation(dir, '2026-10', 'ord-b')).toEqual({
      status: 'dir',
      path: join(ARCHIVE_DIR, '2026-10', 'ord-b'),
    });
    expect(archiveLocation(dir, '2026-08', 'ord-c')).toEqual({ status: 'deleted' });
  });

  it('1월에는 지난해 11월까지 묶는다', () => {
    const dir = tempStateDir();
    monthDir(dir, '2025-11', 'ord-a');
    monthDir(dir, '2025-12', 'ord-b');
    monthDir(dir, '2025-13', 'ord-c');

    const result = compressArchive(dir, new Date('2026-01-05T00:00:00Z'));

    expect(result).toMatchObject({ months: ['2025-11'], warnings: [] });
    expect(readdirSync(join(dir, ARCHIVE_DIR)).sort()).toEqual([
      '2025-11.tar.gz',
      '2025-12',
      '2025-13',
    ]);
  });

  it('묶다 죽어 남은 임시 파일을 치우고 끝까지 묶는다', () => {
    const dir = tempStateDir();
    const root = join(dir, ARCHIVE_DIR);
    monthDir(dir, '2026-09', 'ord-a', '"old"');
    compressArchive(dir, NOW);
    // 이름을 바꾸기 전에 죽은 자리: 옛 묶음과 새 디렉토리, 임시 파일이 함께 있다
    monthDir(dir, '2026-09', 'ord-late');
    writeFileSync(join(root, '2026-09.tar.gz.tmp'), '쓰다 만 묶음');
    mkdirSync(join(root, '.2026-09.merge', '2026-09'), { recursive: true });
    // 디렉토리까지 지운 뒤 죽은 달의 임시 파일
    writeFileSync(join(root, '2026-08.tar.gz.tmp'), '쓰다 만 묶음');
    mkdirSync(join(root, '.2026-08.merge'));

    const result = compressArchive(dir, NOW);

    expect(result).toMatchObject({ months: ['2026-09'], warnings: [] });
    expect(readdirSync(root)).toEqual(['2026-09.tar.gz']);
    expect(tarList(join(root, '2026-09.tar.gz'))).toEqual([
      '2026-09/ord-a/order.json',
      '2026-09/ord-late/order.json',
    ]);
  });

  it('묶음 안에 그 달 밖을 가리키는 항목이 있으면 풀지 않는다', () => {
    const dir = tempStateDir();
    const root = join(dir, ARCHIVE_DIR);
    const src = tempStateDir();
    mkdirSync(join(src, '2026-09'), { recursive: true });
    mkdirSync(join(src, 'other'), { recursive: true });
    writeFileSync(join(src, 'other', 'x'), '밖');
    mkdirSync(root, { recursive: true });
    execFileSync('tar', ['-czf', join(root, '2026-09.tar.gz'), '-C', src, '2026-09', 'other']);
    monthDir(dir, '2026-09', 'ord-a');

    const result = compressArchive(dir, NOW);

    expect(result).toMatchObject({ months: [] });
    expect(result.status === 'compressed' && result.warnings[0]).toContain('밖을 가리키는');
    expect(existsSync(join(root, '2026-09', 'ord-a'))).toBe(true);
    expect(existsSync(join(root, 'other'))).toBe(false);
  });

  it('tar가 실패하면 오류 내용을 경고에 싣고 디렉토리를 둔다', () => {
    const dir = tempStateDir();
    const root = join(dir, ARCHIVE_DIR);
    monthDir(dir, '2026-09', 'ord-a');
    writeFileSync(join(root, '2026-09.tar.gz'), '묶음이 아니에요');

    const result = compressArchive(dir, NOW);

    expect(result).toMatchObject({ months: [] });
    expect(result.status === 'compressed' && result.warnings[0]).toMatch(
      /archive\/2026-09을 못 묶었어요: tar -tzf 실패: \S/,
    );
    expect(existsSync(join(root, '2026-09', 'ord-a'))).toBe(true);
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

  it('묶음 안 이름에 `..` 칸이 있으면 풀지 않는다', () => {
    const dir = tempStateDir();
    const root = join(dir, ARCHIVE_DIR);
    const src = tempStateDir();
    mkdirSync(join(src, '2026-09'), { recursive: true });
    writeFileSync(join(src, 'x'), '밖');
    mkdirSync(root, { recursive: true });
    // -P가 없으면 tar가 `..`를 걷어 내고 묶는다. GNU tar와 bsdtar가 같은 이름을 남기게 한다
    execFileSync('tar', ['-czPf', join(root, '2026-09.tar.gz'), '-C', src, '2026-09/../x']);
    monthDir(dir, '2026-09', 'ord-a');

    const result = compressArchive(dir, NOW);

    expect(result).toMatchObject({ months: [] });
    expect(result.status === 'compressed' && result.warnings[0]).toContain('밖을 가리키는');
    expect(existsSync(join(root, '2026-09', 'ord-a'))).toBe(true);
    expect(existsSync(join(root, 'x'))).toBe(false);
  });

  it('묶음 안 심링크가 밖을 가리키면 풀지 않는다', () => {
    const dir = tempStateDir();
    const root = join(dir, ARCHIVE_DIR);
    const src = tempStateDir();
    mkdirSync(join(src, '2026-09'), { recursive: true });
    symlinkSync('/etc', join(src, '2026-09', 'lnk'));
    mkdirSync(root, { recursive: true });
    execFileSync('tar', ['-czf', join(root, '2026-09.tar.gz'), '-C', src, '2026-09']);
    monthDir(dir, '2026-09', 'ord-a');

    const result = compressArchive(dir, NOW);

    expect(result).toMatchObject({ months: [] });
    expect(result.status === 'compressed' && result.warnings[0]).toContain('밖을 가리키는 링크');
    expect(existsSync(join(root, '2026-09', 'ord-a'))).toBe(true);
    expect(existsSync(join(root, '2026-09', 'lnk'))).toBe(false);
  });

  it.each([
    ['lrwxr-xr-x  0 u g 0 Nov 23 22:04 2026-09/lnk -> /etc', '밖을 가리키는'],
    ['lrwxrwxrwx u/g 0 2026-11-23 22:04 2026-09/lnk -> ../../x', '밖을 가리키는'],
    ['lrwxrwxrwx u/g 0 2026-11-23 22:04 2026-09/lnk -> a -> b', '가를 수 없는'],
    ['hrw-r--r-- u/g 0 2026-11-23 22:04 2026-09/h link to other/x', '밖을 가리키는'],
    ['hrw-r--r--  0 u g 0 Nov 23 22:04 2026-09/h link to 2026-09/../x', '밖을 가리키는'],
    ['hrw-r--r-- u/g 0 2026-11-23 22:04 2026-09/h', '가를 수 없는'],
  ])('밖을 가리키거나 모호한 링크 줄을 막는다: %s', (line, reason) => {
    expect(tarLinkViolation(line, '2026-09')).toContain(reason);
  });

  it.each([
    'lrwxrwxrwx u/g 0 2026-11-23 22:04 2026-09/lnk -> ord-a/order.json',
    'hrw-r--r-- u/g 0 2026-11-23 22:04 2026-09/h link to 2026-09/ord-a/order.json',
    '-rw-r--r-- u/g 3 2026-11-23 22:04 2026-09/ord-a/order.json',
    'drwx------ u/g 0 2026-11-23 22:04 2026-09/',
  ])('그 달 안을 가리키는 링크와 링크가 아닌 줄은 통과시킨다: %s', (line) => {
    expect(tarLinkViolation(line, '2026-09')).toBeUndefined();
  });

  it('새 묶음에 빠진 항목이 있으면 이름을 안 바꾸고 디렉토리를 둔다', () => {
    const dir = tempStateDir();
    const root = join(dir, ARCHIVE_DIR);
    monthDir(dir, '2026-09', 'ord-a');
    writeFileSync(join(root, '2026-09', 'ord-a', 'drop.json'), '{}');
    // -czf일 때만 파일 하나를 잠깐 치워 tar가 그 항목을 빠뜨린 묶음을 만들게 한다
    const bin = tempStateDir();
    const fake = join(bin, 'tar');
    writeFileSync(
      fake,
      [
        '#!/bin/sh',
        'if [ "$1" = "-czf" ]; then',
        '  mv "$4/$5/ord-a/drop.json" "$4/drop.aside"',
        '  "$REAL_TAR" "$@"; code=$?',
        '  mv "$4/drop.aside" "$4/$5/ord-a/drop.json"',
        '  exit $code',
        'fi',
        'exec "$REAL_TAR" "$@"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const realTar = execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf-8' }).trim();
    const path = process.env.PATH;
    process.env.REAL_TAR = realTar;
    process.env.PATH = `${bin}:${path ?? ''}`;
    let result: ReturnType<typeof compressArchive>;
    try {
      result = compressArchive(dir, NOW);
    } finally {
      process.env.PATH = path;
      delete process.env.REAL_TAR;
    }

    expect(result).toMatchObject({ months: [] });
    expect(result.status === 'compressed' && result.warnings[0]).toContain('빠진 항목');
    expect(existsSync(join(root, '2026-09', 'ord-a', 'drop.json'))).toBe(true);
    expect(existsSync(join(root, '2026-09.tar.gz'))).toBe(false);
  });

  it('한 번에 오래된 달부터 두 달만 묶고 나머지는 다음에 묶는다', () => {
    const dir = tempStateDir();
    monthDir(dir, '2026-09', 'ord-c');
    monthDir(dir, '2026-07', 'ord-a');
    monthDir(dir, '2026-08', 'ord-b');

    expect(compressArchive(dir, NOW)).toEqual({
      status: 'compressed',
      months: ['2026-07', '2026-08'],
      warnings: ['못 묶은 달 1개는 다음 보관 때 이어서 묶어요'],
    });
    expect(compressArchive(dir, NOW)).toEqual({
      status: 'compressed',
      months: ['2026-09'],
      warnings: [],
    });
  });

  it('못 묶은 달은 두 달에 안 세고 시간이 넘으면 새 달을 시작하지 않는다', () => {
    const dir = tempStateDir();
    const root = join(dir, ARCHIVE_DIR);
    monthDir(dir, '2026-07', 'ord-a');
    writeFileSync(join(root, '2026-07.tar.gz'), '묶음이 아니에요');
    monthDir(dir, '2026-08', 'ord-b');
    monthDir(dir, '2026-09', 'ord-c');

    expect(compressArchive(dir, NOW, { maxMs: 0 })).toMatchObject({
      months: [],
      warnings: ['못 묶은 달 3개는 다음 보관 때 이어서 묶어요'],
    });
    const result = compressArchive(dir, NOW);
    expect(result).toMatchObject({ months: ['2026-08', '2026-09'] });
    expect(result.status === 'compressed' && result.warnings).toHaveLength(1);
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

  it('지우는 달의 묶다 남은 임시 파일도 지운다', () => {
    const dir = tempStateDir();
    const root = join(dir, ARCHIVE_DIR);
    mkdirSync(join(root, '.2026-08.merge'), { recursive: true });
    writeFileSync(join(root, '2026-08.tar.gz.tmp'), '쓰다 만 묶음');
    monthDir(dir, '2026-10', 'ord-c');

    const pruned = pruneArchive(dir, '2026-09', { now: NOW });

    expect(pruned).toMatchObject({ months: ['2026-08'] });
    expect(readdirSync(root)).toEqual(['2026-10']);
  });

  it('끝나고 한 달이 안 지난 달이나 꼴이 틀린 값은 받지 않는다', () => {
    const dir = tempStateDir();
    expect(() => pruneArchive(dir, '2026-11', { now: NOW })).toThrow('한 달이 안 지난');
    expect(() => pruneArchive(dir, '2026-9', { now: NOW })).toThrow('YYYY-MM');
    expect(() => pruneArchive(dir, '2025-13', { now: NOW })).toThrow('YYYY-MM');
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

  it('보관이 던지면 실패 시각을 남기고 한 시간 뒤에 다시 한다', async () => {
    const dir = tempStateDir();
    seed(dir);
    // 이번 달 보관 자리를 파일로 막아 옮기다 던지게 한다
    mkdirSync(join(dir, ARCHIVE_DIR), { recursive: true });
    writeFileSync(join(dir, ARCHIVE_DIR, '2026-11'), '막힌 자리');

    await expect(runDailyArchive(dir, { now: NOW, settleMs: 5 })).rejects.toThrow();
    expect(JSON.parse(readFileSync(join(dir, ARCHIVE_DIR, 'last-run.json'), 'utf-8'))).toEqual({
      failedAt: NOW.toISOString(),
    });

    const soon = new Date(NOW.getTime() + 59 * 60 * 1000);
    expect(await runDailyArchive(dir, { now: soon, settleMs: 5 })).toBeUndefined();

    const hourLater = new Date(NOW.getTime() + 60 * 60 * 1000);
    await expect(runDailyArchive(dir, { now: hourLater, settleMs: 5 })).rejects.toThrow();
  });

  it('미래로 남은 돌린 시각과 실패 시각은 없는 값으로 본다', async () => {
    const dir = tempStateDir();
    seed(dir);
    mkdirSync(join(dir, ARCHIVE_DIR), { recursive: true });
    const future = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(dir, ARCHIVE_DIR, 'last-run.json'),
      JSON.stringify({ at: future, failedAt: future }),
    );

    expect(await runDailyArchive(dir, { now: NOW, settleMs: 5 })).toMatchObject({
      orders: ['ord-old'],
    });
    expect(JSON.parse(readFileSync(join(dir, ARCHIVE_DIR, 'last-run.json'), 'utf-8'))).toEqual({
      at: NOW.toISOString(),
    });
  });

  it('미래 시각이 남은 채 보관이 던지면 실패 시각만 남긴다', async () => {
    const dir = tempStateDir();
    seed(dir);
    mkdirSync(join(dir, ARCHIVE_DIR), { recursive: true });
    const future = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(join(dir, ARCHIVE_DIR, 'last-run.json'), JSON.stringify({ at: future }));
    writeFileSync(join(dir, ARCHIVE_DIR, '2026-11'), '막힌 자리');

    await expect(runDailyArchive(dir, { now: NOW, settleMs: 5 })).rejects.toThrow();
    expect(JSON.parse(readFileSync(join(dir, ARCHIVE_DIR, 'last-run.json'), 'utf-8'))).toEqual({
      failedAt: NOW.toISOString(),
    });
  });

  it('archive.enabled가 false면 tick에 보관을 안 넘긴다', () => {
    const dir = tempStateDir();
    expect(dailyArchiveFor({ archive: { enabled: false } }, dir)).toBeUndefined();
    expect(dailyArchiveFor({ archive: { enabled: true } }, dir)).toBeTypeOf('function');
    expect(dailyArchiveFor({}, dir)).toBeTypeOf('function');
  });

  it('지난 달 보관소도 함께 묶는다', async () => {
    const dir = tempStateDir();
    seed(dir);
    monthDir(dir, '2026-09', 'ord-a');

    const r = await runDailyArchive(dir, { now: NOW, settleMs: 5 });

    expect(r?.compressed).toEqual(['2026-09']);
  });
});
