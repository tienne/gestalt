import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { renderMarkdown } from '../conductor/results-markdown.js';
import {
  BodyCache,
  getOrderDetail,
  listOrders,
  loadResults,
  parseSince,
  readRefBody,
  readResultFile,
  searchResults,
  type FileBody,
  type LoadedResults,
  type LoadOptions,
  type ResultFile,
  type ResultFilters,
} from '../conductor/results.js';
import { storeStamp } from '../conductor/store.js';
import { orderWork, type WorkReaderCache } from '../conductor/work-log.js';
import { ORDER_STATUSES } from '../conductor/types.js';
import { renderBrowsePage } from './html.js';

const ORDER_PATH = /^\/api\/orders\/([^/]+)$/;
const REF_PATH = /^\/api\/orders\/([^/]+)\/refs\/(\d{1,4})$/;
const WORK_PATH = /^\/api\/orders\/([^/]+)\/work$/;
/** 웹 검색 결과 상한. 화면이 한 번에 그릴 만큼만 보낸다 */
const SEARCH_LIMIT = 200;

class BadRequest extends Error {}

export interface WebServerOptions extends LoadOptions {
  /** 트랜스크립트를 찾을 projects 폴더. 테스트만 넘기고 평소엔 CLAUDE_CONFIG_DIR와 ~/.claude 아래를 본다 */
  transcriptRoots?: string[];
}

/**
 * 컨덕터 결과를 브라우저에서 읽는 HTTP 서버. 읽기 전용이고 127.0.0.1에만 붙는다.
 *
 * local-pr-web/server.ts와 같은 방어선을 둔다. 다른 점은 파일 본문을 내준다는 것이다.
 * 요청이 경로를 정하면 인증 없는 이 서버가 이 머신의 아무 파일이나 읽어 주는 도구가 되니
 * 경로는 받지 않는다. 주문 id와 refs 번호, 수집 때 발급한 파일 키로만 고른다.
 *
 * 저장소는 base.json과 segment 목록, events.jsonl 중 하나가 바뀌었을 때만 다시 읽는다. 파일 본문은 경로와 mtime, 크기로 캐시해
 * 이벤트 없이 파일만 바뀌어도 다음 요청에서 새로 읽는다.
 *
 * Routes:
 *   GET /                          → 단일 페이지
 *   GET /api/orders                → 주문 목록 (repo, status, since, issue, q)
 *   GET /api/orders/:id            → 주문 상세
 *   GET /api/orders/:id/refs/:i    → refs i번째 본문 (디렉토리면 ?entry=n)
 *   GET /api/orders/:id/work       → 워커 작업 내용 (재개 회차별 tool 타임라인, assistant 글, todo, 파일)
 *   GET /api/search?q=             → 검색 (repo, status, since, issue, body=0)
 *   GET /api/unlinked              → 주문 없는 파일 목록
 *   GET /api/file?id=<키>          → 저장소 파일 본문
 */
export class ConductorWebServer {
  private server: Server | null = null;
  private sigintHandler: (() => void) | null = null;
  private cache: { results: LoadedResults; stamp: string } | null = null;
  // 저장소가 바뀔 때마다 결과를 다시 로드해도 이미 읽은 본문은 다시 읽지 않는다
  private readonly bodies = new BodyCache();
  private readonly readers: WorkReaderCache = new Map();
  private readonly readerMisses = new Map<string, number>();

  constructor(private readonly opts: WebServerOptions) {}

