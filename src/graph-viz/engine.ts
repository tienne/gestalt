import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CodeGraphEngine } from '../code-graph/engine.js';
import { CodeGraphStore } from '../code-graph/storage.js';
import { findAvailablePort } from './port-finder.js';
import { GraphVisualizationServer } from './server.js';
import type { GraphVisualizationResult, GraphVizServerOptions } from './types.js';

/**
 * Orchestrates the graph visualization pipeline:
 *  1. Ensure code-graph.db exists (auto-build if missing)
 *  2. Load nodes + edges from CodeGraphStore
 *  3. Find an available port
 *  4. Start GraphVisualizationServer
 *  5. Open browser (optional)
 *  6. Return { url, port, message }
 *
 * Used by both the CLI command and the MCP tool.
 */
export class GraphVisualizationEngine {
  private server: GraphVisualizationServer | null = null;

  async start(opts: GraphVizServerOptions): Promise<GraphVisualizationResult> {
    const { repoRoot, port: preferredPort, openBrowser = true } = opts;
    const dbPath = join(repoRoot, '.gestalt', 'code-graph.db');

    // ── 1. Auto-build graph if DB is absent ──────────────────────
    if (!existsSync(dbPath)) {
      process.stderr.write('[graph-viz] code-graph.db not found — building graph...\n');
      const codeGraphEngine = new CodeGraphEngine();
      codeGraphEngine.build(repoRoot);
      process.stderr.write('[graph-viz] graph build complete.\n');
    }

    // ── 2. Load nodes & edges ────────────────────────────────────
    const store = new CodeGraphStore(dbPath);
    const nodes = store.getAllNodes();
    const edges = store.getAllEdges();

    process.stderr.write(
      `[graph-viz] loaded ${nodes.length} nodes, ${edges.length} edges from ${dbPath}\n`,
    );

    // ── 3. Find available port ───────────────────────────────────
    const port = await findAvailablePort(preferredPort ?? 7891);

    // ── 4. Start server ──────────────────────────────────────────
    this.server = new GraphVisualizationServer(nodes, edges);
    await this.server.start(port);

    const url = `http://127.0.0.1:${port}`;
    process.stderr.write(`[graph-viz] server running at ${url}\n`);

    // ── 5. Open browser (best-effort) ────────────────────────────
    if (openBrowser) {
      await openUrl(url);
    }

    // ── 6. Return result ─────────────────────────────────────────
    return {
      url,
      port,
      message: `Graph visualization running at ${url} (${nodes.length} nodes, ${edges.length} edges)`,
    };
  }

  /** Stop the server. Safe to call even if never started. */
  async stop(): Promise<void> {
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
  }
}

// ─── Singleton for shared CLI / MCP use ──────────────────────────
let _instance: GraphVisualizationEngine | null = null;

export function getGraphVisualizationEngine(): GraphVisualizationEngine {
  if (!_instance) _instance = new GraphVisualizationEngine();
  return _instance;
}

// ─── Browser open helper ──────────────────────────────────────────
async function openUrl(url: string): Promise<void> {
  try {
    // Dynamic import so the module is not required at load-time in environments
    // where `open` may not be available (e.g. CI).
    const { default: open } = await import('open');
    await open(url);
  } catch (err) {
    // Non-fatal: just log and continue
    process.stderr.write(
      `[graph-viz] could not open browser automatically: ${(err as Error).message}\n`,
    );
  }
}
