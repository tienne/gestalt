import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, sep } from 'node:path';
import { log } from '../core/log.js';
import { askFitsIr, frameLiveAsk, liveAskSchema } from './live-ask.js';
import {
  ARCHITECTURE_LIVE_HOST,
  DEFAULT_ARCHITECTURE_LIVE_PORT,
  LIVE_ASK_PATH,
  LIVE_STATUS_PATH,
  LIVE_TOKEN_HEADER,
  LIVE_TOKEN_META,
  liveConnectSrc,
  liveOrigin,
} from './live-port.js';

export { LIVE_ASK_PATH, LIVE_STATUS_PATH, LIVE_TOKEN_HEADER, LIVE_TOKEN_META };
import { defaultLiveSessionBridge, type LiveSessionBridge } from './live-session.js';
import { ArchitectureStore } from './store.js';
import { ARCHITECTURE_VIEWS, type ArchitectureView } from './types.js';

/** 질문 본문 상한. 정해 둔 칸 몇 개라 이보다 크면 잘못 온 요청이다 */
const ASK_MAX_BYTES = 2 * 1024;
/** 1분 동안 세션에 넣는 질문 수 상한. 연달아 보내도 세션이 질문으로 덮이지 않게 둔다 */
const ASK_RATE_LIMIT = 6;
const ASK_RATE_WINDOW_MS = 60_000;
/** 같은 질문을 다시 넣지 않는 시간. 탭을 여럿 열어 같은 질문을 보낸 경우를 합친다 */
const ASK_DEDUP_MS = 2 * 60_000;

/** 질문 응답 코드. 이유 글자는 싣지 않고 이 코드만 돌려준다. 자세한 이유는 stderr에 남긴다 */
export type LiveAskCode =
  | 'sent'
  | 'forbidden'
  | 'bad_request'
  | 'too_large'
  | 'unsupported_media_type'
  | 'rate_limited'
  | 'unknown_target'
  | 'no_session'
  | 'send_failed';

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

const CSP_META = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/;

function safeDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function isView(name: string): name is ArchitectureView {
  return (ARCHITECTURE_VIEWS as readonly string[]).includes(name);
}

export interface ArchitectureLiveServerOptions {
  /** 시작 포트. 차 있으면 다음 포트로 넘어간다 */
  port?: number;
  /** 빈 포트를 찾는 횟수 */
  attempts?: number;
}

export interface ArchitectureLiveServerDeps {
  /** 세션 찾기와 글 넣기. 테스트가 바꿔 끼운다 */
  session?: LiveSessionBridge;
  now?: () => number;
}

/**
 * `<repoRoot>/.gestalt/architecture/` 바로 아래 본인용 그림 HTML(`<그림>.html`)만 내주는 127.0.0.1 서버.
 * 뷰어가 라이브 Ask로 세션과 주고받으려면 file://이 아니라 http 출처가 있어야 해서 둔다.
 * 공유본(`.shared.html`)과 IR JSON, 하위 디렉토리는 내주지 않는다
 */
export class ArchitectureLiveServer {
  protected server: Server | null = null;
  protected readonly dir: string;
  // 페이지에만 싣는 토큰. 디스크에 쓰지 않아서 서버를 다시 띄우면 바뀐다
  protected readonly token = randomBytes(32).toString('base64url');
  private readonly tokenDigest = sha256(this.token);
  // 뷰어가 HEAD로 ETag를 계속 본다. 파일이 그대로면 다시 읽지 않고 토큰을 끼운 길이를 쓴다
  private readonly htmlLengths = new Map<
    string,
    { mtimeMs: number; size: number; length: number }
  >();

  private readonly session: LiveSessionBridge;
  private readonly now: () => number;
  private readonly store: ArchitectureStore;
  private askTimes: number[] = [];
  private readonly recentAsks = new Map<string, number>();

  constructor(
    readonly repoRoot: string,
    deps: ArchitectureLiveServerDeps = {},
  ) {
    this.dir = join(repoRoot, '.gestalt', 'architecture');
    this.now = deps.now ?? Date.now;
    this.session = deps.session ?? defaultLiveSessionBridge(this.now);
    this.store = new ArchitectureStore(repoRoot);
  }

