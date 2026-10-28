import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseTranscript } from './schema.js';
import { isValidSlug, readRaw } from './store.js';
import { VIEWER_JS_SHA256 } from './viewer-js.js';

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
// 렌더가 싣는 실행 스크립트는 VIEWER_JS 하나뿐이라 해시로 고정한다. 데이터 블록은 type이 JSON이라 실행되지 않는다
export const DIGEST_CSP = [
  "default-src 'self'",
  `script-src 'self' 'sha256-${VIEWER_JS_SHA256}' https://www.youtube.com https://s.ytimg.com`,
  'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
  "img-src 'self' data: https://i.ytimg.com",
  "media-src 'self'",
  "style-src 'self' 'unsafe-inline'",
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

  constructor(root: string) {
    this.root = realpathSync(root);
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
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return this.deny(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    }
    // 127.0.0.1에만 바인딩해도 DNS 리바인딩이면 남의 이름으로 여기 닿는다
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') return this.deny(res, 403, 'Forbidden');

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

    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': MIME[ext]!,
      ...(ext === '.html' ? { 'Content-Security-Policy': DIGEST_CSP } : {}),
    });
    if (req.method === 'HEAD') return void res.end();
    this.stream(res, real);
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
