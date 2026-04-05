import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { CodeGraphNode, CodeGraphEdge } from '../code-graph/types.js';
import { generateVisualizationHtml } from './html-generator.js';

/**
 * HTTP server that serves the interactive graph visualization UI and a JSON data endpoint.
 *
 * Routes:
 *   GET /           → self-contained HTML (generated once at start)
 *   GET /api/graph  → { nodes, edges } JSON
 *   *               → 404
 */
export class GraphVisualizationServer {
  private server: Server | null = null;
  private html: string;
  private graphJson: string;
  private sigintHandler: (() => void) | null = null;

  constructor(nodes: CodeGraphNode[], edges: CodeGraphEdge[]) {
    this.html = generateVisualizationHtml(nodes, edges);
    this.graphJson = JSON.stringify({ nodes, edges });
  }

  /** Start the server on the given port. Resolves when listening. */
  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res);
      });

      this.server.once('error', reject);

      this.server.listen(port, '127.0.0.1', () => {
        this.server!.off('error', reject);

        // Handle subsequent errors (e.g. socket errors) without crashing
        this.server!.on('error', (err) => {
          process.stderr.write(`[graph-viz] server error: ${err.message}\n`);
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
    const path = url.split('?')[0]!;

    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(this.html);
      return;
    }

    if (req.method === 'GET' && path === '/api/graph') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(this.graphJson);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  private registerSigintHandler(): void {
    this.sigintHandler = () => {
      process.stderr.write('\n[graph-viz] SIGINT received — shutting down server...\n');
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
