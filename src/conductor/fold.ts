import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { log } from '../core/log.js';
import { acquireLock } from './engine.js';
import {
  BASE_FILE,
  EVENTS_FILE,
  completeLength as completeBytes,
  SEGMENTS_DIR,
  emptySnapshot,
  listSegments,
  readBase,
  replay,
  type BaseFile,
  type FoldedSegment,
} from './store.js';

export interface FoldOptions {
  /** 떼어 낸 뒤 늦게 도착하는 줄을 기다리는 시간. 테스트만 줄인다 */
  settleMs?: number;
  now?: () => Date;
  /** 테스트가 반영한 길이를 잰 뒤, 지우기 전에 줄을 덧붙여 보는 자리 */
  beforeRemove?: () => void;
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
    for (const name of names) {
      const from = before.get(name) ?? 0;
      const end = completeLength(join(segDir, name));
      if (end > from) {
        replay(join(segDir, name), state, { from, to: end });
        if (!segments.includes(name)) segments.push(name);
      }
      folded.push({ name, size: Math.max(end, from) });
    }
    if (segments.length === 0) {
      opts.beforeRemove?.();
      return { status: 'empty', removed: removeSettled(segDir, settled, before) };
    }

    const next: BaseFile = { version: 1, foldedSegments: folded, state };
    writeDurable(join(dir, BASE_FILE), JSON.stringify(next));
    fsyncDir(dir);
    opts.beforeRemove?.();
    const sizes = new Map(folded.map((f) => [f.name, f.size]));
    return { status: 'folded', segments, removed: removeSettled(segDir, settled, sizes) };
  } finally {
    lock.release();
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

function writeDurable(path: string, text: string): void {
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

function fsyncDir(path: string): void {
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
