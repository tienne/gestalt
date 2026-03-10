/**
 * Log to stderr (not stdout) to avoid polluting MCP stdio transport.
 */
export function log(...args: unknown[]): void {
  console.error('[gestalt]', ...args);
}
