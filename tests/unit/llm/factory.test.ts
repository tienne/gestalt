import { describe, it, expect, afterEach } from 'vitest';
import {
  createAdapter,
  createAdapterFromTierConfig,
  createTierMapping,
  hasLLMApiKey,
} from '../../../src/llm/factory.js';
import { AnthropicAdapter } from '../../../src/llm/adapter.js';
import { OpenAIAdapter } from '../../../src/llm/openai-adapter.js';
import { loadConfig } from '../../../src/core/config.js';
import { DEFAULT_MODEL } from '../../../src/core/constants.js';

// loadConfig with isolated options to avoid local .env / gestalt.json interference
const opts = { skipDotEnv: true, skipGestaltJson: true } as const;

describe('createAdapter', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('flat config(apiKey+model) -> AnthropicAdapter instance', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig(
      { llm: { apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' } },
      opts,
    );
    const adapter = createAdapter(config.llm);
    expect(adapter).toBeInstanceOf(AnthropicAdapter);
  });
});

describe('createAdapterFromTierConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('provider=anthropic -> AnthropicAdapter', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig(
      { llm: { apiKey: 'sk-ant-test', model: DEFAULT_MODEL } },
      opts,
    );
    const adapter = createAdapterFromTierConfig(
      { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      config.llm,
    );
    expect(adapter).toBeInstanceOf(AnthropicAdapter);
  });

  it('provider=openai -> OpenAIAdapter', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig(
      { llm: { apiKey: 'sk-openai-test', model: DEFAULT_MODEL } },
      opts,
    );
    const adapter = createAdapterFromTierConfig(
      { provider: 'openai', model: 'gpt-4o-mini' },
      config.llm,
    );
    expect(adapter).toBeInstanceOf(OpenAIAdapter);
  });

  it('provider=openai + baseURL -> OpenAIAdapter receives baseURL', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig(
      { llm: { apiKey: 'ollama-key', model: DEFAULT_MODEL } },
      opts,
    );
    const adapter = createAdapterFromTierConfig(
      { provider: 'openai', model: 'llama3', baseURL: 'http://localhost:11434/v1' },
      config.llm,
    );
    expect(adapter).toBeInstanceOf(OpenAIAdapter);
    // OpenAIAdapter stores the client internally; we verify construction succeeded
    // with the baseURL param (no throw = baseURL was accepted)
  });
});

describe('createTierMapping', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('flat config only -> all three tiers are AnthropicAdapter', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig(
      { llm: { apiKey: 'sk-ant-test', model: DEFAULT_MODEL } },
      opts,
    );
    const mapping = createTierMapping(config);

    expect(mapping.frugal.adapter).toBeInstanceOf(AnthropicAdapter);
    expect(mapping.standard.adapter).toBeInstanceOf(AnthropicAdapter);
    expect(mapping.frontier.adapter).toBeInstanceOf(AnthropicAdapter);
    expect(mapping.frugal.provider).toBe('anthropic');
    expect(mapping.standard.provider).toBe('anthropic');
    expect(mapping.frontier.provider).toBe('anthropic');
  });

  it('frugal only set(openai) -> frugal=OpenAI, standard/frontier=Anthropic', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig(
      {
        llm: {
          apiKey: 'sk-ant-test',
          model: DEFAULT_MODEL,
          frugal: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-openai' },
        },
      },
      opts,
    );
    const mapping = createTierMapping(config);

    expect(mapping.frugal.adapter).toBeInstanceOf(OpenAIAdapter);
    expect(mapping.frugal.provider).toBe('openai');
    expect(mapping.frugal.model).toBe('gpt-4o-mini');

    expect(mapping.standard.adapter).toBeInstanceOf(AnthropicAdapter);
    expect(mapping.standard.provider).toBe('anthropic');

    expect(mapping.frontier.adapter).toBeInstanceOf(AnthropicAdapter);
    expect(mapping.frontier.provider).toBe('anthropic');
  });

  it('all three tiers configured -> each created independently', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig(
      {
        llm: {
          apiKey: 'sk-ant-fallback',
          model: DEFAULT_MODEL,
          frugal: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-openai' },
          standard: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
          frontier: { provider: 'anthropic', model: 'claude-opus-4-20250514' },
        },
      },
      opts,
    );
    const mapping = createTierMapping(config);

    expect(mapping.frugal.adapter).toBeInstanceOf(OpenAIAdapter);
    expect(mapping.frugal.model).toBe('gpt-4o-mini');

    expect(mapping.standard.adapter).toBeInstanceOf(AnthropicAdapter);
    expect(mapping.standard.model).toBe('claude-sonnet-4-20250514');

    expect(mapping.frontier.adapter).toBeInstanceOf(AnthropicAdapter);
    expect(mapping.frontier.model).toBe('claude-opus-4-20250514');
  });

  it('tier apiKey missing -> falls back to flat apiKey', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    // standard tier has no apiKey, should use flat apiKey as fallback
    const config = loadConfig(
      {
        llm: {
          apiKey: 'sk-ant-flat-key',
          model: DEFAULT_MODEL,
          standard: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
        },
      },
      opts,
    );
    // createTierMapping should not throw even though tier apiKey is missing
    const mapping = createTierMapping(config);
    expect(mapping.standard.adapter).toBeInstanceOf(AnthropicAdapter);
  });
});

describe('hasLLMApiKey', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('flat apiKey present -> true', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const config = loadConfig(
      { llm: { apiKey: 'sk-ant-test' } },
      opts,
    );
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
