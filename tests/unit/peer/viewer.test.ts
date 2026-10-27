import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShareStream } from '../../../src/peer/share.js';
import { REPLAY_CHUNK_BYTES, ViewerServer } from '../../../src/peer/viewer.js';
import { FAKE_HOME } from '../../fixtures/peer/transcript.js';

const reply = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n';

const LIMIT = 64 * 1024;

interface SseFrame {
  event: string;
  id?: number;
  data: string;
}

interface Viewer {
  req: ClientRequest;
  res: IncomingMessage;
  frames: SseFrame[];
  ended: Promise<void>;
  ids(): number[];
}

/** SSE 뷰어 하나를 붙인다. paused면 응답을 안 읽어 소켓이 차게 둔다 */
function openViewer(port: number, paused: boolean): Promise<Viewer> {
  return new Promise((resolveP, reject) => {
    const frames: SseFrame[] = [];
    let buffer = '';
    let markEnded: () => void = () => {};
    const ended = new Promise<void>((r) => (markEnded = r));
    const req = httpGet(`http://127.0.0.1:${port}/s/s/events?t=tok`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let at: number;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const frame: SseFrame = { event: 'message', data: '' };
          let comment = true;
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue;
            comment = false;
            if (line.startsWith('id: ')) frame.id = Number(line.slice(4));
            else if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) frame.data = line.slice(6);
          }
          if (!comment) frames.push(frame);
        }
      });
      res.on('end', markEnded);
      res.on('close', markEnded);
      if (paused) res.pause();
      resolveP({
        req,
        res,
        frames,
        ended,
        ids: () => frames.filter((f) => f.event === 'line').map((f) => f.id!),
      });
    });
    req.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
    });
  });
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_v, i) => from + i);

