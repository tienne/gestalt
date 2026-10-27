import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { ShareFrame, ShareStream } from './share.js';
import { renderViewerHtml } from './viewer-html.js';

export interface ViewerShare {
  stream: ShareStream;
  token: string;
}

export interface ViewerHooks {
  lookup(id: string): ViewerShare | undefined;
  onConnect?(shareId: string): void;
  onDisconnect?(shareId: string): void;
}

const PAGE_PATH = /^\/s\/([A-Za-z0-9_-]{1,64})\/?$/;
const EVENTS_PATH = /^\/s\/([A-Za-z0-9_-]{1,64})\/events$/;

/** SSE 연결이 프록시나 OS에서 놀다 끊기지 않게 보내는 빈 주석 간격 */
const KEEPALIVE_MS = 15_000;

/**
 * 로컬 뷰어 HTTP 서버. `127.0.0.1`에만 붙는다.
 *
 * 같은 머신의 다른 프로세스나 브라우저에 열린 남의 웹페이지도 이 포트에 닿을 수 있다.
 * 그래서 공유마다 토큰을 주소에 붙이고 없거나 틀리면 401이다. 모르는 공유 id도 401로
 * 돌려준다 — 404와 401을 나누면 토큰 없이 공유 id가 살아 있는지 떠볼 수 있다.
 *
 * Routes:
 *   GET /s/:id?t=TOKEN          → 뷰어 HTML
 *   GET /s/:id/events?t=TOKEN   → SSE (line, trimmed, stats, state, closed)
 *   *                           → 404
 */
export class ViewerServer {
  private server: Server | null = null;
  private open = new Set<ServerResponse>();

  constructor(private readonly hooks: ViewerHooks) {}

  start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        // 핸들러가 던지면 uncaughtException으로 데몬이 죽는다. 깨진 퍼센트 인코딩 하나로
        // 남의 웹페이지가 데몬을 내릴 수 있으므로 여기서 접는다
        try {
          this.handle(req, res);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[peer-viewer] request failed: ${msg}\n`);
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Internal Server Error');
        }
      });
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server!.off('error', reject);
        this.server!.on('error', (err) => {
          process.stderr.write(`[peer-viewer] server error: ${err.message}\n`);
        });
        resolve(this.port!);
      });
    });
  }

  get port(): number | undefined {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : undefined;
  }

  stop(): Promise<void> {
    for (const res of this.open) res.end();
    this.open.clear();
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.closeAllConnections?.();
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') return plain(res, 405, 'Method Not Allowed');

    // DNS 리바인딩으로 남의 도메인이 이 포트를 가리키게 해도 Host가 달라서 막힌다
    if (!this.hostAllowed(req.headers.host)) return plain(res, 403, 'Forbidden');

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const page = PAGE_PATH.exec(url.pathname);
    const events = page ? null : EVENTS_PATH.exec(url.pathname);
    const id = page?.[1] ?? events?.[1];
    if (!id) return plain(res, 404, 'Not Found');

    const share = this.hooks.lookup(id);
    if (!share || !tokenMatches(url.searchParams.get('t'), share.token)) {
      return plain(res, 401, 'Unauthorized');
    }

    if (page) return this.page(res);
    return this.stream(req, res, share.stream);
  }

  private hostAllowed(host: string | undefined): boolean {
    if (!host) return false;
    const port = this.port;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  private page(res: ServerResponse): void {
    const nonce = randomBytes(16).toString('base64');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
      ...PRIVATE_HEADERS,
    });
    res.end(renderViewerHtml(nonce));
  }

  private stream(req: IncomingMessage, res: ServerResponse, stream: ShareStream): void {
    const lastId = Number.parseInt(String(req.headers['last-event-id'] ?? '0'), 10);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      ...PRIVATE_HEADERS,
    });
    res.write(': connected\n\n');
    this.open.add(res);
    this.hooks.onConnect?.(stream.id);

    const keepalive = setInterval(() => res.write(': ping\n\n'), KEEPALIVE_MS);
    keepalive.unref();

    let detached = false;
    let unsubscribe: () => void = () => {};
    const detach = (): void => {
      if (detached) return;
      detached = true;
      clearInterval(keepalive);
      unsubscribe();
      this.open.delete(res);
      this.hooks.onDisconnect?.(stream.id);
    };

    unsubscribe = stream.subscribe(
      (frame) => {
        res.write(sseFrame(frame));
        if (frame.type === 'closed') {
          res.end();
          detach();
        }
      },
      Number.isFinite(lastId) && lastId > 0 ? lastId : 0,
    );
    if (detached) unsubscribe();
    req.on('close', detach);
  }
}

/**
 * 뷰어는 디스크에 아무것도 남기지 않아야 한다. 브라우저 캐시도 디스크다.
 */
const PRIVATE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

function plain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...PRIVATE_HEADERS });
  res.end(body);
}

function tokenMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sseFrame(frame: ShareFrame): string {
  switch (frame.type) {
    case 'event':
      return `id: ${frame.seq}\nevent: line\ndata: ${JSON.stringify(frame.event)}\n\n`;
    case 'stats':
      return `event: stats\ndata: ${JSON.stringify({ unknownLines: frame.unknownLines })}\n\n`;
    case 'state':
      return `event: state\ndata: ${JSON.stringify({ status: frame.status })}\n\n`;
    case 'closed':
      return `event: closed\ndata: ${JSON.stringify({ reason: frame.reason })}\n\n`;
    case 'trimmed':
      return `event: trimmed\ndata: ${JSON.stringify({ dropped: frame.dropped })}\n\n`;
  }
}
