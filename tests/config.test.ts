import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadConfig, _deepMerge } from '../src/core/config.js';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // Use skipDotEnv to avoid .env file interference in tests
  const opts = { skipDotEnv: true };

  it('loads config with empty API key for passthrough mode', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig({}, opts);
    expect(config.llm.apiKey).toBe('');
  });

  it('loads config with valid API key', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';
    const config = loadConfig({}, opts);
    expect(config.llm.apiKey).toBe('sk-ant-test-key');
    expect(config.interview.ambiguityThreshold).toBe(0.2);
    expect(config.interview.maxRounds).toBe(15);
  });

  it('respects environment variable overrides', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';
    process.env['GESTALT_AMBIGUITY_THRESHOLD'] = '0.5';
    process.env['GESTALT_MAX_ROUNDS'] = '10';
    process.env['GESTALT_DB_PATH'] = '/tmp/test.db';

    const config = loadConfig({}, opts);
    expect(config.interview.ambiguityThreshold).toBe(0.5);
    expect(config.interview.maxRounds).toBe(10);
    expect(config.dbPath).toBe('/tmp/test.db');
  });

  it('accepts overrides parameter', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';
    const config = loadConfig({ logLevel: 'debug' }, opts);
    expect(config.logLevel).toBe('debug');
  });

  it('nested overrides merge correctly', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig({
      llm: { apiKey: 'test-key', model: 'custom-model' },
      interview: { ambiguityThreshold: 0.1 },
    }, opts);
    expect(config.llm.apiKey).toBe('test-key');
    expect(config.llm.model).toBe('custom-model');
    expect(config.interview.ambiguityThreshold).toBe(0.1);
    expect(config.interview.maxRounds).toBe(15); // default preserved
  });

  it('env vars override gestalt.json values', () => {
    process.env['GESTALT_DRIFT_THRESHOLD'] = '0.5';
    const config = loadConfig({}, opts);
    expect(config.execute.driftThreshold).toBe(0.5);
  });

  it('execute thresholds from env vars', () => {
    process.env['GESTALT_EVOLVE_SUCCESS_THRESHOLD'] = '0.9';
    process.env['GESTALT_EVOLVE_GOAL_ALIGNMENT_THRESHOLD'] = '0.75';
    const config = loadConfig({}, opts);
    expect(config.execute.successThreshold).toBe(0.9);
    expect(config.execute.goalAlignmentThreshold).toBe(0.75);
  });

  it('returns defaults when no config sources exist', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['GESTALT_MODEL'];
    delete process.env['GESTALT_AMBIGUITY_THRESHOLD'];
    delete process.env['GESTALT_MAX_ROUNDS'];
    delete process.env['GESTALT_DB_PATH'];
    delete process.env['GESTALT_SKILLS_DIR'];
    delete process.env['GESTALT_AGENTS_DIR'];
    delete process.env['GESTALT_LOG_LEVEL'];
    delete process.env['GESTALT_DRIFT_THRESHOLD'];
    delete process.env['GESTALT_EVOLVE_SUCCESS_THRESHOLD'];
    delete process.env['GESTALT_EVOLVE_GOAL_ALIGNMENT_THRESHOLD'];

    const config = loadConfig({}, opts);
    expect(config.llm.apiKey).toBe('');
    expect(config.llm.model).toBe('claude-sonnet-4-20250514');
    expect(config.interview.ambiguityThreshold).toBe(0.2);
    expect(config.interview.maxRounds).toBe(15);
    expect(config.execute.driftThreshold).toBe(0.3);
    expect(config.execute.successThreshold).toBe(0.85);
    expect(config.execute.goalAlignmentThreshold).toBe(0.80);
    expect(config.logLevel).toBe('info');
  });

  it('warns and falls back on invalid values', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig({
      interview: { ambiguityThreshold: 5 }, // invalid: max 1
    }, opts);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Warning'));
    // Falls back to defaults
    expect(config.interview.ambiguityThreshold).toBe(0.2);
    consoleSpy.mockRestore();
  });

  it('overrides take highest priority over env vars', () => {
    process.env['GESTALT_DRIFT_THRESHOLD'] = '0.5';
    const config = loadConfig({
      execute: { driftThreshold: 0.7 },
    }, opts);
    expect(config.execute.driftThreshold).toBe(0.7);
  });
});

describe('deepMerge', () => {
  it('merges nested objects', () => {
    const target = { a: { b: 1, c: 2 }, d: 3 };
    const source = { a: { b: 10 }, e: 5 };
    const result = _deepMerge(target, source);
    expect(result).toEqual({ a: { b: 10, c: 2 }, d: 3, e: 5 });
  });

  it('replaces arrays instead of merging', () => {
    const target = { a: [1, 2] };
    const source = { a: [3] };
    const result = _deepMerge(target, source);
    expect(result).toEqual({ a: [3] });
  });

  it('does not mutate target', () => {
    const target = { a: { b: 1 } };
    const source = { a: { b: 2 } };
    _deepMerge(target, source);
    expect(target.a.b).toBe(1);
  });

  it('skips undefined source values', () => {
    const target = { a: 1 };
    const source = { a: undefined };
    const result = _deepMerge(target, source);
    expect(result.a).toBe(1);
  });
});
