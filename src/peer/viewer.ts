import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { ShareFeed, ShareFrame } from './feed.js';
import { renderViewerHtml } from './viewer-html.js';
import { errMessage } from './errors.js';

export interface ViewerShare {
  stream: ShareFeed;
  token: string;
  /** 원격 공유를 보는 중이면 메시지를 보낼 수 있다. 내 공유에는 없다 */
  send?(text: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  /**
   * 원격 공유를 보는 중이면 주인 세션 모델의 질문에 답할 수 있다. 내 공유에는 없다. 이 함수가
   * PeerNetwork.answer를 불러 기기 키로 서명한다
   */
  answer?(
    question: string,
    text: string,
  ): Promise<{ ok: true; question: string } | { ok: false; error: string }>;
}

export interface ViewerHooks {
  lookup(id: string): ViewerShare | undefined;
  onConnect?(shareId: string): void;
  onDisconnect?(shareId: string): void;
}

const PAGE_PATH = /^\/s\/([A-Za-z0-9_-]{1,64})\/?$/;
const EVENTS_PATH = /^\/s\/([A-Za-z0-9_-]{1,64})\/events$/;
const MESSAGES_PATH = /^\/s\/([A-Za-z0-9_-]{1,64})\/messages$/;
const ANSWERS_PATH = /^\/s\/([A-Za-z0-9_-]{1,64})\/answers$/;

/** POST 본문 상한. 메시지 본문 16KB에 JSON 껍데기 여유를 둔다 */
const MAX_POST_BYTES = 64 * 1024;

/** SSE 연결이 프록시나 OS에서 놀다 끊기지 않게 보내는 빈 주석 간격 */
const KEEPALIVE_MS = 15_000;

/**
 * 공유 하나에 동시에 붙는 뷰어 상한. 넘으면 429. 뷰어 하나가 붙잡는 메모리는 소켓 버퍼로
 * 묶여 있지만 연결마다 소켓과 타이머가 생기니 토큰을 아는 쪽이 끝없이 열지 못하게 한다.
 * 사람이 보는 숫자로는 넉넉하다.
 */
export const MAX_VIEWERS_PER_SHARE = 16;

/**
 * 실시간 프레임을 쓰기 전에 소켓 버퍼에 이만큼 넘게 밀려 있으면 그 뷰어를 끊는다. 안 읽는
 * 뷰어 하나가 데몬 메모리를 끝없이 붙잡지 못하게 한다. 이보다 큰 이벤트 하나는 들어가지만
 * 소켓으로 다 빠지기 전에 다음 프레임이 오면 그때 끊는다. 앞부분은 소켓이 비는 만큼만 꺼내
 * 보내서 여기에 안 쌓인다. 브라우저는 다시 붙어 Last-Event-ID부터 받는다.
 */
export const MAX_LIVE_BACKLOG_BYTES = 8 * 1024 * 1024;

/** 앞부분을 공유에서 한 번에 꺼내는 양. 소켓이 차면 그 자리에서 멈추므로 대략이면 된다 */
export const REPLAY_CHUNK_BYTES = 256 * 1024;

export interface ViewerServerOptions {
  /** 테스트가 작게 준다 */
  maxLiveBacklogBytes?: number;
}

/**
 * 로컬 뷰어 HTTP 서버. `127.0.0.1`에만 붙는다.
 *
 * 같은 머신의 다른 프로세스나 브라우저에 열린 남의 웹페이지도 이 포트에 닿을 수 있다.
 * 그래서 공유마다 토큰을 주소에 붙이고 없거나 틀리면 401이다. 모르는 공유 id도 401로
 * 돌려준다 — 404와 401을 나누면 토큰 없이 공유 id가 살아 있는지 떠볼 수 있다.
 *
 * Routes:
 *   GET /s/:id?t=TOKEN          → 뷰어 HTML
 *   GET /s/:id/events?t=TOKEN   → SSE (line, trimmed, stats, state, closed, msg). 뷰어 상한을 넘으면 429.
 *                                 closed의 missed는 따라잡는 중에 공유가 종료돼 못 보낸 이벤트 수
 *   POST /s/:id/messages?t=TOKEN → 원격 공유에 메시지 보내기. JSON `{text}`만 받고 Origin이 이 뷰어여야 한다
 *   POST /s/:id/answers?t=TOKEN  → 주인 세션 모델의 질문에 답하기. JSON `{question, text}`, 검사는 messages와 같다
 *   *                           → 404
 */
export class ViewerServer {
  private server: Server | null = null;
  private open = new Set<ServerResponse>();
  private viewers = new Map<string, number>();
  private readonly maxLiveBacklogBytes: number;

