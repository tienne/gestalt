import { log } from '../../core/log.js';
import { GraphVisualizationEngine } from '../../graph-viz/engine.js';

export interface GraphVisualizeInput {
  repoRoot: string;
  port?: number;
}

/**
 * MCP tool handler for `ges_graph_visualize`.
 * Starts the graph visualization HTTP server and returns the URL.
 *
 * Note: The server keeps running after this call returns.
 * The caller is responsible for keeping the MCP session alive or handling shutdown.
 */
export async function handleGraphVisualizePassthrough(input: GraphVisualizeInput): Promise<object> {
  const { repoRoot, port } = input;

  log(`graph-visualize: repoRoot=${repoRoot}, port=${port ?? 'auto'}`);

  const engine = new GraphVisualizationEngine();

  const result = await engine.start({
    repoRoot,
    port,
    openBrowser: true,
  });

  log(`graph-visualize: server started at ${result.url}`);

  return {
    url: result.url,
    port: result.port,
    message: result.message,
  };
}
