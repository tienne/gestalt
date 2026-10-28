import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShareStream } from '../../../src/peer/share.js';
import type { ShareFrame } from '../../../src/peer/share.js';
import { FAKE_HOME } from '../../fixtures/peer/transcript.js';

const reply = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n';

describe('ShareStream', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'peer-share-'));
    file = join(dir, 't.jsonl');
    writeFileSync(file, '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const make = (maxBacklogBytes?: number): ShareStream =>
    new ShareStream({
      id: 's',
      transcriptPath: file,
      tools: 'full',
      home: FAKE_HOME,
      maxBacklogBytes,
    });

  it('리스너 하나가 던져도 다른 리스너는 받고 던진 리스너는 뷰어 수에서 빠진다', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stream = make();
    const got: ShareFrame[] = [];
    stream.subscribe((f) => {
      if (f.type === 'event') throw new Error('끊긴 뷰어');
    });
    stream.subscribe((f) => got.push(f));
    expect(stream.viewerCount).toBe(2);

    appendFileSync(file, reply('첫 답'));
    stream.poll();
    expect(stream.viewerCount).toBe(1);
    expect(got.filter((f) => f.type === 'event')).toHaveLength(1);

    appendFileSync(file, reply('둘째 답'));
    stream.poll();
    expect(got.filter((f) => f.type === 'event')).toHaveLength(2);
  });

  it('앞부분이 상한을 넘으면 오래된 것부터 버리고 seq는 당기지 않는다', () => {
    const stream = make(200);
    for (let i = 1; i <= 10; i++) appendFileSync(file, reply(`답 ${i} ${'x'.repeat(40)}`));
    stream.poll();
    expect(stream.eventCount).toBe(10);
    expect(stream.droppedEvents).toBeGreaterThan(0);
    const dropped = stream.droppedEvents;

    const fresh: ShareFrame[] = [];
    stream.subscribe((f) => fresh.push(f));
    expect(fresh.find((f) => f.type === 'trimmed')).toEqual({ type: 'trimmed', dropped });
    const seqs = fresh.flatMap((f) => (f.type === 'event' ? [f.seq] : []));
    expect(seqs[0]).toBe(dropped + 1);
    expect(seqs.at(-1)).toBe(10);

    // 버려진 구간 안에서 이어 받으면 빠진 개수만큼 알리고 남은 것부터 준다
    const resumed: ShareFrame[] = [];
    stream.subscribe((f) => resumed.push(f), 1);
    expect(resumed.find((f) => f.type === 'trimmed')).toEqual({
      type: 'trimmed',
      dropped: dropped - 1,
    });

    // 버려지지 않은 자리에서 이어 받으면 생략 표시 없이 그 뒤만 준다
    const tail: ShareFrame[] = [];
    stream.subscribe((f) => tail.push(f), 9);
    expect(tail.some((f) => f.type === 'trimmed')).toBe(false);
    expect(tail.flatMap((f) => (f.type === 'event' ? [f.seq] : []))).toEqual([10]);
  });

  it('상한에 밀려 버린 칸은 비워 둔다', () => {
    const stream = make(200);
    for (let i = 1; i <= 10; i++) appendFileSync(file, reply(`답 ${i} ${'x'.repeat(40)}`));
    stream.poll();
    const inner = stream as unknown as { events: unknown[]; head: number };
    expect(inner.head).toBeGreaterThan(0);
    expect(inner.events.slice(0, inner.head).every((e) => e === undefined)).toBe(true);
    expect(inner.events.slice(inner.head).every((e) => e !== undefined)).toBe(true);
  });

  it('backlogAfter는 바이트 상한만큼씩 꺼내고 이벤트 하나가 상한보다 커도 하나는 꺼낸다', () => {
    const stream = make();
    for (let i = 1; i <= 5; i++) appendFileSync(file, reply(`답 ${i}`));
    stream.poll();

    const first = stream.backlogAfter(0, 1);
    expect(first.dropped).toBe(0);
    expect(first.items.map((x) => x.seq)).toEqual([1]);
    expect(first.items[0]!.json).toContain('답 1');

    const rest = stream.backlogAfter(2, Infinity);
    expect(rest.items.map((x) => x.seq)).toEqual([3, 4, 5]);

    stream.close('unshare');
    expect(stream.backlogAfter(0, Infinity)).toEqual({ dropped: 0, items: [] });
  });
});
