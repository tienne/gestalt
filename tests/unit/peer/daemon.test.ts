import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { get as httpGet, request as httpRequest } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PeerDaemon } from '../../../src/peer/daemon.js';
import { DaemonUnavailableError, request } from '../../../src/peer/client.js';
import { PeerState } from '../../../src/peer/state.js';
import { ensurePrivateDir } from '../../../src/peer/paths.js';
import { MAX_REQUEST_BYTES } from '../../../src/peer/protocol.js';
import { MAX_VIEWERS_PER_SHARE } from '../../../src/peer/viewer.js';
import type { DaemonStatus, ShareInfo } from '../../../src/peer/protocol.js';
import { FAKE_HOME, FAKE_SECRETS, fixtureText } from '../../fixtures/peer/transcript.js';

/** 응답 본문을 다 받거나 `until`이 참이 될 때까지 모은다. SSE는 끝나지 않으므로 끊고 돌려준다 */
function fetchText(
  url: string,
  until?: (body: string) => boolean,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }> {
  return new Promise((resolveP, reject) => {
    const req = httpGet(url, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      const done = (): void => {
        resolveP({ status: res.statusCode ?? 0, body, headers: res.headers });
        req.destroy();
      };
      res.on('data', (chunk: string) => {
        body += chunk;
        if (until?.(body)) done();
      });
      res.on('end', done);
    });
    req.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
    });
    req.setTimeout(5_000, () => reject(new Error(`timeout: ${url}`)));
  });
}

/** 응답 헤더까지만 받고 연결은 열어 둔다. SSE 뷰어 여럿을 붙여 둘 때 쓴다 */
function openSse(url: string): Promise<{ status: number; req: ClientRequest }> {
  return new Promise((resolveP, reject) => {
    const req = httpGet(url, (res) => {
      res.resume();
      resolveP({ status: res.statusCode ?? 0, req });
    });
    req.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
    });
  });
}

/** 소켓에 날것의 바이트를 보내고 상대가 닫을 때까지 받은 걸 돌려준다 */
function rawExchange(
  target: { path: string } | { port: number },
  payload: string,
): Promise<string> {
  return new Promise((resolveP, reject) => {
    const c = createConnection(target as never);
    let got = '';
    c.setEncoding('utf8');
    c.on('data', (chunk: string) => (got += chunk));
    c.on('close', () => resolveP(got));
    c.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
      reject(err);
    });
    c.write(payload);
  });
}

function eventsUrl(info: ShareInfo): string {
  const url = new URL(info.url);
  return `${url.origin}${url.pathname}/events?t=${url.searchParams.get('t')}`;
}

