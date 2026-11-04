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

// Display-only normalization; host detection always uses the original name.
const UNSAFE_NAME_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Runtime handshake evidence, separate from the configured fallback hostClient. */
export function describeClientHost(name: string | undefined) {
  const detectedHost = detectClientHost(name) ?? null;
  const chars: string[] = [];
  let nameTruncated = false;
  for (const char of name ?? '') {
    if (chars.length === 128) {
      nameTruncated = true;
      break;
    }
    chars.push(UNSAFE_NAME_CHAR.test(char) ? ' ' : char);
  }
  const reason =
    name === undefined
      ? 'MCP initialize did not include a client name.'
      : 'MCP client name was not recognized.';
  return {
    name: name === undefined ? null : chars.join(''),
    nameTruncated,
    detectedHost,
    warning: detectedHost
      ? null
      : `${reason} hostClient uses your client setting or Claude-compatible defaults. If hostClient does not match your host, set GESTALT_CLIENT or gestalt.json client to codex, grok, or claude-code. client=both retains Claude-compatible model defaults.`,
  };
}

export type ClientHostDetection = ReturnType<typeof describeClientHost>;
