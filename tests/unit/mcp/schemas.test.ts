import { describe, expect, it } from 'vitest';
import { executeInputSchema, executeToolSchema } from '../../../src/mcp/schemas.js';

describe('MCP schema exports', () => {
  it('exposes execute continuity actions through the public tool schema', () => {
    for (const action of ['resume', 'audit', 'spawn']) {
      expect(executeInputSchema.shape.action.safeParse(action).success).toBe(true);
      expect(executeToolSchema.action.safeParse(action).success).toBe(true);
    }
  });
});
