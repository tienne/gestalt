import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseTranscript, type SourceKind } from './schema.js';
import {
  frameSessionRequest,
  sendToSession,
  sessionRequestSchema,
  type SendResult,
} from './session-request.js';
import { isValidSlug, readRaw } from './store.js';
import { templateFitsKind, templateKindOf, type DigestTemplate } from './templates.js';
import { THEME_BOOT_JS_SHA256, VIEWER_JS_SHA256 } from './viewer-js.js';

export const DEFAULT_DIGEST_PORT = 7893;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

const VIDEO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  // 읽기 렌즈 팟캐스트는 같은 길로 내려받은 오디오를 내준다
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
};

/** inCache면 <slug>/cache/ 안의 파일만 내준다 */
interface VideoMedia {
  file: string;
  inCache: boolean;
}

export type ByteRange = { start: number; end: number } | 'none' | 'unsatisfiable';

/**
 * Range 헤더에서 단일 바이트 구간만 받는다. 꼴이 틀렸거나 여러 구간이면 무시하고 전체를 내준다(RFC 9110 14.2)
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (m[1] === '' && m[2] === '')) return 'none';
  if (m[1] === '') {
    const suffix = Number(m[2]!);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]!);
  // 끝이 시작보다 앞이면 문법 오류라 무시한다. 끝을 size에 맞춰 자르기 전에 봐야 bytes=5-999 같은 정상 요청이 안 빠진다
  if (m[2] !== '' && Number(m[2]!) < start) return 'none';
  if (start >= size) return 'unsatisfiable';
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]!), size - 1);
  return { start, end };
}

// 유튜브 IFrame API가 스크립트와 iframe을 함께 끌어와서 그 둘만 밖으로 연다.
// 렌더가 싣는 실행 스크립트는 테마를 먼저 붙이는 THEME_BOOT_JS와 VIEWER_JS 둘이라 해시로 고정한다. 데이터 블록은 type이 JSON이라 실행되지 않는다.
// 다이어리 테마(theme-diary.ts)의 손글씨 제목 글꼴은 영상 요약과 렌즈 모두 구글 폰트에서 받아서 스타일시트와 글꼴 파일 주소를 연다
// GESTALT_DIGEST_EXTERNAL_FONTS로 끄면 렌더가 링크를 빼고 CSP는 그대로 둔다. 이미 렌더한 HTML의 링크가 막히지 않게 하려는 것이다
export const DIGEST_CSP = [
  "default-src 'self'",
  `script-src 'self' 'sha256-${THEME_BOOT_JS_SHA256}' 'sha256-${VIEWER_JS_SHA256}' https://www.youtube.com https://s.ytimg.com`,
  'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
  "img-src 'self' data: https://i.ytimg.com",
  "media-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // referrer를 아예 안 보내면 유튜브 임베드가 153 오류로 막힌다
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cache-Control': 'no-store',
};

/** 뷰어가 세션에 리포트를 만들어 달라고 넣는 자리. 정적 파일 경로와 겹치지 않게 확장자 없는 이름을 쓴다 */
export const REQUEST_PATH = '/__request';
/** 서버가 페이지에 끼워 넣는 토큰 meta 이름. 뷰어가 이걸 읽어 요청 헤더에 싣는다 */
export const TOKEN_META_NAME = 'gestalt-serve-token';
const TOKEN_HEADER = 'x-gestalt-token';
/** 요청 본문 상한. 정해 둔 필드 몇 개라 이보다 크면 잘못 온 요청이다 */
const REQUEST_MAX_BYTES = 2 * 1024;
/** 1분 동안 세션에 넣는 요청 수 상한. 버튼을 연달아 눌러도 세션이 요청으로 덮이지 않게 둔다 */
const REQUEST_RATE_LIMIT = 6;
const REQUEST_RATE_WINDOW_MS = 60_000;

/** 요청 응답 코드. 이유 글자나 경로는 싣지 않고 이 코드만 돌려준다. 자세한 이유는 serve의 stderr에 남긴다 */
export type RequestCode =
  | 'sent'
  | 'forbidden'
  | 'bad_request'
  | 'too_large'
  | 'unsupported_media_type'
  | 'rate_limited'
  | 'unknown_slug'
  | 'unknown_template'
  | 'no_session'
  | 'send_failed';

export interface DigestServerOptions {
  /** 템플릿 요청에서 받아도 되는 템플릿. 없으면 템플릿 요청을 모두 거절한다 */
  templates?: Pick<DigestTemplate, 'id' | 'kinds'>[];
  /** 세션에 글을 넣는다. 테스트가 바꿔 끼운다 */
  sendToSession?: (text: string) => Promise<SendResult>;
  now?: () => number;
  /**
   * 127.0.0.1과 localhost 말고 받을 Host 이름. 테일스케일 serve처럼 내 기기에서 앞단 프록시를 거쳐
   * 들어오는 이름을 사람이 직접 넘길 때만 쓴다. 이 이름의 https 출처와 포트 붙은 http 출처도 버튼 요청에서 받는다
   */
  allowHosts?: string[];
}

