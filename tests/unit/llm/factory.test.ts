import { describe, it, expect, afterEach } from 'vitest';
import {
  createAdapter,
  createAdapterFromTierConfig,
  createTierAdapter,
  hasLLMApiKey,
} from '../../../src/llm/factory.js';
import { AnthropicAdapter } from '../../../src/llm/adapter.js';
import { OpenAIAdapter } from '../../../src/llm/openai-adapter.js';
import { RetryingAdapter } from '../../../src/llm/retry-adapter.js';
import { loadConfig } from '../../../src/core/config.js';
import { DEFAULT_MODEL } from '../../../src/core/constants.js';

// loadConfig with isolated options to avoid local .env / gestalt.json interference
const opts = { skipDotEnv: true, skipGestaltJson: true } as const;

describe('createAdapter', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('flat config(apiKey+model) -> RetryingAdapter wrapping AnthropicAdapter', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig({ llm: { apiKey: 'sk-ant-test', model: 'claude-sonnet-4-6' } }, opts);
    const adapter = createAdapter(config.llm);
    expect(adapter).toBeInstanceOf(RetryingAdapter);
    expect((adapter as RetryingAdapter)['inner']).toBeInstanceOf(AnthropicAdapter);
  });
});

describe('createAdapterFromTierConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('provider=anthropic -> RetryingAdapter wrapping AnthropicAdapter', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig({ llm: { apiKey: 'sk-ant-test', model: DEFAULT_MODEL } }, opts);
    const adapter = createAdapterFromTierConfig(
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      config.llm,
    );
    expect(adapter).toBeInstanceOf(RetryingAdapter);
    expect((adapter as RetryingAdapter)['inner']).toBeInstanceOf(AnthropicAdapter);
  });

  it('provider=openai -> RetryingAdapter wrapping OpenAIAdapter', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig({ llm: { apiKey: 'sk-openai-test', model: DEFAULT_MODEL } }, opts);
    const adapter = createAdapterFromTierConfig(
      { provider: 'openai', model: 'gpt-4o-mini' },
      config.llm,
    );
    expect(adapter).toBeInstanceOf(RetryingAdapter);
    expect((adapter as RetryingAdapter)['inner']).toBeInstanceOf(OpenAIAdapter);
  });

  it('provider=openai + baseURL -> RetryingAdapter wrapping OpenAIAdapter with baseURL', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig({ llm: { apiKey: 'ollama-key', model: DEFAULT_MODEL } }, opts);
    const adapter = createAdapterFromTierConfig(
      { provider: 'openai', model: 'llama3', baseURL: 'http://localhost:11434/v1' },
      config.llm,
    );
    expect(adapter).toBeInstanceOf(RetryingAdapter);
    expect((adapter as RetryingAdapter)['inner']).toBeInstanceOf(OpenAIAdapter);
    // OpenAIAdapter stores the client internally; we verify construction succeeded
    // with the baseURL param (no throw = baseURL was accepted)
  });
});

describe('createTierAdapter', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('tier 설정이 있으면 그 tier 어댑터를 만든다', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig(
      {
        llm: {
          apiKey: 'sk-ant-test',
          frugal: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-openai' },
        },
      },
      opts,
    );
    const adapter = createTierAdapter(config.llm, 'frugal');
    expect(adapter).toBeInstanceOf(RetryingAdapter);
    expect((adapter as RetryingAdapter)['inner']).toBeInstanceOf(OpenAIAdapter);
  });

  it('tier 설정이 없으면 undefined를 돌려준다', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig({ llm: { apiKey: 'sk-ant-test' } }, opts);
    expect(createTierAdapter(config.llm, 'frugal')).toBeUndefined();
  });

  it('tier에 apiKey가 없으면 flat apiKey를 물려받는다', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig(
      {
        llm: {
          apiKey: 'sk-ant-test',
          frugal: { provider: 'anthropic', model: 'claude-haiku-4-5' },
        },
      },
      opts,
    );
    const adapter = createTierAdapter(config.llm, 'frugal');
    expect(adapter).toBeInstanceOf(RetryingAdapter);
    expect((adapter as RetryingAdapter)['inner']).toBeInstanceOf(AnthropicAdapter);
  });
});

describe('hasLLMApiKey', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('flat apiKey present -> true', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig({ llm: { apiKey: 'sk-ant-test' } }, opts);
    expect(hasLLMApiKey(config)).toBe(true);
  });

  it('flat apiKey absent, tier apiKey present -> true', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig(
      {
        llm: {
          frugal: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-openai' },
        },
      },
      opts,
    );
    // flat apiKey defaults to '' (empty)
    expect(config.llm.apiKey).toBe('');
    expect(hasLLMApiKey(config)).toBe(true);
  });

  it('no apiKey anywhere -> false', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig({}, opts);
    expect(config.llm.apiKey).toBe('');
    expect(hasLLMApiKey(config)).toBe(false);
  });
});
