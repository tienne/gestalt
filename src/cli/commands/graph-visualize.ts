import { resolve } from 'node:path';
import { GraphVisualizationEngine } from '../../graph-viz/engine.js';

export interface GraphVisualizeOptions {
  repoRoot?: string;
  port?: number;
  noBrowser?: boolean;
}

/**
 * CLI entry point for `gestalt graph-visualize`.
 * Starts the visualization server and keeps the process alive until Ctrl+C.
 */
export async function graphVisualizeCommand(opts: GraphVisualizeOptions = {}): Promise<void> {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const port = opts.port ? Number(opts.port) : undefined;
  const openBrowser = !opts.noBrowser;

  const engine = new GraphVisualizationEngine();

  try {
    const result = await engine.start({ repoRoot, port, openBrowser });
    console.log(`\nGraph visualization running at: ${result.url}`);
    console.log(`${result.message}`);
    console.log('\nPress Ctrl+C to stop the server.\n');

    // Keep process alive until SIGINT (the server's own SIGINT handler will exit)
    await new Promise<void>(() => { /* runs until Ctrl+C */ });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error starting graph visualization: ${msg}`);
    process.exit(1);
  }
}
