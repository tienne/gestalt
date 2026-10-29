/**
 * 보는 쪽 재청 간격. 다시 청하면 되는 거절(too_many 등)이 이어지면 간격이 두 배씩 늘다가 상한에서
 * 멈추는지 본다. 릴레이 없이 PeerNetwork 안쪽만 가짜 타이머로 돌린다.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateMachineKey } from '../../../src/peer/keys.js';
import { MirrorFeed } from '../../../src/peer/mirror.js';
import { PeerNetwork } from '../../../src/peer/network.js';
import { PeerState } from '../../../src/peer/state.js';

/** 테스트가 들여다보는 안쪽. 공개 API로는 재청 간격을 못 본다 */
interface Internals {
  watches: Map<string, unknown>;
  requestWatch(w: unknown): Promise<'ok' | 'waiting'>;
  rewatch(w: unknown): void;
  onWatchReply(from: string, msg: Record<string, unknown>): void;
}

let root: string;
let dbPath: string;
let state: PeerState;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-rewatch-'));
  dbPath = resolve('.gestalt-test', `peer-${randomUUID()}.db`);
  state = new PeerState(dbPath);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  state.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(dbPath, { force: true });
});

describe('재청 간격', () => {
  it('다시 청하면 되는 거절이 이어지면 1, 2, 4초로 늘다가 6번에서 멈춘다', async () => {
    const net = new PeerNetwork({
      state,
      key: loadOrCreateMachineKey(root),
      lookupShare: () => undefined,
    });
    const inner = net as unknown as Internals;
    const w = {
      id: 'w1',
      token: 't',
      share: 's1',
      shareKey: Buffer.alloc(32),
      owner: 'o',
      feed: new MirrorFeed('w1', 'o', 'owner', 's1'),
      messages: false,
      retries: 0,
    };
    inner.watches.set(w.id, w);
    const calls: number[] = [];
    // 주인 데몬 대신 매 청마다 같은 nonce로 too_many 거절 답을 onWatchReply에 넣는다. 횟수를 지우는
    // 자리가 그 함수라서 거기를 거쳐야 한다
    inner.requestWatch = (target) =>
      new Promise((resolveP, rejectP) => {
        const nonce = `n${calls.length}`;
        calls.push(Date.now());
        (target as { pending?: unknown }).pending = {
          nonce,
          settle: { resolve: resolveP, reject: rejectP, timer: setTimeout(() => {}, 0) },
        };
        queueMicrotask(() =>
          inner.onWatchReply('o', { t: 'watch_err', share: 's1', nonce, reason: 'too_many' }),
        );
      });

    inner.rewatch(w);
    // 첫 청은 바로, 그 뒤 재청은 1, 2, 4, 8, 16, 32초 뒤에 간다
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(64_000);
    const gaps = calls.slice(1).map((at, i) => at - calls[i]!);
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000]);
    expect(w.retries).toBe(6);
    expect(w.feed.currentStatus).toBe('offline');
  });
});
