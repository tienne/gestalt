import { describe, expect, it } from 'vitest';
import { executeInputSchema, executeToolSchema } from '../../../src/mcp/schemas.js';

describe('MCP schema exports', () => {
  it('exposes execute continuity actions through the public tool schema', () => {
    for (const action of ['resume', 'audit', 'spawn']) {
      expect(executeInputSchema.shape.action.safeParse(action).success).toBe(true);
      expect(executeToolSchema.action.safeParse(action).success).toBe(true);
    }
  });

  it('accepts a per-call client override on execute input', () => {
    const parsed = executeInputSchema.parse({ action: 'status', client: 'codex' });
    expect(parsed.client).toBe('codex');

    for (const client of ['claude-code', 'codex', 'both']) {
      expect(executeInputSchema.shape.client.safeParse(client).success).toBe(true);
    }
    expect(executeInputSchema.shape.client.safeParse('gemini').success).toBe(false);
  });

  it('leaves client undefined when omitted', () => {
    const parsed = executeInputSchema.parse({ action: 'status' });
    expect(parsed.client).toBeUndefined();
  });
});