  /** 기본 포트부터 빈 포트를 찾아 127.0.0.1에 묶는다. 이미 떠 있으면 그대로 둔다 */
  async start(opts: ArchitectureLiveServerOptions = {}): Promise<number> {
    if (this.server && this.port !== undefined) return this.port;
    const first = opts.port ?? DEFAULT_ARCHITECTURE_LIVE_PORT;
    const attempts = opts.attempts ?? 20;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.listen(first + i);
        return this.port!;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      }
    }
    throw new Error(`${first}부터 ${first + attempts - 1}까지 빈 포트가 없어요.`);
  }

  private listen(port: number): Promise<void> {
    return new Promise((done, reject) => {
      const server = createServer((req, res) => {
        try {
          this.handle(req, res);
        } catch (err) {
          log(`[architecture-live] request failed: ${(err as Error).message}`);
          if (!res.headersSent) res.writeHead(500, BASE_HEADERS);
          res.end();
        }
      });
      server.once('error', reject);
      server.listen(port, ARCHITECTURE_LIVE_HOST, () => {
        server.off('error', reject);
        // MCP 서버가 끝날 때 이 서버가 프로세스를 붙잡지 않게 한다
        server.unref();
        this.server = server;
        done();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((done, reject) => {
      const server = this.server;
      if (!server) return done();
      this.server = null;
      server.closeAllConnections?.();
      server.close((err) => (err ? reject(err) : done()));
    });
  }

  get port(): number | undefined {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : undefined;
  }

  get running(): boolean {
    return this.server !== null && this.port !== undefined;
  }

  /** 서버 출처. 떠 있지 않으면 undefined */
  get url(): string | undefined {
    const port = this.port;
    return port === undefined ? undefined : liveOrigin(port);
  }

  /** 그림 하나를 라이브로 여는 주소. 떠 있지 않으면 undefined */
  liveUrl(view: ArchitectureView): string | undefined {
    const url = this.url;
    return url === undefined ? undefined : `${url}/${view}.html`;
  }

  /** 거부 응답. 이유는 응답에 싣지 않고 stderr에만 남긴다 */
  protected deny(res: ServerResponse, status: number, reason: string): void {
    log(`[architecture-live] ${status} ${reason}`);
    res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(status));
  }

  protected validToken(req: IncomingMessage): boolean {
    const given = req.headers[LIVE_TOKEN_HEADER];
    return typeof given === 'string' && timingSafeEqual(sha256(given), this.tokenDigest);
  }

  protected handle(req: IncomingMessage, res: ServerResponse): void {
    const port = this.port;
    // 127.0.0.1에만 묶어도 DNS 리바인딩이면 남의 이름으로 여기 닿는다. 포트까지 같은 Host만 받는다
    if (port === undefined || req.headers.host !== `${ARCHITECTURE_LIVE_HOST}:${port}`) {
      req.resume();
      return this.deny(res, 403, `host ${String(req.headers.host)}`);
    }
    const [path] = (req.url ?? '/').split('?');
    if (this.handleApi(req, res, path!)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.resume();
      res.setHeader('Allow', 'GET, HEAD');
      return this.deny(res, 405, `method ${String(req.method)}`);
    }
    this.serveHtml(req, res, path!);
  }

  /** 정적 파일이 아닌 경로를 처리했으면 true */
  protected handleApi(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    if (path === LIVE_STATUS_PATH) {
      req.resume();
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        this.deny(res, 405, `status method ${String(req.method)}`);
      } else if (!this.validToken(req)) {
        this.deny(res, 403, 'status token');
      } else {
        this.json(res, 200, { session: this.sessionAlive() });
      }
      return true;
    }
    if (path === LIVE_ASK_PATH) {
      if (req.method !== 'POST') {
        req.resume();
        res.setHeader('Allow', 'POST');
        this.deny(res, 405, `ask method ${String(req.method)}`);
      } else {
        this.handleAsk(req, res);
      }
      return true;
    }
    return false;
  }

  /** 그림을 띄운 세션을 지금 찾을 수 있는지. 찾다가 던지면 꺼진 것으로 본다 */
  sessionAlive(): boolean {
    try {
      return this.session.alive();
    } catch (err) {
      log(`[architecture-live] session lookup failed: ${(err as Error).message}`);
      return false;
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  private reply(res: ServerResponse, status: number, code: LiveAskCode, reason?: string): void {
    if (reason) log(`[architecture-live] ask ${status} ${reason}`);
    this.json(res, status, { code });
  }

  /**
   * 뷰어 질문을 받아 세션에 넣는다. 127.0.0.1 서버라도 브라우저에 열린 아무 사이트가 여기로 POST할 수 있어서
   * Origin과 페이지에만 실은 토큰을 둘 다 본다. JSON 본문이라 다른 출처에서 보내면 사전 요청(OPTIONS)부터
   * 405로 막힌다. 세션에 들어가는 글은 검사를 통과한 값으로 서버가 다시 조립한다
   */
  private handleAsk(req: IncomingMessage, res: ServerResponse): void {
    if (req.headers.origin !== liveOrigin(this.port!)) {
      req.resume();
      return this.reply(res, 403, 'forbidden', `origin ${String(req.headers.origin)}`);
    }
    if (!this.validToken(req)) {
      req.resume();
      return this.reply(res, 403, 'forbidden', 'token');
    }
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') {
      req.resume();
      return this.reply(res, 415, 'unsupported_media_type', type);
    }
    if (Number(req.headers['content-length'] ?? 0) > ASK_MAX_BYTES) {
      req.resume();
      return this.reply(res, 413, 'too_large', 'content-length');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > ASK_MAX_BYTES) {
        over = true;
        // 남은 본문을 받지 않고 끊는다. 응답을 다 보낸 뒤에 끊어야 뷰어가 413을 받는다
        res.setHeader('Connection', 'close');
        res.once('finish', () => req.destroy());
        this.reply(res, 413, 'too_large', 'body');
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => res.destroy());
    req.on('end', () => {
      if (over) return;
      void this.dispatchAsk(Buffer.concat(chunks).toString('utf8'), res).catch((err) => {
        log(`[architecture-live] ask failed: ${(err as Error).message}`);
        if (!res.headersSent) this.reply(res, 500, 'send_failed');
      });
    });
  }

  private async dispatchAsk(raw: string, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return this.reply(res, 400, 'bad_request', 'json');
    }
    const parsed = liveAskSchema.safeParse(body);
    if (!parsed.success) return this.reply(res, 400, 'bad_request', 'schema');
    const ask = parsed.data;
    if (!ask.question.trim()) return this.reply(res, 400, 'bad_request', 'empty question');
    // 그림과 노드는 뷰어가 보낸 값을 믿지 않고 저장 IR에서 확인한다
    if (!askFitsIr(ask, this.store.load(ask.view))) {
      return this.reply(res, 404, 'unknown_target', `${ask.view} ${String(ask.node)}`);
    }
    const now = this.now();
    const key = JSON.stringify([ask.view, ask.level, ask.node, ask.question.trim()]);
    for (const [k, at] of this.recentAsks) {
      if (now - at >= ASK_DEDUP_MS) this.recentAsks.delete(k);
    }
    if (this.recentAsks.has(key)) return this.reply(res, 200, 'sent');
    // 속도 제한은 세션에 넣을 질문만 센다. 잘못 온 요청이나 합친 질문이 몫을 깎지 않는다
    this.askTimes = this.askTimes.filter((t) => now - t < ASK_RATE_WINDOW_MS);
    if (this.askTimes.length >= ASK_RATE_LIMIT) return this.reply(res, 429, 'rate_limited', 'rate');
    this.askTimes.push(now);
    const sent = await this.session.send(frameLiveAsk(ask));
    if (sent.ok) {
      this.recentAsks.set(key, now);
      return this.reply(res, 200, 'sent');
    }
    return this.reply(res, 503, sent.code, sent.reason);
  }

  private serveHtml(req: IncomingMessage, res: ServerResponse, path: string): void {
    const decoded = safeDecode(path);
    if (decoded === null || decoded.includes('\0')) return this.deny(res, 400, 'bad path');
    // 파일 이름을 그림 이름 목록으로만 고른다. 공유본, json, delta, 하위 디렉토리, ..는 여기서 다 빠진다
    const m = /^\/([a-z-]+)\.html$/.exec(decoded);
    if (!m || !isView(m[1]!)) return this.deny(res, 404, `not served ${decoded}`);
    const target = join(this.dir, `${m[1]!}.html`);
    if (!existsSync(target)) return this.deny(res, 404, `missing ${decoded}`);
    let real: string;
    let root: string;
    try {
      real = realpathSync(target);
      root = realpathSync(this.dir);
    } catch {
      return this.deny(res, 404, `unreadable ${decoded}`);
    }
    // 심링크로 디렉토리 밖을 가리키는 경우까지 막으려고 실제 경로로 비교한다
    if (!real.startsWith(root + sep) || !statSync(real).isFile()) {
      return this.deny(res, 404, `outside ${decoded}`);
    }
    // ETag는 디스크 파일의 수정 시각과 크기로 만든다. 라이브 스크립트가 HEAD로 이 값이 바뀌는지 본다
    const { mtimeMs, size } = statSync(real);
    const known = this.htmlLengths.get(real);
    const fresh = known && known.mtimeMs === mtimeMs && known.size === size;
    const body =
      req.method === 'HEAD' && fresh
        ? null
        : Buffer.from(this.prepare(readFileSync(real, 'utf8')), 'utf8');
    if (body) this.htmlLengths.set(real, { mtimeMs, size, length: body.length });
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(body ? body.length : known!.length),
      ETag: `"${Math.floor(mtimeMs)}-${size}"`,
      // meta로는 못 거는 frame-ancestors만 헤더로 더한다. 나머지는 페이지 meta 정책이 그대로 돈다
      'Content-Security-Policy': "frame-ancestors 'none'",
    });
    res.end(req.method === 'HEAD' || !body ? undefined : body);
  }

  /**
   * 내줄 HTML을 고친다. 토큰 meta를 첫 `</head>` 앞에 끼우고 실제 포트가 기본값과 다르면
   * CSP meta의 connect-src만 그 포트로 바꾼다. 디스크 파일은 건드리지 않는다
   */
  private prepare(html: string): string {
    const port = this.port!;
    let out = html;
    if (port !== DEFAULT_ARCHITECTURE_LIVE_PORT) {
      out = out.replace(CSP_META, (meta) => meta.replace(liveConnectSrc(), liveConnectSrc(port)));
    }
    const at = out.indexOf('</head>');
    if (at < 0) return out;
    return `${out.slice(0, at)}<meta name="${LIVE_TOKEN_META}" content="${this.token}">\n${out.slice(at)}`;
  }
}
