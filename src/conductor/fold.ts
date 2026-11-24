import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { log } from '../core/log.js';
import { acquireLock } from './engine.js';
import { SAFE_ORDER_ID } from './ref-copy.js';
import {
  BASE_FILE,
  EVENTS_FILE,
  completeLength as completeBytes,
  SEGMENTS_DIR,
  emptySnapshot,
  listSegments,
  orderOfEvent,
  readBase,
  replay,
  type BaseFile,
  type FoldedSegment,
} from './store.js';
import type { ConductorSnapshot } from './types.js';

/**
 * 주문별로 모아 둔 이벤트 줄. segment는 다음 반영 때 지워지므로 보관할 때 쓸 줄을 반영하면서 여기 옮겨 둔다.
 * 주문마다 `<주문 id>.jsonl` 하나에 로그 순서대로 덧붙인다. 0.158.0은 반영 범위마다
 * `<주문 id>/<segment 이름>.<반영 시작 바이트 12자리>.jsonl`을 따로 썼고 그 파일도 보관할 때 앞에 이어 읽는다
 */
export const ORDER_LOGS_DIR = 'order-logs';
/** 덧붙이기 전에 주문별 파일 크기를 적어 두는 자리. base.json을 못 쓰고 죽으면 다음 반영이 이 크기로 되돌린다 */
const STAGING_FILE = '.staging.json';

export function orderLogPath(dir: string, id: string): string {
  return join(dir, ORDER_LOGS_DIR, `${id}.jsonl`);
}

export interface FoldOptions {
  /** 떼어 낸 뒤 늦게 도착하는 줄을 기다리는 시간. 테스트만 줄인다 */
  settleMs?: number;
  now?: () => Date;
  /** 테스트가 반영한 길이를 잰 뒤, 지우기 전에 줄을 덧붙여 보는 자리 */
  beforeRemove?: () => void;
  /**
   * base.json을 쓰기 전에 반영한 상태를 고친다. 고쳤으면 true를 돌려준다. 그러면 새로 반영한 줄이
   * 없어도 base.json을 다시 쓴다. 보관이 주문을 상태에서 빼는 자리다
   */
  beforeWrite?: (state: ConductorSnapshot) => boolean;
  /** base.json을 fsync한 뒤. 상태에서 뺀 주문의 파일은 이때부터 지워도 된다 */
  afterWrite?: (state: ConductorSnapshot) => void;
}

/** segments는 이번에 떼어 냈거나 새로 반영한 segment, removed는 지난 반영에서 남겨 뒀다 지운 segment */
export type FoldResult =
  | { status: 'folded'; segments: string[]; removed: string[] }
  | { status: 'empty'; removed: string[] }
  | { status: 'locked'; holder?: number };

const DEFAULT_SETTLE_MS = 1000;

/**
 * `events.jsonl`을 떼어 내 base.json에 반영한다. 재생이 저장소 나이만큼 길어지지 않게 하는 첫 단계다.
 *
 * 워커 프로세스는 잠금 없이 `events.jsonl`에 덧붙이므로 파일을 다시 쓰지 않고 이름만 바꿔 떼어 낸다.
 * 이름을 바꾼 뒤 덧붙는 줄은 새 `events.jsonl`로 간다. 바꾸기 직전에 연 쪽이 옛 파일에 쓰는 줄은
 * 크기가 멈출 때까지 기다린다. 그보다 늦게 붙는 줄도 잃지 않게 반영한 segment를 바로 지우지 않고
 * 반영한 길이와 함께 base.json에 적어 둔다. 읽는 쪽은 그 길이 뒤만 재생하고 다음 반영이 꼬리를 마저
 * 반영한 뒤 지운다. tick과 겹치지 않게 같은 `tick.lock`을 잡는다. 못 잡으면 넘긴다.
 *
 * base.json은 fsync한 뒤에만 segment를 지운다. 어느 단계에서 죽어도 다시 열면 같은 상태가 나온다.
 */