  constructor(
    private readonly hooks: ViewerHooks,
    options: ViewerServerOptions = {},
  ) {
    this.maxLiveBacklogBytes = options.maxLiveBacklogBytes ?? MAX_LIVE_BACKLOG_BYTES;
  }

  start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        // 핸들러가 던지면 uncaughtException으로 데몬이 죽는다. 요청 대상이 `//[`처럼 URL로
        // 안 읽히면 new URL이 던지는데 이 포트에 닿는 누구나 그런 요청을 보낼 수 있다
        try {
          this.handle(req, res);
        } catch (err) {
          process.stderr.write(`[peer-viewer] request failed: ${errMessage(err)}\n`);
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
    if (req.method !== 'GET' && req.method !== 'POST') return plain(res, 405, 'Method Not Allowed');

    // DNS 리바인딩으로 남의 도메인이 이 포트를 가리키게 해도 Host가 달라서 막힌다
    if (!this.hostAllowed(req.headers.host)) return plain(res, 403, 'Forbidden');

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST') return this.post(req, res, url);
    const page = PAGE_PATH.exec(url.pathname);
    const events = page ? null : EVENTS_PATH.exec(url.pathname);
    const id = page?.[1] ?? events?.[1];
    if (!id) return plain(res, 404, 'Not Found');

    const share = this.hooks.lookup(id);
    if (!share || !tokenMatches(url.searchParams.get('t'), share.token)) {
      return plain(res, 401, 'Unauthorized');
    }

    if (page) return this.page(res, share.send !== undefined, share.answer !== undefined);
    if ((this.viewers.get(id) ?? 0) >= MAX_VIEWERS_PER_SHARE) {
      return plain(res, 429, 'Too Many Viewers');
    }
    return this.stream(req, res, share.stream);
  }

  private hostAllowed(host: string | undefined): boolean {
    if (!host) return false;
    const port = this.port;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  /**
   * 메시지 보내기. 브라우저에 열린 남의 페이지가 폼으로 쏘지 못하게 JSON만 받고 Origin을
   * 이 뷰어로 묶는다. 다른 출처의 fetch는 JSON이라 preflight가 나가는데 여기선 OPTIONS에
   * 답하지 않으므로 막힌다.
   */
  private post(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const m = MESSAGES_PATH.exec(url.pathname);
    const a = m ? null : ANSWERS_PATH.exec(url.pathname);
    const id = m?.[1] ?? a?.[1];
    if (!id) return plain(res, 404, 'Not Found');
    const share = this.hooks.lookup(id);
    if (!share || !tokenMatches(url.searchParams.get('t'), share.token)) {
      return plain(res, 401, 'Unauthorized');
    }
    if (req.headers.origin !== `http://${req.headers.host}`) return plain(res, 403, 'Forbidden');
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return plain(res, 415, 'Unsupported Media Type');
    }
    if (a) {
      const answer = share.answer;
      if (!answer) return json(res, 400, { error: '질문에 답할 수 없는 공유예요 (내 공유예요)' });
      return this.readJson(req, res, (parsed) => {
        const { question, text } = parsed as { question?: unknown; text?: unknown };
        if (typeof question !== 'string' || typeof text !== 'string') {
          return json(res, 400, { error: 'question과 text가 필요해요' });
        }
        answer(question, text).then(
          (r) =>
            r.ok ? json(res, 202, { question: r.question }) : json(res, 400, { error: r.error }),
          (err: unknown) => json(res, 500, { error: errMessage(err) }),
        );
      });
    }
    if (!share.send) {
      return json(res, 400, {
        error: '메시지를 넣을 수 없는 공유예요 (내 공유이거나 주인이 막았어요)',
      });
    }
    const send = share.send;
    this.readJson(req, res, (parsed) => {
      const text = (parsed as { text?: unknown }).text;
      if (typeof text !== 'string') return json(res, 400, { error: 'text가 없어요' });
      send(text).then(
        (r) => (r.ok ? json(res, 202, { id: r.id }) : json(res, 400, { error: r.error })),
        (err: unknown) => json(res, 500, { error: errMessage(err) }),
      );
    });
  }