/** --allow-host로 받는 이름 꼴. 포트와 경로, 와일드카드 없이 호스트 이름만 받는다 */
export const isAllowableHost = (name: string): boolean =>
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
    name,
  );

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createNetServer();
    probe.once('error', () => done(false));
    probe.once('listening', () => probe.close(() => done(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/** graph-viz는 7891, pr serve는 7892를 쓴다. 겹치지 않게 7893부터 찾는다 */
export async function findDigestPort(start = DEFAULT_DIGEST_PORT, attempts = 20): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    if (await isPortAvailable(start + i)) return start + i;
  }
  throw new Error(`${start}부터 ${start + attempts - 1}까지 빈 포트가 없어요.`);
}

function safeDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * `.gestalt/digest/` 아래 렌더 결과만 내주는 읽기 전용 서버.
 * 뷰어가 유튜브 IFrame API를 쓰려면 file://이 아니라 http 출처가 있어야 해서 둔다.
 */
export class DigestServer {
  private server: Server | null = null;
  private readonly root: string;
  // 영상은 Range 요청이 연달아 와서 transcript.json을 매번 파싱하지 않는다. 파일이 바뀌면 mtime으로 다시 읽는다
  private readonly videoPaths = new Map<string, { mtimeMs: number; media: VideoMedia | null }>();
  // 페이지에만 싣는 토큰. 디스크에 쓰지 않아서 serve를 다시 띄우면 바뀐다
  private readonly token = randomBytes(32).toString('base64url');
  private readonly tokenDigest = sha256(this.token);
  private readonly templates: Pick<DigestTemplate, 'id' | 'kinds'>[];
  private readonly send: (text: string) => Promise<SendResult>;
  private readonly now: () => number;
  private readonly hosts: Set<string>;
  private requestTimes: number[] = [];

  constructor(root: string, opts: DigestServerOptions = {}) {
    this.root = realpathSync(root);
    this.templates = opts.templates ?? [];
    this.send = opts.sendToSession ?? ((text) => sendToSession(text));
    this.now = opts.now ?? Date.now;
    for (const h of opts.allowHosts ?? []) {
      if (!isAllowableHost(h)) throw new Error(`호스트 이름 꼴이 아니에요: ${h}`);
    }
    this.hosts = new Set(['127.0.0.1', 'localhost', ...(opts.allowHosts ?? [])]);
  }

  start(port: number): Promise<void> {
    return new Promise((resolveStart, reject) => {
      this.server = createServer((req, res) => {
        try {
          this.handle(req, res);
        } catch (err) {
          process.stderr.write(`[digest] request failed: ${(err as Error).message}\n`);
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Internal Server Error');
        }
      });
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server!.off('error', reject);
        resolveStart();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((done, reject) => {
      if (!this.server) return done();
      this.server.close((err) => {
        this.server = null;
        if (err) reject(err);
        else done();
      });
    });
  }

  get port(): number | undefined {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : undefined;
  }

  private deny(
    res: ServerResponse,
    status: number,
    text: string,
    extra: Record<string, string> = {},
  ) {
    res.writeHead(status, {
      ...BASE_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      ...extra,
    });
    res.end(text);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const isRequest = req.method === 'POST' && (req.url ?? '') === REQUEST_PATH;
    if (!isRequest && req.method !== 'GET' && req.method !== 'HEAD') {
      return this.deny(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    }
    // 127.0.0.1에만 바인딩해도 DNS 리바인딩이면 남의 이름으로 여기 닿는다
    const host = (req.headers.host ?? '').split(':')[0]!.toLowerCase();
    if (!this.hosts.has(host)) return this.deny(res, 403, 'Forbidden');
    if (isRequest) return this.handleRequest(req, res);

    const decoded = safeDecode((req.url ?? '/').split('?')[0]!);
    if (decoded === null || decoded.includes('\0')) return this.deny(res, 400, 'Bad Request');
    const rel = decoded.endsWith('/') ? `${decoded}digest.html` : decoded;
    const parts = rel.split('/');
    if (parts.length === 3 && parts[0] === '' && parts[2] === 'video' && isValidSlug(parts[1]!)) {
      return this.serveVideo(req, res, parts[1]!);
    }
    const ext = extname(rel).toLowerCase();
    // 받아 둔 영상(cache/)과 원본 JSON은 뷰어가 쓰지 않으니 내주지 않는다
    if (!MIME[ext] || rel.split('/').includes('cache')) return this.deny(res, 404, 'Not Found');

    const target = join(this.root, rel);
    if (!existsSync(target)) return this.deny(res, 404, 'Not Found');
    // 심링크로 루트 밖을 가리키는 경우까지 막으려고 실제 경로로 비교한다
    const real = realpathSync(target);
    if (!real.startsWith(this.root + sep) || !statSync(real).isFile()) {
      return this.deny(res, 404, 'Not Found');
    }

    if (ext === '.html') {
      // 토큰은 디스크의 HTML에 쓰지 않고 내줄 때만 끼운다. HEAD도 같은 길이를 알린다
      const body = Buffer.from(this.withToken(readFileSync(real, 'utf8')), 'utf8');
      res.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': MIME[ext]!,
        'Content-Security-Policy': DIGEST_CSP,
        'Content-Length': String(body.length),
      });
      return void res.end(req.method === 'HEAD' ? undefined : body);
    }
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': MIME[ext]! });
    if (req.method === 'HEAD') return void res.end();
    this.stream(res, real);
  }

  /** 첫 </head> 앞에 토큰 meta를 끼운다. head가 없는 HTML이면 그대로 둔다. 그 페이지는 복사 모드로 돈다 */
  private withToken(html: string): string {
    const at = html.indexOf('</head>');
    if (at < 0) return html;
    return `${html.slice(0, at)}<meta name="${TOKEN_META_NAME}" content="${this.token}">\n${html.slice(at)}`;
  }

  private reply(res: ServerResponse, status: number, code: RequestCode): void {
    res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: code === 'sent', code }));
  }

  /**
   * 뷰어 버튼 요청을 받아 세션에 넣는다. 127.0.0.1 서버라도 브라우저에 열린 아무 사이트가 여기로
   * POST할 수 있어서 Origin과 페이지에만 실은 토큰을 둘 다 본다. JSON 본문이라 다른 출처에서 보내면
   * 사전 요청(OPTIONS)부터 405로 막힌다. 세션에 들어가는 글은 검사를 통과한 값으로 서버가 다시 조립한다
   */
  // 루프백은 포트까지 같은 http 출처만 받는다. 넘겨받은 이름은 앞단 프록시가 https로 받아 넘기는 경우가 있어 https 출처도 받는다
  private allowedOrigin(origin: string, port: number | undefined): boolean {
    if (port === undefined) return false;
    if (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`) return true;
    for (const h of this.hosts) {
      if (h === '127.0.0.1' || h === 'localhost') continue;
      if (origin === `https://${h}` || origin === `http://${h}:${port}`) return true;
    }
    return false;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const port = this.port;
    const origin = req.headers.origin;
    if (!origin || !this.allowedOrigin(origin, port)) {
      req.resume();
      return this.reply(res, 403, 'forbidden');
    }
    const given = req.headers[TOKEN_HEADER];
    if (typeof given !== 'string' || !timingSafeEqual(sha256(given), this.tokenDigest)) {
      req.resume();
      return this.reply(res, 403, 'forbidden');
    }
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') {
      req.resume();
      return this.reply(res, 415, 'unsupported_media_type');
    }
    if (Number(req.headers['content-length'] ?? 0) > REQUEST_MAX_BYTES) {
      req.resume();
      return this.reply(res, 413, 'too_large');
    }
    // 속도 제한은 토큰을 통과한 요청만 센다. 밖에서 막 보내는 요청이 내 버튼 몫을 깎지 못하게 한다
    const now = this.now();
    this.requestTimes = this.requestTimes.filter((t) => now - t < REQUEST_RATE_WINDOW_MS);
    if (this.requestTimes.length >= REQUEST_RATE_LIMIT) {
      req.resume();
      return this.reply(res, 429, 'rate_limited');
    }
    this.requestTimes.push(now);

    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > REQUEST_MAX_BYTES) {
        over = true;
        this.reply(res, 413, 'too_large');
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => res.destroy());
    req.on('end', () => {
      if (over) return;
      void this.dispatchRequest(Buffer.concat(chunks).toString('utf8'), res).catch((err) => {
        process.stderr.write(`[digest] request failed: ${(err as Error).message}\n`);
        if (!res.headersSent) this.reply(res, 500, 'send_failed');
      });
    });
  }

  private async dispatchRequest(raw: string, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return this.reply(res, 400, 'bad_request');
    }
    const parsed = sessionRequestSchema.safeParse(body);
    if (!parsed.success) return this.reply(res, 400, 'bad_request');
    const request = parsed.data;
    // 자료 종류는 뷰어가 보낸 값을 믿지 않고 transcript.json에서 읽는다
    const kind = this.sourceKind(request.slug);
    if (!kind) return this.reply(res, 404, 'unknown_slug');
    if (request.action === 'template') {
      const t = this.templates.find((x) => x.id === request.template);
      if (!t || !templateFitsKind(t, templateKindOf(kind))) {
        return this.reply(res, 404, 'unknown_template');
      }
    }
    const lens = templateKindOf(kind) === 'lens';
    const sent = await this.send(frameSessionRequest(request, lens));
    if (sent.ok) return this.reply(res, 200, 'sent');
    process.stderr.write(`[digest] 세션에 요청을 넣지 못했어요: ${sent.reason}\n`);
    return this.reply(res, 503, sent.code);
  }

  private sourceKind(slug: string): SourceKind | null {
    if (!isValidSlug(slug)) return null;
    const raw = readRaw(join(this.root, slug, 'transcript.json'));
    if (raw.kind !== 'ok') return null;
    const parsed = parseTranscript(raw.value);
    return parsed.ok && parsed.value.slug === slug ? parsed.value.meta.source : null;
  }

  /**
   * 루트 밖에서 내주는 파일은 이것 하나다. transcript.json에 ingest가 적은 로컬 영상 경로만 따르고
   * 요청 URL에서 경로를 받지 않는다. 영상 확장자가 아니면 그 경로도 내주지 않는다.
   * 팟캐스트 오디오는 ingest가 늘 <slug>/cache/에 두므로 그 밖을 가리키면 내주지 않는다
   */
  private serveVideo(req: IncomingMessage, res: ServerResponse, slug: string): void {
    const media = this.videoPath(slug);
    if (!media) return this.deny(res, 404, 'Not Found');
    // 경로는 캐시해도 실제 파일 검사는 요청마다 한다. 그사이 심링크가 바뀌거나 파일이 지워질 수 있다
    let real: string;
    let stat: ReturnType<typeof statSync>;
    try {
      real = realpathSync(media.file);
      stat = statSync(real);
      if (media.inCache && !real.startsWith(realpathSync(join(this.root, slug, 'cache')) + sep)) {
        return this.deny(res, 404, 'Not Found');
      }
    } catch {
      return this.deny(res, 404, 'Not Found');
    }
    const type = VIDEO_MIME[extname(real).toLowerCase()];
    if (!type || !stat.isFile()) return this.deny(res, 404, 'Not Found');

    const range = parseByteRange(req.headers.range, stat.size);
    if (range === 'unsatisfiable') {
      return this.deny(res, 416, 'Range Not Satisfiable', {
        'Content-Range': `bytes */${stat.size}`,
      });
    }
    const headers = { ...BASE_HEADERS, 'Content-Type': type, 'Accept-Ranges': 'bytes' };
    if (range === 'none') {
      res.writeHead(200, { ...headers, 'Content-Length': String(stat.size) });
    } else {
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
        'Content-Length': String(range.end - range.start + 1),
      });
    }
    if (req.method === 'HEAD') return void res.end();
    this.stream(res, real, range === 'none' ? undefined : range);
  }

  private videoPath(slug: string): VideoMedia | null {
    const transcriptPath = join(this.root, slug, 'transcript.json');
    let mtimeMs: number;
    try {
      mtimeMs = statSync(transcriptPath).mtimeMs;
    } catch {
      this.videoPaths.delete(slug);
      return null;
    }
    const hit = this.videoPaths.get(slug);
    if (hit && hit.mtimeMs === mtimeMs) return hit.media;

    const raw = readRaw(transcriptPath);
    const parsed = raw.kind === 'ok' ? parseTranscript(raw.value) : null;
    const meta = parsed?.ok ? parsed.value.meta : null;
    let media: VideoMedia | null = null;
    // 팟캐스트는 원래 주소가 피드라 내려받은 오디오(media)를 내준다
    const local =
      meta?.source === 'file' ? meta.url : meta?.source === 'podcast' ? meta.media : undefined;
    if (local) {
      try {
        media = { file: fileURLToPath(local), inCache: meta?.source === 'podcast' };
      } catch {
        media = null;
      }
    }
    this.videoPaths.set(slug, { mtimeMs, media });
    return media;
  }

  private stream(res: ServerResponse, path: string, range?: { start: number; end: number }) {
    // 바깥 try/catch는 동기 구간만 잡는다. open 실패나 클라이언트 중단을 여기서 받지 않으면 serve 프로세스가 죽는다
    pipeline(createReadStream(path, range), res, (err) => {
      if (!err) return;
      // 클라이언트가 먼저 끊은 건 정상 흐름이라 로그를 남기지 않는다
      if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        process.stderr.write(`[digest] stream failed: ${err.message}\n`);
      }
      res.destroy();
    });
  }
}

export async function openInBrowser(url: string): Promise<void> {
  try {
    const { default: open } = await import('open');
    await open(url);
  } catch (err) {
    process.stderr.write(`[digest] 브라우저를 열지 못했어요: ${(err as Error).message}\n`);
  }
}