export async function foldEvents(dir: string, opts: FoldOptions = {}): Promise<FoldResult> {
  const lock = acquireLock(dir);
  if (!lock.ok) return { status: 'locked', holder: lock.holder };
  try {
    const base = readBase(dir);
    rollbackStaging(dir, base);
    const before = new Map(base?.foldedSegments.map((f) => [f.name, f.size]) ?? []);
    const segDir = join(dir, SEGMENTS_DIR);

    const events = join(dir, EVENTS_FILE);
    const segments: string[] = [];
    if (sizeOf(events) > 0) {
      mkdirSync(segDir, { recursive: true, mode: 0o700 });
      const name = nextSegmentName(dir, base, opts.now?.() ?? new Date());
      const path = join(segDir, name);
      renameSync(events, path);
      fsyncDir(segDir);
      fsyncDir(dir);
      await settle(path, opts.settleMs ?? DEFAULT_SETTLE_MS);
      segments.push(name);
    }

    const names = listSegments(dir);
    // 지난 반영 때 이미 있던 segment. 늦게 붙는 줄을 한 주기 동안 받았으니 이번에 지운다
    const settled = names.filter((n) => before.has(n));
    const state = base?.state ?? emptySnapshot();
    const folded: FoldedSegment[] = [];
    const lines = new Map<string, string[]>();
    for (const name of names) {
      const from = before.get(name) ?? 0;
      const end = completeLength(join(segDir, name));
      if (end > from) {
        replay(join(segDir, name), state, { from, to: end }, (e, line, s) => {
          const id = orderOfEvent(e, s);
          // 이미 옮긴 주문에 늦게 온 줄은 버린다. 끝나고 기간이 지났고 워커도 게이트도 없는 주문만 옮긴다
          if (id === undefined || id in s.archivedOrders || s.removedOrders[id]?.archived) return;
          const list = lines.get(id);
          if (list) list.push(line);
          else lines.set(id, [line]);
        });
        if (!segments.includes(name)) segments.push(name);
      }
      folded.push({ name, size: Math.max(end, from) });
    }
    // base.json보다 먼저 쓴다. 쓰고 죽으면 다음 반영이 덧붙인 줄을 걷고 같은 범위를 다시 읽어 덧붙인다
    const foldId = randomUUID();
    const staged = stageOrderLogs(dir, lines, foldId);
    const changed = opts.beforeWrite?.(state) ?? false;
    if (segments.length === 0 && !changed) {
      opts.beforeRemove?.();
      return { status: 'empty', removed: removeSettled(segDir, settled, before) };
    }

    const orderLogsFold = staged ? foldId : base?.orderLogsFold;
    const next: BaseFile = {
      version: 1,
      foldedSegments: folded,
      state,
      ...(orderLogsFold !== undefined ? { orderLogsFold } : {}),
    };
    writeDurable(join(dir, BASE_FILE), JSON.stringify(next));
    fsyncDir(dir);
    opts.afterWrite?.(state);
    opts.beforeRemove?.();
    const sizes = new Map(folded.map((f) => [f.name, f.size]));
    return { status: 'folded', segments, removed: removeSettled(segDir, settled, sizes) };
  } finally {
    lock.release();
  }
}

/**
 * 이번 반영에서 모은 줄을 주문별 파일에 덧붙인다. 덧붙이기 전에 주문별 파일 크기와 반영 id를 적어 둔다.
 * base.json이 같은 id를 들고 있으면 덧붙인 줄이 반영된 것이고 다르면 다음 반영이 그 크기로 되돌린다.
 * fsync는 반영 한 번에 줄이 닿은 주문 수 + 4번이다(기록 파일, 그 rename, 주문마다 덧붙인 파일,
 * 새 파일 엔트리, `order-logs/`를 새로 만들었으면 저장소 디렉토리). 끝나지 않은 줄을 자른 파일은 한 번씩 더 든다.
 * 덧붙인 줄이 있으면 true다
 */
