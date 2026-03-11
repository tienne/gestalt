import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/core/config.js';
import { ConfigError } from '../src/core/errors.js';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('loads config with empty API key for passthrough mode', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig();
    expect(config.anthropicApiKey).toBe('');
  });

  it('loads config with valid API key', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';
    const config = loadConfig();
    expect(config.anthropicApiKey).toBe('sk-ant-test-key');
    expect(config.ambiguityThreshold).toBe(0.2);
    expect(config.maxInterviewRounds).toBe(15);
  });

  it('respects environment variable overrides', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';
    process.env['GESTALT_AMBIGUITY_THRESHOLD'] = '0.5';
    process.env['GESTALT_MAX_ROUNDS'] = '10';
    process.env['GESTALT_DB_PATH'] = '/tmp/test.db';

    const config = loadConfig();
    expect(config.ambiguityThreshold).toBe(0.5);
    expect(config.maxInterviewRounds).toBe(10);
    expect(config.dbPath).toBe('/tmp/test.db');
  });

  it('accepts overrides parameter', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';
    const config = loadConfig({ logLevel: 'debug' });
    expect(config.logLevel).toBe('debug');
  });
});