  /** 시작 전에 저장소를 한 번 읽는다. 저장소가 없으면 여기서 던져 서버를 안 띄운다 */
  start(port: number): Promise<void> {
    try {
      this.results();
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        // 핸들러가 던지면 uncaughtException으로 프로세스가 죽는다. 여기서 잡아 오류 응답으로 바꾸고 서버는 계속 돈다
        try {
          this.handleRequest(req, res);
        } catch (err) {
          if (err instanceof BadRequest) return this.text(res, 400, err.message);
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[conductor-web] request failed: ${msg}\n`);
          if (!res.headersSent) this.text(res, 500, 'Internal Server Error');
          else res.end();
        }
      });
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server!.off('error', reject);
        this.server!.on('error', (err) => {
          process.stderr.write(`[conductor-web] server error: ${err.message}\n`);
        });
        this.registerSigintHandler();
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    this.removeSigintHandler();
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => {
        if (err) return reject(err);
        this.server = null;
        resolve();
      });
    });
  }

  get port(): number | undefined {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : undefined;
  }

  private results(): LoadedResults {
    const stamp = storeStamp(this.opts.stateDir);
    if (this.cache?.stamp === stamp) return this.cache.results;
    const results = loadResults({ ...this.opts, bodies: this.bodies });
    this.cache = { results, stamp };
    return results;
  }

  private static safeDecode(raw: string): string | null {
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return this.text(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    }
    // 127.0.0.1에만 붙어도 DNS 리바인딩이면 남의 이름으로 여기 닿는다
    const host = (req.headers.host ?? '').split(':')[0]!.toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost') return this.text(res, 403, 'Forbidden');
    // 다른 사이트가 연 페이지에서 보낸 요청은 응답을 못 읽어도 서버 일을 시킨다. 처음부터 받지 않는다
    if (req.headers['sec-fetch-site'] === 'cross-site') return this.text(res, 403, 'Forbidden');

    const [rawPath, rawQuery = ''] = (req.url ?? '/').split('?', 2) as [string, string?];
    if (ConductorWebServer.safeDecode(rawPath) === null) return this.text(res, 400, 'Bad Request');
    const query = new URLSearchParams(rawQuery);

    if (rawPath === '/') {
      const nonce = randomBytes(16).toString('base64');
      return this.html(res, renderBrowsePage(nonce, this.opts.stateDir), nonce);
    }
    if (rawPath === '/api/orders') return this.json(res, this.orders(query));
    if (rawPath === '/api/search') {
      const results = this.results();
      const found = searchResults(results, query.get('q') ?? '', {
        ...filtersOf(query),
        body: query.get('body') !== '0',
        limit: SEARCH_LIMIT,
      });
      // 서버가 푼 실제 경로는 싣지 않는다. 화면은 파일 키로 고른다
      const hits = found.hits.map(({ absPath: _absPath, ...h }) => h);
      return this.json(res, { ...found, hits });
    }
    if (rawPath === '/api/unlinked') {
      const results = this.results();
      return this.json(res, { files: results.files.filter((f) => !f.orderId).map(publicFile) });
    }
    if (rawPath === '/api/file') {
      const results = this.results();
      const key = query.get('id') ?? '';
      const file = results.fileByKey.get(key);
      const body = file ? readResultFile(results, key) : null;
      if (!file || !body) return this.notFound(res);
      return this.json(res, { ...publicFile(file), ...renderBody(file.path, body) });
    }

    const work = WORK_PATH.exec(rawPath);
    if (work) {
      // 트랜스크립트는 주문 id로 고른 워커의 워크트리와 시작 시각으로만 찾는다. 요청이 경로를 정하지 않는다
      const detail = getOrderDetail(this.results(), ConductorWebServer.safeDecode(work[1]!)!);
      if (!detail) return this.notFound(res);
      return this.json(
        res,
        orderWork(this.opts.stateDir, detail.workers, this.readers, {
          misses: this.readerMisses,
          ...(this.opts.transcriptRoots ? { roots: this.opts.transcriptRoots } : {}),
        }),
      );
    }

    const ref = REF_PATH.exec(rawPath);
    if (ref) {
      const results = this.results();
      const id = ConductorWebServer.safeDecode(ref[1]!)!;
      const detail = getOrderDetail(results, id);
      const r = detail?.refs[Number(ref[2]) - 1];
      if (!r) return this.notFound(res);
      const rawEntry = query.get('entry');
      if (rawEntry !== null && !/^\d{1,4}$/.test(rawEntry))
        return this.text(res, 400, 'Bad Request');
      const entry = rawEntry === null ? undefined : Number(rawEntry);
      const body = readRefBody(results, id, r, entry);
      if (!body) return this.notFound(res);
      const shown = entry === undefined ? r.display : (r.entries?.[entry]?.name ?? r.display);
      const path = entry === undefined ? (r.path ?? '') : (r.entries?.[entry]?.path ?? '');
      return this.json(res, { kind: r.kind, display: shown, ...renderBody(path, body) });
    }

    const order = ORDER_PATH.exec(rawPath);
    if (order) {
      const results = this.results();
      const detail = getOrderDetail(results, ConductorWebServer.safeDecode(order[1]!)!);
      if (!detail) return this.notFound(res);
      return this.json(res, {
        order: {
          ...detail.order,
          ...(detail.order.description
            ? { descriptionHtml: renderMarkdown(detail.order.description) }
            : {}),
        },
        workers: detail.workers.map((w) => ({
          id: w.id,
          kind: w.kind,
          status: w.status,
          attempt: w.attempt,
          ...(w.agent ? { agent: w.agent } : {}),
          ...(w.branch ? { branch: w.branch } : {}),
          startedAt: w.startedAt,
          lastSeenAt: w.lastSeenAt,
          ...(w.stopReason ? { stopReason: w.stopReason } : {}),
        })),
        reports: detail.reports.map((r) => ({ ...r, summaryHtml: renderMarkdown(r.summary) })),
        gates: detail.gates,
        bypasses: detail.bypasses,
        // 서버가 푼 실제 경로는 싣지 않는다. 화면은 워커가 적은 값과 번호만 쓴다
        refs: detail.refs.map((r) => ({
          index: r.index,
          kind: r.kind,
          display: r.display,
          firstReport: r.firstReport,
          ...(r.size !== undefined ? { size: r.size } : {}),
          ...(r.entries
            ? { entries: r.entries.map((e, i) => ({ index: i, name: e.name, size: e.size })) }
            : {}),
          ...(r.entriesTotal !== undefined ? { entriesTotal: r.entriesTotal } : {}),
        })),
        related: detail.related.map(publicFile),
      });
    }

    this.notFound(res);
  }

  private orders(query: URLSearchParams): unknown {
    const results = this.results();
    const { orders } = listOrders(results, filtersOf(query));
    const q = (query.get('q') ?? '').trim().toLowerCase();
    const shown = q
      ? orders.filter((o) =>
          [o.id, o.title, o.repo, o.issueKey ?? '', o.prRef ?? ''].some((v) =>
            v.toLowerCase().includes(q),
          ),
        )
      : orders;
    const all = Object.values(results.snapshot.orders);
    return {
      total: all.length,
      matched: shown.length,
      orders: shown,
      repos: [...new Set(all.map((o) => o.repo))].sort(),
      statuses: ORDER_STATUSES.filter((s) => all.some((o) => o.status === s)),
      unlinkedCount: results.files.filter((f) => !f.orderId).length,
    };
  }

  /**
   * HTML 응답. 페이지에 워커가 쓴 글이 실리니 이스케이프가 한 군데 빠져도 스크립트가 못 돌게
   * nonce를 단 인라인 스크립트만 허용한다. 바깥 출처는 하나도 열지 않는다.
   */
  private html(res: ServerResponse, body: string, nonce: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        "style-src 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    });
    res.end(body);
  }

  /** CORS 헤더를 안 붙인다. 이 API는 같은 오리진의 자기 페이지만 부른다 */
  private json(res: ServerResponse, value: unknown): void {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(JSON.stringify(value));
  }

  private text(
    res: ServerResponse,
    status: number,
    message: string,
    extra: Record<string, string> = {},
  ): void {
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    });
    res.end(message);
  }

  private notFound(res: ServerResponse): void {
    this.text(res, 404, 'Not Found');
  }

  private registerSigintHandler(): void {
    this.sigintHandler = () => {
      process.stderr.write('\n[conductor-web] SIGINT received — shutting down server...\n');
      void this.stop().finally(() => process.exit(0));
    };
    process.once('SIGINT', this.sigintHandler);
  }

  private removeSigintHandler(): void {
    if (this.sigintHandler) {
      process.off('SIGINT', this.sigintHandler);
      this.sigintHandler = null;
    }
  }
}

function filtersOf(query: URLSearchParams): ResultFilters {
  const pick = (k: string) => {
    const v = (query.get(k) ?? '').trim();
    return v || undefined;
  };
  const since = pick('since');
  if (since !== undefined) {
    try {
      parseSince(since);
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
  }
  const repo = pick('repo');
  const status = pick('status');
  const issueKey = pick('issue');
  return {
    ...(repo ? { repo } : {}),
    ...(status ? { status } : {}),
    ...(since ? { since } : {}),
    ...(issueKey ? { issueKey } : {}),
  };
}

function publicFile(f: ResultFile): Omit<ResultFile, 'path'> {
  return {
    key: f.key,
    rel: f.rel,
    size: f.size,
    mtime: f.mtime,
    ...(f.orderId ? { orderId: f.orderId } : {}),
  };
}

/** 이보다 크거나 줄이 이보다 긴 마크다운은 렌더하지 않고 원문으로 보인다. 렌더 비용이 입력에 비례해 커지는 걸 끊는다 */
const MAX_RENDER_BYTES = 512 * 1024;
const MAX_RENDER_LINE = 10_000;

/**
 * 본문 캐시가 같은 파일이면 같은 FileBody 객체를 돌려준다. 그 객체를 키로 쓰면 렌더 캐시가 본문 캐시와 같은 키
 * (경로, mtime, 크기)를 따르고 본문 캐시에서 빠지면 함께 사라진다
 */
const renderCache = new WeakMap<FileBody, string>();

function renderable(text: string): boolean {
  if (Buffer.byteLength(text) > MAX_RENDER_BYTES) return false;
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    const end = nl < 0 ? text.length : nl;
    if (end - start > MAX_RENDER_LINE) return false;
    if (nl < 0) return true;
    start = nl + 1;
  }
}

/**
 * 마크다운이면 렌더한 html과 원문을 함께 보낸다. 화면은 html을 그리고 원문은 펼쳐 볼 수 있게 둔다.
 * 그 밖이나 너무 큰 마크다운은 원문만 보내고 화면이 textContent로 pre에 넣는다
 */
function renderBody(
  path: string,
  body: FileBody,
): FileBody & { html?: string; renderSkipped?: boolean } {
  const ext = extname(path).toLowerCase();
  if (ext !== '.md' && ext !== '.markdown') return body;
  let html = renderCache.get(body);
  if (html === undefined) {
    if (!renderable(body.text)) return { ...body, renderSkipped: true };
    html = renderMarkdown(body.text);
    renderCache.set(body, html);
  }
  return { ...body, html };
}