function stageOrderLogs(
  dir: string,
  lines: ReadonlyMap<string, string[]>,
  foldId: string,
): boolean {
  const ids: string[] = [];
  for (const id of lines.keys()) {
    // 주문 id가 경로가 되므로 꼴을 본다. 손으로 고친 로그의 이상한 id는 모으지 않는다
    if (SAFE_ORDER_ID.test(id)) ids.push(id);
    else log(`주문 id 꼴이 이상해 주문별 로그에 안 모아요: ${id.slice(0, 80)}`);
  }
  if (ids.length === 0) return false;
  const logDir = join(dir, ORDER_LOGS_DIR);
  const created = !isDir(logDir);
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const sizes: Record<string, number> = {};
  for (const id of ids) sizes[id] = trimPartialTail(orderLogPath(dir, id));
  const staging: Staging = { foldId, sizes };
  writeDurable(join(logDir, STAGING_FILE), JSON.stringify(staging));
  fsyncDir(logDir);
  for (const id of ids) {
    const fd = openSync(orderLogPath(dir, id), 'a', 0o600);
    try {
      writeFileSync(fd, `${lines.get(id)!.join('\n')}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  fsyncDir(logDir);
  if (created) fsyncDir(dir);
  return true;
}

interface Staging {
  foldId: string;
  /** 덧붙이기 전 주문별 파일 크기 */
  sizes: Record<string, number>;
}

/**
 * 지난 반영이 덧붙인 뒤 base.json을 못 쓰고 죽었으면 덧붙인 줄을 걷는다. 그 범위는 이번 반영이 다시 읽는다.
 * 되돌린 뒤 기록을 지워서 다음 반영이 이미 반영된 줄을 걷지 않게 한다
 */
function rollbackStaging(dir: string, base: BaseFile | undefined): void {
  const logDir = join(dir, ORDER_LOGS_DIR);
  const path = join(logDir, STAGING_FILE);
  let staging: Staging;
  try {
    staging = JSON.parse(readFileSync(path, 'utf-8')) as Staging;
  } catch {
    return;
  }
  if (staging.foldId === base?.orderLogsFold) return;
  for (const [id, size] of Object.entries(staging.sizes ?? {})) {
    if (!SAFE_ORDER_ID.test(id) || !Number.isSafeInteger(size) || size < 0) continue;
    const file = orderLogPath(dir, id);
    if (sizeOf(file) <= size) continue;
    if (size === 0) unlinkQuiet(file);
    else truncateDurable(file, size);
  }
  unlinkQuiet(path);
  fsyncDir(logDir);
}

/**
 * 파일 끝이 줄바꿈이 아니면 마지막 줄바꿈 뒤를 잘라 낸다. 덧붙이다 죽은 반쪽 줄이 다음 줄과 합쳐지지 않게 한다.
 * 남은 크기를 돌려준다. 파일이 없으면 0이다
 */
function trimPartialTail(path: string): number {
  const size = sizeOf(path);
  if (size === 0) return 0;
  const fd = openSync(path, 'r');
  let end: number;
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return size;
    end = completeLines(fd, size);
  } finally {
    closeSync(fd);
  }
  log(`${path} 끝의 끝나지 않은 줄을 잘라 내요`);
  truncateDurable(path, end);
  return end;
}

/** 끝에서부터 읽어 마지막 줄바꿈 바로 뒤 위치를 찾는다. 없으면 0이다 */
function completeLines(fd: number, size: number): number {
  const chunk = Buffer.alloc(64 * 1024);
  let pos = size;
  while (pos > 0) {
    const len = Math.min(chunk.length, pos);
    pos -= len;
    readSync(fd, chunk, 0, len, pos);
    const i = chunk.subarray(0, len).lastIndexOf(0x0a);
    if (i >= 0) return pos + i + 1;
  }
  return 0;
}

function truncateDurable(path: string, size: number): void {
  const fd = openSync(path, 'r+');
  try {
    ftruncateSync(fd, size);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 반영한 길이를 잰 뒤에 줄이 더 붙었으면
 * 지우지 않고 다음 반영으로 넘긴다. 한 주기가 지나도 끝나지 않은 반쪽 줄은 쓰다 죽은 흔적이라 버린다
 */
function removeSettled(
  segDir: string,
  names: string[],
  absorbed: ReadonlyMap<string, number>,
): string[] {
  const removed: string[] = [];
  for (const name of names) {
    const size = absorbed.get(name) ?? 0;
    const path = join(segDir, name);
    if (completeLength(path) > size) continue;
    if (sizeOf(path) > size) log(`${path} 끝의 끝나지 않은 줄을 버려요`);
    unlinkQuiet(path);
    removed.push(name);
  }
  return removed;
}

/**
 * 순번은 디스크와 base.json에 남은 이름 중 가장 큰 값 다음이다. 시계가 뒤로 가도 이름 순서가
 * 떼어 낸 순서와 같게 시각이 아니라 순번으로 정렬한다
 */
function nextSegmentName(dir: string, base: BaseFile | undefined, at: Date): string {
  const names = [...listSegments(dir), ...(base?.foldedSegments.map((f) => f.name) ?? [])];
  const last = Math.max(0, ...names.map((n) => Number(n.slice(0, 10))));
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return `${String(last + 1).padStart(10, '0')}-${stamp}.jsonl`;
}

/** 반영해도 되는 바이트 수. 쓰는 중인 반쪽 줄은 다음에 읽는다 */
function completeLength(path: string): number {
  try {
    return completeBytes(readFileSync(path));
  } catch {
    return 0;
  }
}

/** 임시 파일에 쓰고 fsync한 뒤 이름을 바꾼다. 죽어도 옛 내용이나 새 내용 중 하나만 남는다 */
export function writeDurable(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, text, { encoding: 'utf-8', mode: 0o600 });
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    unlinkQuiet(tmp);
    throw e;
  }
}

export function fsyncDir(path: string): void {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // 디렉토리 fsync를 못 하는 파일 시스템(Windows 등)
  } finally {
    closeSync(fd);
  }
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 이미 없으면 됐다
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function settle(path: string, ms: number): Promise<void> {
  let size = sizeOf(path);
  for (;;) {
    await new Promise((r) => setTimeout(r, ms));
    const now = sizeOf(path);
    if (now === size) return;
    size = now;
  }
}