describe('ViewerServer', () => {
  let dir: string;
  let file: string;
  let stream: ShareStream;
  let server: ViewerServer;
  let disconnects: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'peer-viewer-'));
    file = join(dir, 't.jsonl');
    writeFileSync(file, '');
    stream = new ShareStream({ id: 's', transcriptPath: file, tools: 'full', home: FAKE_HOME });
    disconnects = 0;
    server = new ViewerServer(
      {
        lookup: (id) => (id === 's' ? { stream, token: 'tok' } : undefined),
        onDisconnect: () => disconnects++,
      },
      { maxLiveBacklogBytes: LIMIT },
    );
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 대화 기록에 `count`개를 붙이고 다 읽힐 때까지 poll한다. 한 번에 읽는 양에 상한이 있다 */
  async function pushEvents(count: number, size: number): Promise<void> {
    const target = stream.eventCount + count;
    for (let i = 0; i < count; i++) appendFileSync(file, reply(`${i} ${'x'.repeat(size)}`));
    while (stream.eventCount < target) {
      stream.poll();
      await new Promise((r) => setImmediate(r));
    }
  }

  function useStream(maxBacklogBytes: number): void {
    stream = new ShareStream({
      id: 's',
      transcriptPath: file,
      tools: 'full',
      home: FAKE_HOME,
      maxBacklogBytes,
    });
  }

  /** 앞부분을 다 못 보내 소켓이 비기를 기다리는 중인지. 다 따라잡으면 subscribe로 붙는다 */
  async function expectReplayStalled(): Promise<void> {
    await new Promise((r) => setTimeout(r, 50));
    expect(stream.viewerCount).toBe(0);
  }

  it('안 읽는 뷰어는 실시간 프레임이 상한을 넘게 밀리면 끊고 뷰어 수에서 뺀다', async () => {
    const port = await server.start(0);
    const req = await new Promise<ClientRequest>((resolveP, reject) => {
      const r = httpGet(`http://127.0.0.1:${port}/s/s/events?t=tok`, (res) => {
        res.pause();
        resolveP(r);
      });
      r.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
      });
    });
    try {
      expect(stream.viewerCount).toBe(1);
      // 커널 소켓 버퍼가 먼저 받아 주므로 상한보다 넉넉히 민다
      const chunk = 'x'.repeat(100_000);
      for (let i = 0; i < 400 && stream.viewerCount > 0; i++) {
        appendFileSync(file, reply(`${i} ${chunk}`));
        stream.poll();
        await new Promise((r) => setImmediate(r));
      }
      expect(stream.viewerCount).toBe(0);
      expect(disconnects).toBe(1);
    } finally {
      req.destroy();
    }
  });

  it('상한보다 큰 이벤트 하나는 보내고 소켓이 빈 뒤 오는 다음 이벤트도 끊지 않고 보낸다', async () => {
    const port = await server.start(0);
    const viewer = await openViewer(port, false);
    try {
      await waitFor(() => stream.viewerCount === 1, 'subscribe');
      await pushEvents(1, 2 * 1024 * 1024);
      await waitFor(() => viewer.ids().includes(1), 'id 1');
      await pushEvents(1, 10);
      await waitFor(() => viewer.ids().includes(2), 'id 2');
      expect(viewer.ids()).toEqual([1, 2]);
      expect(disconnects).toBe(0);
      expect(stream.viewerCount).toBe(1);
    } finally {
      viewer.req.destroy();
    }
  });

  it('상한보다 큰 이벤트가 소켓으로 다 빠지기 전에 다음 프레임이 오면 끊는다', async () => {
    const port = await server.start(0);
    const viewer = await openViewer(port, false);
    try {
      await waitFor(() => stream.viewerCount === 1, 'subscribe');
      appendFileSync(file, reply('x'.repeat(2 * 1024 * 1024)));
      appendFileSync(file, reply('small'));
      stream.poll();
      expect(stream.eventCount).toBe(2);
      await waitFor(() => disconnects === 1, 'disconnect');
      expect(stream.viewerCount).toBe(0);
    } finally {
      viewer.req.destroy();
    }
  });

  it('앞부분을 보내는 동안 서버 쪽 소켓 버퍼는 한 번에 꺼내는 양 아래에 머문다', async () => {
    useStream(64 * 1024 * 1024);
    await pushEvents(80, 100_000);
    const port = await server.start(0);
    const viewer = await openViewer(port, true);
    try {
      await expectReplayStalled();
      const open = (server as unknown as { open: Set<ServerResponse> }).open;
      expect(open.size).toBe(1);
      let most = 0;
      for (let i = 0; i < 10; i++) {
        for (const res of open) most = Math.max(most, res.writableLength);
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(most).toBeGreaterThan(0);
      expect(most).toBeLessThan(REPLAY_CHUNK_BYTES);
    } finally {
      viewer.req.destroy();
    }
  });

  it('앞부분이 큰 뷰어가 멈춘 사이 쌓인 이벤트까지 1부터 한 번씩 받고 실시간으로 넘어간다', async () => {
    useStream(64 * 1024 * 1024);
    await pushEvents(40, 200_000);
    const port = await server.start(0);
    const viewer = await openViewer(port, true);
    try {
      await expectReplayStalled();
      await pushEvents(20, 200_000);
      expect(stream.viewerCount).toBe(0);
      viewer.res.resume();
      await waitFor(() => stream.viewerCount === 1 && viewer.ids().includes(60), 'catch up');
      await pushEvents(1, 10);
      await waitFor(() => viewer.ids().includes(61), 'live');
      expect(viewer.ids()).toEqual(range(1, 61));
      expect(viewer.frames.some((f) => f.event === 'trimmed')).toBe(false);
    } finally {
      viewer.req.destroy();
    }
  });

  it('앞부분을 보내는 중에 공유가 종료되면 소켓이 빈 뒤 못 보낸 개수를 실은 closed를 보내고 끝낸다', async () => {
    useStream(64 * 1024 * 1024);
    await pushEvents(40, 200_000);
    const port = await server.start(0);
    const viewer = await openViewer(port, true);
    try {
      await expectReplayStalled();
      stream.close('unshare');
      viewer.res.resume();
      await viewer.ended;
      const last = viewer.frames.at(-1)!;
      expect(last.event).toBe('closed');
      const { reason, missed } = JSON.parse(last.data) as { reason: string; missed: number };
      expect(reason).toBe('unshare');
      expect(missed).toBeGreaterThan(0);
      const ids = viewer.ids();
      expect(ids).toEqual(range(1, ids.length));
      expect(ids.length + missed).toBe(stream.eventCount);
      expect(disconnects).toBe(1);
    } finally {
      viewer.req.destroy();
    }
  });

  it('앞부분을 보내는 중에 상한에 밀려 버려져도 받은 id는 겹치지 않고 받은 수와 버린 수를 더하면 전체다', async () => {
    useStream(6 * 1024 * 1024);
    await pushEvents(40, 200_000);
    const port = await server.start(0);
    const viewer = await openViewer(port, true);
    try {
      await expectReplayStalled();
      await pushEvents(20, 200_000);
      viewer.res.resume();
      await waitFor(() => stream.viewerCount === 1 && viewer.ids().includes(60), 'catch up');
      const ids = viewer.ids();
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort((a, b) => a - b)).toEqual(ids);
      const dropped = viewer.frames
        .filter((f) => f.event === 'trimmed')
        .reduce((sum, f) => sum + (JSON.parse(f.data) as { dropped: number }).dropped, 0);
      expect(dropped).toBeGreaterThan(0);
      expect(ids.length + dropped).toBe(stream.eventCount);
    } finally {
      viewer.req.destroy();
    }
  });
});
