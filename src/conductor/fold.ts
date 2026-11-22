import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../core/json-file.js';
import { acquireLock } from './engine.js';
import {
  BASE_FILE,
  EVENTS_FILE,
  SEGMENTS_DIR,
  emptySnapshot,
  listSegments,
  readBase,
  replay,
  type BaseFile,
} from './store.js';

export interface FoldOptions {
  /** 떼어 낸 뒤 늦게 도착하는 줄을 기다리는 시간. 테스트만 줄인다 */
  settleMs?: number;
  now?: () => Date;
}

export type FoldResult =
  | { status: 'folded'; segments: string[] }
  | { status: 'empty' }
  | { status: 'locked'; holder?: number };

const DEFAULT_SETTLE_MS = 1000;

/**
 * `events.jsonl`을 떼어 내 base.json에 반영한다. 재생이 저장소 나이만큼 길어지지 않게 하는 첫 단계다.
 *
 * 워커 프로세스는 잠금 없이 `events.jsonl`에 덧붙이므로 파일을 다시 쓰지 않고 이름만 바꿔 떼어 낸다.
 * 이름을 바꾼 뒤 덧붙는 줄은 새 `events.jsonl`로 간다. 바꾸기 직전에 연 쪽이 옛 파일에 쓰는 줄은
 * 크기가 멈출 때까지 기다렸다 읽는다. tick과 겹치지 않게 같은 `tick.lock`을 잡는다. 못 잡으면 넘긴다.
 *
 * 어느 단계에서 죽어도 다시 열면 같은 상태가 나온다. base.json을 쓰기 전이면 segment가 남아 재생된다.
 * 쓴 뒤 segment를 못 지웠으면 foldedSegments가 그 segment를 건너뛰게 한다.
 */
export async function foldEvents(dir: string, opts: FoldOptions = {}): Promise<FoldResult> {
  const lock = acquireLock(dir);
  if (!lock.ok) return { status: 'locked', holder: lock.holder };
  try {
    const base = readBase(dir);
    removeFolded(dir, base);

    const events = join(dir, EVENTS_FILE);
    const pending = listSegments(dir).filter((n) => !base?.foldedSegments.includes(n));
    if (sizeOf(events) > 0) {
      mkdirSync(join(dir, SEGMENTS_DIR), { recursive: true, mode: 0o700 });
      const name = segmentName(opts.now?.() ?? new Date());
      const path = join(dir, SEGMENTS_DIR, name);
      renameSync(events, path);
      await settle(path, opts.settleMs ?? DEFAULT_SETTLE_MS);
      pending.push(name);
    }
    if (pending.length === 0) return { status: 'empty' };

    const state = base?.state ?? emptySnapshot();
    for (const name of pending) replay(join(dir, SEGMENTS_DIR, name), state);
    const next: BaseFile = { version: 1, foldedSegments: pending, state };
    writeJsonAtomic(join(dir, BASE_FILE), next, { indent: 0, mode: 0o600 });
    removeFolded(dir, next);
    return { status: 'folded', segments: pending };
  } finally {
    lock.release();
  }
}

function removeFolded(dir: string, base: BaseFile | undefined): void {
  for (const name of base?.foldedSegments ?? []) {
    const path = join(dir, SEGMENTS_DIR, name);
    if (existsSync(path)) unlinkSync(path);
  }
}

function segmentName(at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${randomUUID().slice(0, 8)}.jsonl`;
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
