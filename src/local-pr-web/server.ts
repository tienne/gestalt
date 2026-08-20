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

  constructor(private engine: LocalPrEngine) {}

  /** Start the server on the given port. Resolves when listening. */
  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res);
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

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';
    const path = decodeURIComponent(url.split('?')[0]!);

    if (req.method !== 'GET') {
      this.notFound(res);
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

    const apiMatch = path.match(API_PR_DETAIL_PATH);
    if (apiMatch) {
      const pr = this.engine.get(apiMatch[1]!);
      if (!pr) {
        this.notFound(res);
        return;
      }
      this.sendJson(res, pr);
      return;
    }

    const detailMatch = path.match(PR_DETAIL_PATH);
    if (detailMatch) {
      const id = detailMatch[1]!;
      const pr = this.engine.get(id);
      if (!pr) {
        this.notFound(res);
        return;
      }
      const diff = this.engine.diff(id);
      this.sendHtml(res, generatePrDetailHtml(pr, diff));
      return;
    }

    this.notFound(res);
  }

  private sendHtml(res: ServerResponse, html: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
  }

  private sendJson(res: ServerResponse, value: unknown): void {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(value));
  }

  private notFound(res: ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  private registerSigintHandler(): void {
    this.sigintHandler = () => {
      process.stderr.write('\n[local-pr-web] SIGINT received — shutting down server...\n');
      void this.stop().then(() => {
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
