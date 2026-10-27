import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { get as httpGet, request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PeerDaemon } from '../../../src/peer/daemon.js';
import { DaemonUnavailableError, request } from '../../../src/peer/client.js';
import { PeerState } from '../../../src/peer/state.js';
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
    expect(page.body).toContain('비밀값 패턴은 가리지만 전부 잡지는 못합니다');
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

  it('데몬이 떠 있는데 또 띄우면 거절한다', async () => {
    const second = new PeerDaemon({ root, dbPath, home: FAKE_HOME });
    await expect(second.start()).rejects.toThrow('이미 떠 있어요');
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