  /** POST 본문을 상한 안에서 읽어 JSON 객체로 넘긴다. 넘거나 JSON 객체가 아니면 여기서 답한다 */
  private readJson(
    req: IncomingMessage,
    res: ServerResponse,
    onBody: (parsed: object) => void,
  ): void {
    let body = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (tooBig) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_POST_BYTES) {
        tooBig = true;
        json(res, 413, { error: '본문이 너무 커요' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(res, 400, { error: 'JSON이 아니에요' });
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return json(res, 400, { error: 'JSON 객체가 아니에요' });
      }
      onBody(parsed);
    });
  }

  private page(res: ServerResponse, canSend: boolean, canAnswer: boolean): void {
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
    res.end(renderViewerHtml(nonce, MAX_VIEWERS_PER_SHARE, canSend, canAnswer));
  }

  private stream(req: IncomingMessage, res: ServerResponse, stream: ShareFeed): void {
    const lastId = Number.parseInt(String(req.headers['last-event-id'] ?? '0'), 10);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      ...PRIVATE_HEADERS,
    });
    res.write(': connected\n\n');
    this.open.add(res);
    this.viewers.set(stream.id, (this.viewers.get(stream.id) ?? 0) + 1);
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
      const left = (this.viewers.get(stream.id) ?? 1) - 1;
      if (left > 0) this.viewers.set(stream.id, left);
      else this.viewers.delete(stream.id);
      this.hooks.onDisconnect?.(stream.id);
    };

    req.on('close', detach);
    res.on('close', detach);

    const onFrame = (frame: ShareFrame): void => {
      if (detached) return;
      if (res.writableLength > this.maxLiveBacklogBytes) {
        res.destroy();
        detach();
        return;
      }
      res.write(sseFrame(frame));
      if (frame.type === 'closed') {
        res.end();
        detach();
      }
    };

    // 앞부분은 소켓이 비는 만큼씩 꺼내 쓴다. 다 따라잡으면 이벤트 루프로 돌아가지 않고 바로
    // subscribe로 붙어서 그 사이에 poll이 끼지 않는다. subscribe가 상태와 통계를 다시 보내
    // 따라잡는 동안 바뀐 것도 맞춘다. 기다리는 사이 공유가 종료되면 subscribe가 못 보낸 개수를
    // closed에 실어 보낸다
    let cursor = Number.isFinite(lastId) && lastId > 0 ? lastId : 0;
    const pump = (): void => {
      if (detached) return;
      while (!stream.isClosed) {
        const { dropped, items } = stream.backlogAfter(cursor, REPLAY_CHUNK_BYTES);
        if (dropped > 0) {
          res.write(sseFrame({ type: 'trimmed', dropped }));
          cursor += dropped;
        }
        if (items.length === 0) break;
        for (const item of items) {
          cursor = item.seq;
          if (!res.write(sseFrame({ type: 'event', ...item }))) {
            res.once('drain', pump);
            return;
          }
        }
      }
      unsubscribe = stream.subscribe(onFrame, cursor);
      if (detached) unsubscribe();
    };

    res.write(sseFrame({ type: 'state', status: stream.currentStatus }));
    res.write(sseFrame({ type: 'stats', unknownLines: stream.unknownLines }));
    pump();
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

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...PRIVATE_HEADERS });
  res.end(JSON.stringify(body));
}

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
      return `id: ${frame.seq}\nevent: line\ndata: ${frame.json}\n\n`;
    case 'stats':
      return `event: stats\ndata: ${JSON.stringify({ unknownLines: frame.unknownLines })}\n\n`;
    case 'state':
      return `event: state\ndata: ${JSON.stringify({ status: frame.status })}\n\n`;
    case 'closed':
      return `event: closed\ndata: ${JSON.stringify({ reason: frame.reason, missed: frame.missed })}\n\n`;
    case 'trimmed':
      return `event: trimmed\ndata: ${JSON.stringify({ dropped: frame.dropped })}\n\n`;
    case 'msg': {
      const { type: _t, ...rest } = frame;
      return `event: msg\ndata: ${JSON.stringify(rest)}\n\n`;
    }
    case 'ask': {
      const { type: _t, ...rest } = frame;
      return `event: ask\ndata: ${JSON.stringify(rest)}\n\n`;
    }
  }
}
