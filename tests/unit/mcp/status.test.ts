import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { handleStatus } from '../../../src/mcp/tools/status.js';
import { InterviewEngine } from '../../../src/interview/engine.js';
import { EventStore } from '../../../src/events/store.js';
import { loadConfig } from '../../../src/core/config.js';
import type { GestaltConfig } from '../../../src/core/config.js';
import type { LLMAdapter, LLMRequest, LLMResponse } from '../../../src/llm/types.js';
import type { StatusInput } from '../../../src/mcp/schemas.js';

class MockLLM implements LLMAdapter {
  async chat(_request: LLMRequest): Promise<LLMResponse> {
    return {
      content: '{"question": "mock?", "reasoning": "mock"}',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

const isolatedOpts = { skipDotEnv: true, skipGestaltJson: true };

describe('handleStatus — reasoningModel exposure', () => {
  let store: EventStore;
  let engine: InterviewEngine;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/status-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new InterviewEngine(new MockLLM(), store);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = dbPath + suffix;
      if (existsSync(file)) rmSync(file);
    }
  });

  const listInput: StatusInput = { sessionType: 'all' };

  it('exposes resolved reasoningModel/reasoningModelFallback in list mode (no session)', () => {
    const config = loadConfig({}, isolatedOpts);
    const result = JSON.parse(handleStatus(engine, listInput, store, config));

    expect(result.reasoningModel).toBe('fable');
    expect(result.reasoningModelFallback).toBe('opus');
  });

  it('reflects overridden config values in list mode', () => {
    const config = loadConfig(
      { reasoningModel: 'sonnet', reasoningModelFallback: 'haiku' },
      isolatedOpts,
    ) as GestaltConfig;
    const result = JSON.parse(handleStatus(engine, listInput, store, config));

    expect(result.reasoningModel).toBe('sonnet');
    expect(result.reasoningModelFallback).toBe('haiku');
  });

  it('is null-safe when config is not injected (backwards compatible)', () => {
    const result = JSON.parse(handleStatus(engine, listInput, store));

    expect(result.reasoningModel).toBeNull();
    expect(result.reasoningModelFallback).toBeNull();
  });

  it('exposes reasoningModel on the session-not-found error path', () => {
    const config = loadConfig({}, isolatedOpts);
    const result = JSON.parse(
      handleStatus(engine, { sessionId: 'does-not-exist', sessionType: 'all' }, store, config),
    );

    expect(result.error).toBeDefined();
    expect(result.reasoningModel).toBe('fable');
    expect(result.reasoningModelFallback).toBe('opus');
  });

  it('exposes reasoningModel alongside an existing interview session', async () => {
    const started = await engine.start('Status exposure topic');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const config = loadConfig({}, isolatedOpts);
    const result = JSON.parse(
      handleStatus(
        engine,
        { sessionId: started.value.session.sessionId, sessionType: 'all' },
        store,
        config,
      ),
    );

    expect(result.type).toBe('interview');
    expect(result.reasoningModel).toBe('fable');
    expect(result.reasoningModelFallback).toBe('opus');
  });
});
