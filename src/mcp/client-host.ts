import type { HostClient } from '../core/config.js';

/** MCP clientInfo is a hint for defaults, never an override of project settings. */
export function detectClientHost(name: string | undefined): HostClient | undefined {
  if (!name) return undefined;
  const normalized = name.toLowerCase();
  if (/^(?:openai[-_ ])?codex(?:[-_ ](?:cli|desktop|app|vscode|mcp-client))?$/.test(normalized)) {
    return 'codex';
  }
  if (/^grok(?:[-_ ](?:cli|build|mcp-client))?$/.test(normalized)) return 'grok';
  if (/^claude(?:[-_ ]code)?$/.test(normalized)) return 'claude-code';
  return undefined;
}
