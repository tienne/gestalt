import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import type { ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShareStream } from '../../../src/peer/share.js';
import { ViewerServer } from '../../../src/peer/viewer.js';
import { FAKE_HOME } from '../../fixtures/peer/transcript.js';

const reply = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n';

const LIMIT = 64 * 1024;

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
});
