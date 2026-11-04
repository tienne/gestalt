import type { HostClient } from '../core/config.js';

/** MCP names select model defaults; explicit write targets and model IDs stay intact. */
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

/** Runtime handshake evidence, separate from the configured fallback hostClient. */
export function describeClientHost(name: string | undefined) {
  const detectedHost = detectClientHost(name) ?? null;
  return {
    name: name?.slice(0, 128) ?? null,
    detectedHost,
    warning: detectedHost
      ? null
      : 'MCP client name was not recognized; automatic host defaults were not selected. Check hostClient/tierModels and set GESTALT_CLIENT or gestalt.json client explicitly if needed.',
  };
}

export type ClientHostDetection = ReturnType<typeof describeClientHost>;
