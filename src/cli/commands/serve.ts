import { startMcpServer } from '../../mcp/server.js';

export async function serveCommand(): Promise<void> {
  await startMcpServer();
}
