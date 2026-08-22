import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { LocalPrEngine } from '../local-pr/engine.js';
import type { RegisteredRepo } from '../local-pr/registry.js';
import { generatePrDetailHtml, generatePrListHtml } from './html-generator.js';

const REPO_KEY = '([0-9a-f]{8})';
const PR_LIST_PATH = new RegExp(`^/r/${REPO_KEY}/?$`);
const PR_DETAIL_PATH = new RegExp(`^/r/${REPO_KEY}/prs/([^/]+)$`);
const API_PR_LIST_PATH = new RegExp(`^/api/r/${REPO_KEY}/prs$`);
const API_PR_DETAIL_PATH = new RegExp(`^/api/r/${REPO_KEY}/prs/([^/]+)$`);

/**
 * 로컬 PR을 브라우저에서 읽는 HTTP 서버. 읽기 전용이다.
 *
 * graph-viz/server.ts와 같은 자리다. 다른 점은 데이터를 생성 시점에 한 번 굳히지
 * 않고 매 요청마다 LocalPrEngine에서 다시 읽는다는 것 — PR 목록은 서버가 떠 있는
 * 동안에도 다른 워커가 코멘트를 달거나 판정을 남기며 바뀐다.
 *
 * 레포 여럿을 한 서버가 보여준다. URL에 실리는 건 경로가 아니라 등록된 레포의
 * 키다 — 요청이 경로를 지정할 수 있으면 인증 없는 이 서버가 이 머신의 아무 git
 * 레포나 읽어주는 도구가 된다. 모르는 키는 404다.
 *
 * Routes:
 *   GET /                       → 지금 레포로 보냄 (등록 레포가 여럿이면 목록)
 *   GET /r/:key                 → 그 레포의 PR 목록 HTML
 *   GET /r/:key/prs/:id         → PR 상세 HTML (diff, 코멘트 스레드, 라운드별 판정)
 *   GET /api/repos              → 등록된 레포 목록 JSON
 *   GET /api/r/:key/prs         → PR 목록 JSON
 *   GET /api/r/:key/prs/:id     → PR 상세 JSON
 *   *                           → 404
 */
export class PrWebServer {
  private server: Server | null = null;
  private sigintHandler: (() => void) | null = null;
  /**
   * `base..head` 쌍으로 캐시한 diff.
   *
   * diff는 그 두 sha에 대해 불변이라 캐시 키가 이미 공짜로 주어져 있다. 안 쓰면
   * 새로고침마다 execFileSync로 git을 부르는데, 동기 spawn이라 그동안 이벤트 루프가
   * 통째로 멈춰 다른 요청도 함께 기다린다. head가 옮겨가면 키가 저절로 갈린다.
   */
  private diffCache = new Map<string, string>();

  /**
   * @param engines 레포 키 → 엔진. 시작할 때 정해지고 요청이 못 늘린다
   * @param primaryKey `pr serve`를 친 자리의 레포. `/`가 여기로 보낸다
   */
  constructor(
    private engines: Map<string, { repo: RegisteredRepo; engine: LocalPrEngine }>,
    private primaryKey: string,
  ) {}

