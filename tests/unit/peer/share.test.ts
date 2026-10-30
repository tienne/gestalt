import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShareStream } from '../../../src/peer/share.js';
import type { ShareFrame } from '../../../src/peer/share.js';
import { FAKE_HOME } from '../../fixtures/peer/transcript.js';
import { frameHeader, frameMessage } from '../../../src/peer/message.js';
import { frameExcerpt } from '../../../src/peer/excerpt.js';

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

describe('ShareStream 메시지 감지', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'peer-await-'));
    file = join(dir, 't.jsonl');
    writeFileSync(file, '');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const make = (): ShareStream =>
    new ShareStream({ id: 's', transcriptPath: file, tools: 'full', home: FAKE_HOME });
  const header = (id: string): string => frameHeader('alice', 'human', id);
  const line = (o: unknown): void => appendFileSync(file, JSON.stringify(o) + '\n');
  const kinds = (stream: ShareStream): string[] =>
    stream
      .backlogAfter(0, Infinity)
      .items.map((i) => (JSON.parse(i.json) as { kind: string }).kind);

  it('놀던 세션이 남긴 queue-operation 뒤 user 줄은 주인 프롬프트로 안 나가고 알림은 한 번이다', () => {
    const stream = make();
    const seen = vi.fn();
    const id = 'm_AAAAAAAAAAAAAAAA';
    const text = frameMessage({ from: 'alice', origin: 'human', id, body: '안녕' });
    stream.awaitMessage(header(id), seen);
    line({ type: 'queue-operation', operation: 'enqueue', content: text });
    line({ type: 'queue-operation', operation: 'dequeue' });
    line({ type: 'user', message: { role: 'user', content: text } });
    line({ type: 'user', message: { role: 'user', content: '주인이 친 다음 프롬프트' } });
    stream.poll();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(kinds(stream)).toEqual(['prompt']);
    expect(stream.backlogAfter(0, Infinity).items[0]!.json).toContain('주인이 친 다음 프롬프트');
  });

  it('다른 메시지 본문에 id만 적어서는 들어감이 안 켜진다', () => {
    const stream = make();
    const seen = vi.fn();
    const held = 'm_HELDHELDHELDHELD';
    stream.awaitMessage(header(held), seen);
    const other = frameMessage({
      from: 'alice',
      origin: 'human',
      id: 'm_BBBBBBBBBBBBBBBB',
      body: `${held} id="${held}"`,
    });
    line({ type: 'queue-operation', operation: 'enqueue', content: other });
    stream.poll();
    expect(seen).not.toHaveBeenCalled();
  });

  it('attachment 줄은 prompt 자리로 들어감을 판정한다', () => {
    const stream = make();
    const seen = vi.fn();
    const id = 'm_EEEEEEEEEEEEEEEE';
    stream.awaitMessage(header(id), seen);
    line({
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: frameMessage({ from: 'alice', origin: 'human', id, body: '안녕' }),
      },
    });
    stream.poll();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('도구 결과에 든 여는 태그로는 들어감이 안 켜지고 그 줄도 숨기지 않는다', () => {
    const stream = make();
    const seen = vi.fn();
    const id = 'm_FFFFFFFFFFFFFFFF';
    stream.awaitMessage(header(id), seen);
    // 주인 에이전트가 대화 기록을 읽어 도구 결과에 여는 태그가 그대로 들어간 경우
    line({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cat' } }],
      },
    });
    line({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu1',
            content: frameMessage({ from: 'alice', origin: 'human', id, body: '안녕' }),
          },
        ],
      },
    });
    stream.poll();
    expect(seen).not.toHaveBeenCalled();
    expect(kinds(stream)).toContain('tool_result');
  });

  it('지켜보는 시한이 지난 뒤 들어온 user 줄도 주인 프롬프트로 안 나간다', () => {
    const stream = make();
    const id = 'm_GGGGGGGGGGGGGGGG';
    // 기다리는 항목이 없다. 보류된 메시지를 주인이 지켜보는 시한이 지난 뒤 받아들인 경우다
    line({
      type: 'user',
      message: {
        role: 'user',
        content: frameMessage({ from: 'alice', origin: 'human', id, body: '늦게 들어감' }),
      },
    });
    line({ type: 'user', message: { role: 'user', content: '주인 프롬프트' } });
    stream.poll();
    expect(kinds(stream)).toEqual(['prompt']);
    expect(stream.backlogAfter(0, Infinity).items[0]!.json).toContain('주인 프롬프트');
  });

  it('여는 태그 앞에 다른 text 블록이 붙은 user 줄도 주인 프롬프트로 안 나간다', () => {
    const stream = make();
    const id = 'm_IIIIIIIIIIIIIIII';
    line({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '앞에 붙은 다른 글자' },
          {
            type: 'text',
            text: frameMessage({ from: 'alice', origin: 'human', id, body: '안녕' }),
          },
        ],
      },
    });
    stream.poll();
    expect(kinds(stream)).toEqual([]);
  });

  it('골라 넘긴 발췌 틀이 든 user 줄은 주인 프롬프트로 안 나가고 들어감도 안 켜진다', () => {
    const stream = make();
    const seen = vi.fn();
    stream.awaitMessage(header('m_JJJJJJJJJJJJJJJJ'), seen);
    const text = frameExcerpt({
      owner: 'tienne',
      share: 'shAAAAAA',
      pickedBy: 'alice',
      body: '[주인 (10:12)]\nLEAK_EXCERPT 남의 세션 글자',
    });
    line({ type: 'queue-operation', operation: 'enqueue', content: text });
    line({ type: 'user', message: { role: 'user', content: text } });
    line({ type: 'user', message: { role: 'user', content: '주인이 친 다음 프롬프트' } });
    stream.poll();
    expect(seen).not.toHaveBeenCalled();
    expect(kinds(stream)).toEqual(['prompt']);
    const out = stream
      .backlogAfter(0, Infinity)
      .items.map((i) => i.json)
      .join('');
    expect(out).not.toContain('LEAK_EXCERPT');
  });

  it('끝내 안 보인 메시지는 한 시간 뒤 잊는다', () => {
    const stream = make();
    const seen = vi.fn();
    const id = 'm_CCCCCCCCCCCCCCCC';
    stream.awaitMessage(header(id), seen, 0);
    // 한 시간 뒤 다른 메시지를 지켜보기 시작하면서 앞의 것은 잊힌다
    stream.awaitMessage(header('m_DDDDDDDDDDDDDDDD'), vi.fn(), 60 * 60 * 1000 + 1);
    line({
      type: 'queue-operation',
      operation: 'enqueue',
      content: frameMessage({ from: 'alice', origin: 'human', id, body: 'x' }),
    });
    stream.poll();
    expect(seen).not.toHaveBeenCalled();
  });
});
