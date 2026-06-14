import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { EventStore } from '../../../src/events/store.js';
import { handleExecutePassthrough } from '../../../src/mcp/tools/execute-passthrough.js';
import type { ExecuteInput } from '../../../src/mcp/schemas.js';

/**
 * Dispatch smoke tests for the refactored execute-passthrough entry point.
 *
 * After splitting the monolithic handler into per-action modules, the dispatch
 * table in execute-passthrough.ts must still:
 *   1. Route a known action to its handler and return a JSON-parseable string.
 *   2. Return a `{ error: ... }` JSON string for unknown actions (default branch).
 */
describe('handleExecutePassthrough dispatch', () => {
  let store: EventStore;
  let engine: PassthroughExecuteEngine;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/execute-dispatch-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughExecuteEngine(store);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  it('known action (status): routes to handler and returns JSON-parseable string', async () => {
    const result = await handleExecutePassthrough(
      engine,
      { action: 'status', sessionId: 'x' } as ExecuteInput,
      'claude-code',
    );
    expect(typeof result).toBe('string');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('unknown action: returns JSON string containing an error field', async () => {
    const result = await handleExecutePassthrough(
      engine,
      { action: 'unknown_action' } as unknown as ExecuteInput,
      'claude-code',
    );
    expect(typeof result).toBe('string');
    const parsed = JSON.parse(result) as { error?: string };
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toContain('unknown_action');
  });
});