describe('PeerDaemon', () => {
  let root: string;
  let dbPath: string;
  let transcript: string;
  let daemon: PeerDaemon;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'peer-'));
    dbPath = resolve('.gestalt-test', `peer-${randomUUID()}.db`);
    transcript = join(root, 'fixture.jsonl');
    writeFileSync(transcript, fixtureText());
    daemon = new PeerDaemon({ root, dbPath, pollMs: 20, home: FAKE_HOME });
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(dbPath, { force: true });
  });

  async function openShare(extra: Record<string, unknown> = {}): Promise<ShareInfo> {
    const res = await request<ShareInfo>(daemon.socketPath, {
      op: 'share',
      transcriptPath: transcript,
      ...extra,
    });
    if (!res.ok) throw new Error(res.error);
    return res.result;
  }

  it('소켓은 0600, 디렉토리는 0700이다', () => {
    expect(statSync(daemon.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it('IPC로 요청 한 줄을 보내고 답 한 줄을 받는다', async () => {
    expect(await request(daemon.socketPath, { op: 'ping' })).toEqual({ ok: true, result: 'pong' });

    const status = await request<DaemonStatus>(daemon.socketPath, { op: 'status' });
    expect(status).toMatchObject({
      ok: true,
      result: { shares: 0, viewerPort: daemon.viewerPort },
    });

    const info = await openShare({ tools: 'summary', expiresMinutes: 30 });
    expect(info).toMatchObject({ tools: 'summary', status: 'live', unknownLines: 3 });
    expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[\w-]+\?t=[\w-]+$/);
    expect(info.title).toBe('가짜 세션 제목');

    const list = await request<ShareInfo[]>(daemon.socketPath, { op: 'shares' });
    expect(list.ok && list.result.map((s) => s.id)).toEqual([info.id]);

    expect(await request(daemon.socketPath, { op: 'unshare', id: info.id })).toEqual({
      ok: true,
      result: { id: info.id },
    });
    const after = await request<ShareInfo[]>(daemon.socketPath, { op: 'shares' });
    expect(after.ok && after.result).toEqual([]);
  });

  it('잘못된 요청에는 이유를 담아 실패로 답한다', async () => {
    const bad = await request(daemon.socketPath, { op: 'share', transcriptPath: 'relative.jsonl' });
    expect(bad.ok).toBe(false);
    const notJsonl = await request(daemon.socketPath, {
      op: 'share',
      transcriptPath: '/etc/hosts',
    });
    expect(notJsonl).toMatchObject({ ok: false, error: '.jsonl 파일만 공유할 수 있어요' });
    const unknown = await request(daemon.socketPath, { op: 'nope' } as never);
    expect(unknown.ok).toBe(false);
  });

  it('토큰이 없거나 틀리면 401이고 모르는 공유 id도 401이다', async () => {
    const info = await openShare();
    const url = new URL(info.url);
    const noToken = `${url.origin}${url.pathname}`;

    expect((await fetchText(noToken)).status).toBe(401);
    expect((await fetchText(`${noToken}?t=wrong`)).status).toBe(401);
    expect((await fetchText(`${noToken}/events`)).status).toBe(401);
    expect(
      (await fetchText(`${url.origin}/s/unknownid?t=${url.searchParams.get('t')}`)).status,
    ).toBe(401);
    expect((await fetchText(`${url.origin}/`)).status).toBe(404);
  });

  it('Host가 127.0.0.1이나 localhost가 아니면 막는다', async () => {
    const info = await openShare();
    const status = await new Promise<number>((resolveP, reject) => {
      const req = httpRequest(info.url, { headers: { Host: 'evil.example:80' } }, (res) => {
        res.resume();
        resolveP(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('토큰이 맞으면 자체 포함 HTML을 주고 캐시를 막는다', async () => {
    const info = await openShare();
    const page = await fetchText(info.url);
    expect(page.status).toBe(200);
    expect(page.body).toContain('비밀값 패턴은 가리지만 전부 잡지는 못해요');
    expect(page.body).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('SSE로 앞부분과 새 줄을 흘리고 원문은 내보내지 않는다', async () => {
    const info = await openShare();
    const url = new URL(info.url);
    const events = `${url.origin}${url.pathname}/events?t=${url.searchParams.get('t')}`;

    const backlog = await fetchText(events, (b) => b.includes('다 끝났어요'));
    expect(backlog.status).toBe(200);
    expect(backlog.headers['content-type']).toContain('text/event-stream');
    expect(backlog.body).toContain('event: line');
    expect(backlog.body).toContain('"unknownLines":3');
    expect(backlog.body).not.toContain('LEAK_');
    expect(backlog.body).not.toContain('system-reminder');
    expect(backlog.body).not.toContain(FAKE_HOME);
    for (const secret of Object.values(FAKE_SECRETS)) expect(backlog.body).not.toContain(secret);

    const live = fetchText(events, (b) => b.includes('새로 들어온 답'), { 'Last-Event-ID': '9' });
    setTimeout(() => {
      appendFileSync(
        transcript,
        JSON.stringify({
          type: 'assistant',
          isSidechain: false,
          message: {
            content: [
              { type: 'thinking', thinking: 'LEAK_LIVE_THINKING' },
              { type: 'text', text: '새로 들어온 답' },
            ],
          },
        }) + '\n',
      );
    }, 50);
    const got = await live;
    expect(got.body).toContain('새로 들어온 답');
    expect(got.body).not.toContain('LEAK_');
    // Last-Event-ID 9 뒤부터라 첫 프롬프트(seq 1)는 다시 안 온다
    expect(got.body).not.toContain('id: 1\n');
  });

  it('unshare하면 붙어 있던 뷰어에 closed를 보내고 끊는다', async () => {
    const info = await openShare();
    const url = new URL(info.url);
    const events = `${url.origin}${url.pathname}/events?t=${url.searchParams.get('t')}`;
    const pending = fetchText(events, (b) => b.includes('event: closed'));
    await new Promise((r) => setTimeout(r, 50));
    await request(daemon.socketPath, { op: 'unshare', id: info.id });
    expect((await pending).body).toContain('"reason":"unshare"');
    expect((await fetchText(info.url)).status).toBe(401);
  });

  it('만료되면 닫는다', async () => {
    const info = await openShare({ expiresMinutes: 1 });
    daemon.tick(Date.now() + 2 * 60_000);
    const list = await request<ShareInfo[]>(daemon.socketPath, { op: 'shares' });
    expect(list.ok && list.result.find((s) => s.id === info.id)).toBeUndefined();
  });

  it('감사 로그에 열기와 닫기, 뷰어 접속만 남기고 대화 내용은 남기지 않는다', async () => {
    const info = await openShare();
    const url = new URL(info.url);
    await fetchText(`${url.origin}${url.pathname}/events?t=${url.searchParams.get('t')}`, (b) =>
      b.includes('event: line'),
    );
    await request(daemon.socketPath, { op: 'unshare', id: info.id });
    await daemon.stop();

    const state = new PeerState(dbPath);
    const log = state.auditLog(info.id);
    const share = state.getShare(info.id);
    state.close();

    expect(log.map((r) => r.action)).toEqual(
      expect.arrayContaining(['share_open', 'viewer_connect', 'share_close']),
    );
    expect(share).toMatchObject({ closeReason: 'unshare' });
    expect(JSON.stringify(log)).not.toContain('안녕하세요');
    expect(JSON.stringify(log)).not.toContain(info.url.split('t=')[1]);

    // afterEach가 한 번 더 stop을 불러도 되게 새로 띄운다
    daemon = new PeerDaemon({ root, dbPath, pollMs: 20, home: FAKE_HOME });
    await daemon.start();
  });

  it('데몬이 떠 있는데 또 띄우면 거절하고 거절된 쪽의 stop이 첫 데몬 소켓을 안 지운다', async () => {
    const second = new PeerDaemon({ root, dbPath, home: FAKE_HOME });
    await expect(second.start()).rejects.toThrow('이미 떠 있어요');
    await second.stop();
    expect(await request(daemon.socketPath, { op: 'ping' })).toEqual({ ok: true, result: 'pong' });
  });

  it('.jsonl 이름의 심링크는 실제 경로로 검사하고 따라 읽는다', async () => {
    const other = join(root, 'secret.txt');
    writeFileSync(other, 'not a transcript\n');
    const disguised = join(root, 'disguised.jsonl');
    symlinkSync(other, disguised);
    expect(
      await request(daemon.socketPath, { op: 'share', transcriptPath: disguised }),
    ).toMatchObject({ ok: false, error: '.jsonl 파일만 공유할 수 있어요' });

    const alias = join(root, 'alias.jsonl');
    symlinkSync(transcript, alias);
    const info = await openShare({ transcriptPath: alias });
    expect(info.transcriptPath).toBe(realpathSync(transcript));
  });

  it('IPC 요청 한도를 넘으면 거절하고 같은 데몬이 계속 답한다', async () => {
    const got = await rawExchange({ path: daemon.socketPath }, 'x'.repeat(MAX_REQUEST_BYTES + 1));
    expect(got).toContain('요청이 너무 커요');
    expect(await request(daemon.socketPath, { op: 'ping' })).toEqual({ ok: true, result: 'pong' });
  });

  it('URL로 안 읽히는 요청 대상에 500을 주고 데몬은 계속 돈다', async () => {
    const info = await openShare();
    const port = daemon.viewerPort!;
    const got = await rawExchange(
      { port },
      `GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
    );
    expect(got).toMatch(/^HTTP\/1\.1 500 /);
    expect((await fetchText(info.url)).status).toBe(200);
  });

  it(`공유 하나에 뷰어가 ${MAX_VIEWERS_PER_SHARE}명을 넘으면 429이고 하나가 나가면 다시 받는다`, async () => {
    const info = await openShare();
    const url = eventsUrl(info);
    const open = [];
    for (let i = 0; i < MAX_VIEWERS_PER_SHARE; i++) open.push(await openSse(url));
    try {
      expect(open.every((o) => o.status === 200)).toBe(true);
      expect((await fetchText(url)).status).toBe(429);

      const page = await fetchText(info.url);
      expect(page.body).toContain(`보는 사람 수 상한(${MAX_VIEWERS_PER_SHARE}명)`);

      open.pop()!.req.destroy();
      await new Promise((r) => setTimeout(r, 50));
      const again = await fetchText(url, (b) => b.includes('event: line'));
      expect(again.status).toBe(200);
    } finally {
      for (const o of open) o.req.destroy();
    }
  });

  it('앞부분이 큰 공유에 새 뷰어가 붙어도 끊지 않고 실시간 줄까지 보낸다', async () => {
    const chunk = 'lorem ipsum '.repeat(90_000);
    const big = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: `${i} ${chunk}` }],
        },
      }),
    );
    big.push(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '큰 기록 끝' }] },
      }),
    );
    writeFileSync(transcript, big.join('\n') + '\n');
    const info = await openShare({ tools: 'full' });
    for (let i = 0; i < 5; i++) daemon.tick();

    const body = await new Promise<string>((resolveP, reject) => {
      let text = '';
      let appended = false;
      const req = httpGet(eventsUrl(info), (res) => {
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
          if (!appended && text.includes('큰 기록 끝')) {
            appended = true;
            appendFileSync(
              transcript,
              JSON.stringify({
                type: 'assistant',
                message: { content: [{ type: 'text', text: '새 줄 도착' }] },
              }) + '\n',
            );
          }
          if (text.includes('새 줄 도착')) {
            req.destroy();
            resolveP(text);
          }
        });
        res.on('end', () => reject(new Error('뷰어 연결이 끊겼어요')));
      });
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
      });
    });
    expect(Buffer.byteLength(body)).toBeGreaterThan(8 * 1024 * 1024);
    expect(body).toContain('새 줄 도착');
  });

  it('한 줄이 바꾸다 던져도 tick은 안 던지고 다른 공유는 계속 돈다', async () => {
    const otherPath = join(root, 'other.jsonl');
    writeFileSync(otherPath, '');
    const a = await openShare();
    const b = await openShare({ transcriptPath: otherPath });

    const depth = 100_000;
    const nested = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
    appendFileSync(
      transcript,
      `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"X","input":${nested}}]}}\n`,
    );
    appendFileSync(
      otherPath,
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'b 답' }] },
      }) + '\n',
    );
    expect(() => daemon.tick()).not.toThrow();

    const list = await request<ShareInfo[]>(daemon.socketPath, { op: 'shares' });
    if (!list.ok) throw new Error(list.error);
    const byId = new Map(list.result.map((s) => [s.id, s]));
    expect(byId.get(a.id)).toMatchObject({ failedLines: 1, unknownLines: a.unknownLines });
    expect(byId.get(b.id)).toMatchObject({ events: 1 });
  });

  it('공유 하나의 poll이 던지면 그 공유만 error로 종료한다', async () => {
    const otherPath = join(root, 'other.jsonl');
    writeFileSync(otherPath, '');
    const a = await openShare();
    const b = await openShare({ transcriptPath: otherPath });
    const shares = (daemon as unknown as { shares: Map<string, { stream: { poll(): unknown } }> })
      .shares;
    shares.get(a.id)!.stream.poll = () => {
      throw new Error('boom');
    };
    expect(() => daemon.tick()).not.toThrow();

    const list = await request<ShareInfo[]>(daemon.socketPath, { op: 'shares' });
    expect(list.ok && list.result.map((s) => s.id)).toEqual([b.id]);
    await daemon.stop();
    const state = new PeerState(dbPath);
    expect(state.getShare(a.id)).toMatchObject({ closeReason: 'error' });
    state.close();
  });

  it('열린 IPC 연결이 있어도 stop이 끝난다', async () => {
    const idle = createConnection(daemon.socketPath);
    idle.on('error', () => {});
    await new Promise<void>((r) => idle.once('connect', () => r()));
    const started = Date.now();
    await daemon.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(() => statSync(daemon.socketPath)).toThrow();
  });
});

describe('PeerDaemon.start 실패', () => {
  it('IPC listen이 실패하면 뷰어와 DB만 닫고 다시 던진다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peer-fail-'));
    const dbPath = resolve('.gestalt-test', `peer-${randomUUID()}.db`);
    // 임시 소켓 이름 자리에 디렉토리가 있으면 listen이 실패한다
    mkdirSync(join(root, `${process.pid}.s`));
    const d = new PeerDaemon({ root, dbPath, home: FAKE_HOME });
    try {
      await expect(d.start()).rejects.toThrow();
      expect(d.viewerPort).toBeUndefined();
      // DB가 닫혔으면 같은 파일을 다시 열어 지울 수 있다
      const state = new PeerState(dbPath);
      state.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dbPath, { force: true });
    }
  });
});

describe('ensurePrivateDir', () => {
  it('루트가 심링크면 거부한다', () => {
    const base = mkdtempSync(join(tmpdir(), 'peer-link-'));
    try {
      const realDir = join(base, 'real');
      mkdirSync(realDir);
      const link = join(base, 'link');
      symlinkSync(realDir, link);
      expect(() => ensurePrivateDir(link)).toThrow('심링크');
      expect(() => ensurePrivateDir(realDir)).not.toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('request', () => {
  it('데몬이 없으면 DaemonUnavailableError로 실행 안내를 준다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'peer-none-'));
    try {
      await expect(request(join(dir, 'peer.sock'), { op: 'ping' })).rejects.toBeInstanceOf(
        DaemonUnavailableError,
      );
      await expect(request(join(dir, 'peer.sock'), { op: 'ping' })).rejects.toThrow(
        'gestalt peer daemon',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