  /** Start the server on the given port. Resolves when listening. */
  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // 핸들러가 던지면 createServer 콜백을 빠져나가 uncaughtException으로 프로세스가
        // 죽는다. `GET /%` 한 번이면 되고 그건 임의 웹페이지가 img 태그로 보낼 수 있다.
        // 읽기 전용 뷰어가 원격 요청 하나에 내려가지 않게 여기서 접는다.
        try {
          this.handleRequest(req, res);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[local-pr-web] request failed: ${msg}\n`);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          }
          res.end('Internal Server Error');
        }
      });

      this.server.once('error', reject);

      this.server.listen(port, '127.0.0.1', () => {
        this.server!.off('error', reject);

        this.server!.on('error', (err) => {
          process.stderr.write(`[local-pr-web] server error: ${err.message}\n`);
        });

        this.registerSigintHandler();
        resolve();
      });
    });
  }

  /** Stop the server gracefully. Safe to call even if server was never started. */
  stop(): Promise<void> {
    this.removeSigintHandler();

    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          this.server = null;
          resolve();
        }
      });
    });
  }

  /** Port the server is listening on, or undefined if not started. */
  get port(): number | undefined {
    const addr = this.server?.address();
    if (addr && typeof addr === 'object') return addr.port;
    return undefined;
  }

  // ─── Private ───────────────────────────────────────────────────

  /** 퍼센트 인코딩이 깨져 있으면 null. 부르는 쪽이 400으로 접는다 */
  private static safeDecode(raw: string): string | null {
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // 읽기 전용 서버라 GET과 HEAD만 받는다. 나머지는 404가 아니라 405로 답해야
    // 부르는 쪽이 "없는 자리"와 "여기선 못 하는 일"을 가릴 수 있다
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end('Method Not Allowed');
      return;
    }

    // 127.0.0.1에만 바인딩해도 DNS 리바인딩은 남의 이름으로 이 자리에 닿는다.
    // Host를 함께 봐야 그 경로가 막힌다
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') {
      res.writeHead(403, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end('Forbidden');
      return;
    }

    // 경로 전체를 먼저 디코딩하면 id 안의 %2F가 슬래시로 풀려 라우트가 갈라진다.
    // 목록 페이지가 링크를 encodeURIComponent로 만드는 것과 짝이 맞으려면
    // 정규식을 raw에 먼저 물리고 캡처된 세그먼트만 디코딩해야 한다
    const rawPath = (req.url ?? '/').split('?')[0]!;
    const path = PrWebServer.safeDecode(rawPath);
    if (path === null) {
      res.writeHead(400, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end('Bad Request');
      return;
    }

    if (path === '/') {
      res.writeHead(302, { Location: `/r/${this.primaryKey}` });
      res.end();
      return;
    }

    if (path === '/api/repos') {
      this.sendJson(
        res,
        [...this.engines.values()].map((e) => e.repo),
      );
      return;
    }

    const apiList = rawPath.match(API_PR_LIST_PATH);
    if (apiList) {
      const held = this.engines.get(apiList[1]!);
      if (!held) return this.notFound(res);
      this.sendJson(res, held.engine.list());
      return;
    }

    const apiDetail = rawPath.match(API_PR_DETAIL_PATH);
    if (apiDetail) {
      const held = this.engines.get(apiDetail[1]!);
      const apiId = PrWebServer.safeDecode(apiDetail[2]!);
      const pr = held && apiId !== null ? held.engine.get(apiId) : null;
      if (!pr) return this.notFound(res);
      this.sendJson(res, pr);
      return;
    }

    const listMatch = rawPath.match(PR_LIST_PATH);
    if (listMatch) {
      const held = this.engines.get(listMatch[1]!);
      if (!held) return this.notFound(res);
      this.sendHtml(res, generatePrListHtml(held.engine.list(), this.repoNav(listMatch[1]!)));
      return;
    }

    const detailMatch = rawPath.match(PR_DETAIL_PATH);
    if (detailMatch) {
      const key = detailMatch[1]!;
      const held = this.engines.get(key);
      const id = PrWebServer.safeDecode(detailMatch[2]!);
      const pr = held && id !== null ? held.engine.get(id) : null;
      if (!pr || !held) return this.notFound(res);
      this.sendHtml(res, generatePrDetailHtml(pr, this.diffOf(held.engine, pr), key));
      return;
    }

    this.notFound(res);
  }

  private repoNav(activeKey: string): { key: string; name: string; active: boolean }[] {
    return [...this.engines.values()].map((e) => ({
      key: e.repo.key,
      name: e.repo.name,
      active: e.repo.key === activeKey,
    }));
  }

  /** 캐시가 무한히 자라지 않게 둘 상한. 리뷰 한 세션이 여는 PR 수를 넉넉히 덮는다 */
  private static readonly DIFF_CACHE_MAX = 32;

  private diffOf(
    engine: LocalPrEngine,
    pr: { id: string; baseSha: string; headSha: string },
  ): string {
    const key = `${pr.baseSha}..${pr.headSha}`;
    const hit = this.diffCache.get(key);
    if (hit !== undefined) return hit;

    const diff = engine.diff(pr.id);
    if (this.diffCache.size >= PrWebServer.DIFF_CACHE_MAX) {
      const oldest = this.diffCache.keys().next().value;
      if (oldest !== undefined) this.diffCache.delete(oldest);
    }
    this.diffCache.set(key, diff);
    return diff;
  }

  private sendHtml(res: ServerResponse, html: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(html);
  }

  /**
   * JSON 응답.
   *
   * CORS 헤더를 안 붙인다. 이 API를 부르는 건 같은 오리진에서 뜬 자기 페이지뿐이라
   * 필요가 없다. 와일드카드를 열면 127.0.0.1 바인딩으로 얻은 격리가 풀린다 —
   * 사용자가 열어둔 아무 웹페이지나 리뷰 중인 비공개 소스를 읽어갈 수 있다.
   */
  private sendJson(res: ServerResponse, value: unknown): void {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  }

  private notFound(res: ServerResponse): void {
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end('Not Found');
  }

  private registerSigintHandler(): void {
    this.sigintHandler = () => {
      process.stderr.write('\n[local-pr-web] SIGINT received — shutting down server...\n');
      // finally로 받는다. close가 실패해도 프로세스는 끝나야 Ctrl+C가 먹는다
      void this.stop().finally(() => {
        process.exit(0);
      });
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
