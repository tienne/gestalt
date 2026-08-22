import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { LocalPrEngine } from '../local-pr/engine.js';
import { generatePrDetailHtml, generatePrListHtml } from './html-generator.js';

const PR_DETAIL_PATH = /^\/prs\/([^/]+)$/;
const API_PR_DETAIL_PATH = /^\/api\/prs\/([^/]+)$/;

/**
 * 로컬 PR을 브라우저에서 읽는 HTTP 서버. 읽기 전용이다.
 *
 * graph-viz/server.ts와 같은 자리다. 다른 점은 데이터를 생성 시점에 한 번 굳히지
 * 않고 매 요청마다 LocalPrEngine에서 다시 읽는다는 것 — PR 목록은 서버가 떠 있는
 * 동안에도 다른 워커가 코멘트를 달거나 판정을 남기며 바뀐다.
 *
 * Routes:
 *   GET /              → PR 목록 HTML
 *   GET /prs/:id       → PR 상세 HTML (diff, 코멘트 스레드, 라운드별 판정)
 *   GET /api/prs       → PR 목록 JSON
 *   GET /api/prs/:id   → PR 상세 JSON
 *   *                  → 404
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

  constructor(private engine: LocalPrEngine) {}

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
      this.sendHtml(res, generatePrListHtml(this.engine.list()));
      return;
    }

    if (path === '/api/prs') {
      this.sendJson(res, this.engine.list());
      return;
    }

    const apiMatch = rawPath.match(API_PR_DETAIL_PATH);
    if (apiMatch) {
      const apiId = PrWebServer.safeDecode(apiMatch[1]!);
      const pr = apiId === null ? null : this.engine.get(apiId);
      if (!pr) {
        this.notFound(res);
        return;
      }
      this.sendJson(res, pr);
      return;
    }

    const detailMatch = rawPath.match(PR_DETAIL_PATH);
    if (detailMatch) {
      const id = PrWebServer.safeDecode(detailMatch[1]!);
      const pr = id === null ? null : this.engine.get(id);
      if (!pr || id === null) {
        this.notFound(res);
        return;
      }
      this.sendHtml(res, generatePrDetailHtml(pr, this.diffOf(pr)));
      return;
    }

    this.notFound(res);
  }

  /** 캐시가 무한히 자라지 않게 둘 상한. 리뷰 한 세션이 여는 PR 수를 넉넉히 덮는다 */
  private static readonly DIFF_CACHE_MAX = 32;

  private diffOf(pr: { id: string; baseSha: string; headSha: string }): string {
    const key = `${pr.baseSha}..${pr.headSha}`;
    const hit = this.diffCache.get(key);
    if (hit !== undefined) return hit;

    const diff = this.engine.diff(pr.id);
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
