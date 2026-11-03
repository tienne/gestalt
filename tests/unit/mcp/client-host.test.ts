import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../src/core/config.js';
import { detectClientHost } from '../../../src/mcp/client-host.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import * as hostAdapters from '../../../src/mcp/host-adapter.js';

const isolated = { skipDotEnv: true, skipGestaltJson: true };

describe('host model configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('Codex inherits session models while explicit model IDs survive', () => {
    const config = loadConfig(
      { client: 'codex', tierModels: { frontier: 'gpt-custom' } },
      isolated,
    );
    expect(config.reasoningModel).toBe('inherit');
    expect(config.reasoningModelFallback).toBe('inherit');
    expect(config.tierModels).toEqual({
      frugal: 'inherit',
      standard: 'inherit',
      frontier: 'gpt-custom',
    });
  });

  it('a detected Codex host does not replace an explicit both write target', () => {
    const config = loadConfig(
      { client: 'both' },
      { ...isolated, defaultClient: 'codex', hostClient: 'codex' },
    );
    expect(config.client).toBe('both');
    expect(config.hostClient).toBe('codex');
    expect(config.tierModels.standard).toBe('inherit');
  });

  it('environment and call overrides take priority over detected defaults', () => {
    vi.stubEnv('GESTALT_CLIENT', 'grok');
    vi.stubEnv('GESTALT_REASONING_MODEL', 'custom/model-v2');
    const options = { ...isolated, defaultClient: 'codex' as const, hostClient: 'codex' as const };
    expect(loadConfig({}, options).client).toBe('grok');
    const config = loadConfig(
      { client: 'both', tierModels: { standard: 'custom-model' } },
      options,
    );
    expect(config.client).toBe('both');
    expect(config.reasoningModel).toBe('custom/model-v2');
    expect(config.tierModels.standard).toBe('custom-model');
  });

  it.each(['', '  ', 'bad model', 'a'.repeat(129)])(
    'recovers invalid model %j with Codex defaults',
    (value) => {
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const config = loadConfig(
          { client: 'codex', reasoningModel: value, tierModels: { standard: value } },
          isolated,
        );
        expect(config.reasoningModel).toBe('inherit');
        expect(config.tierModels.standard).toBe('inherit');
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );

  it('keeps Claude defaults', () => {
    const config = loadConfig({}, isolated);
    expect(config.reasoningModel).toBe('fable');
    expect(config.reasoningModelFallback).toBe('opus');
    expect(config.tierModels).toEqual({ frugal: 'haiku', standard: 'sonnet', frontier: 'opus' });
  });

  it('recovers an invalid write target to the detected host default', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const config = loadConfig(
        { client: 'typo' },
        { ...isolated, defaultClient: 'codex', hostClient: 'codex' },
      );
      expect(config.client).toBe('codex');
      expect(config.tierModels.standard).toBe('inherit');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('MCP client handshake', () => {
  let cwd: string;
  let originalCwd: string;
  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = resolve('.gestalt-test', `client-host-${randomUUID()}`);
    mkdirSync(cwd, { recursive: true });
    process.chdir(cwd);
    vi.stubEnv('GESTALT_CLIENT', undefined);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function connect(name: string, clientOverride?: 'both' | 'grok') {
    const result = await createMcpServer({
      dbPath: resolve(cwd, 'events.db'),
      llm: { apiKey: '', model: 'test-model' },
      ...(clientOverride ? { client: clientOverride } : {}),
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await result.server.connect(serverTransport);
    const client = new Client({ name, version: 'test' }, { capabilities: {} });
    await client.connect(clientTransport);
    async function call(name: string, args: Record<string, unknown> = {}) {
      const reply = await client.callTool({ name, arguments: args });
      const content = reply.content as Array<{ text: string }>;
      return JSON.parse(content[0]!.text);
    }
    return {
      call,
      close: async () => {
        await client.close();
        await result.server.close();
        result.eventStore.close();
      },
    };
  }

  it('detects Codex before the first status/get/list request and selects its write adapter', async () => {
    const adapter = vi.spyOn(hostAdapters, 'createHostAdapter');
    const connection = await connect('codex-mcp-client');
    try {
      const status = await connection.call('ges_status');
      expect(status.client).toBe('codex');
      expect(status.hostClient).toBe('codex');
      expect(status.reasoningModel).toBe('inherit');
      expect(status.tierModels.standard).toBe('inherit');
      const agent = await connection.call('ges_agent', { action: 'get', name: 'architect' });
      expect(agent.model).toBe('inherit');
      const list = await connection.call('ges_agent', { action: 'list' });
      expect(list.groups.role.every((entry: { model: string }) => entry.model === 'inherit')).toBe(
        true,
      );
      await connection.call('ges_execute', { action: 'start', cwd });
      expect(adapter).toHaveBeenLastCalledWith('codex', cwd);
      await connection.call('ges_execute', { action: 'start', client: 'grok', cwd });
      expect(adapter).toHaveBeenLastCalledWith('grok', cwd);
    } finally {
      await connection.close();
    }
  });

  it('preserves JSON client=both with Codex model defaults', async () => {
    writeFileSync('gestalt.json', JSON.stringify({ client: 'both' }));
    const adapter = vi.spyOn(hostAdapters, 'createHostAdapter');
    const connection = await connect('codex');
    try {
      const status = await connection.call('ges_status');
      expect(status.client).toBe('both');
      expect(status.hostClient).toBe('codex');
      expect(status.reasoningModel).toBe('inherit');
      await connection.call('ges_execute', { action: 'start', cwd });
      expect(adapter).toHaveBeenLastCalledWith('both', cwd);
      // The actual adapters still write both targets in a shared-host project.
      await adapter.mock.results.at(-1)!.value.writeActiveContext('shared context');
      expect(readFileSync(resolve(cwd, 'AGENTS.md'), 'utf8')).toContain('shared context');
      expect(existsSync(resolve(cwd, '.claude/rules/gestalt-active.md'))).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it('preserves explicit JSON model IDs when initialize reloads Codex defaults', async () => {
    writeFileSync(
      'gestalt.json',
      JSON.stringify({
        client: 'both',
        reasoningModel: 'custom/reasoner',
        reasoningModelFallback: 'custom/fallback',
        tierModels: { frontier: 'custom/frontier' },
      }),
    );
    const connection = await connect('codex');
    try {
      const status = await connection.call('ges_status');
      expect(status.client).toBe('both');
      expect(status.hostClient).toBe('codex');
      expect(status.reasoningModel).toBe('custom/reasoner');
      expect(status.reasoningModelFallback).toBe('custom/fallback');
      expect(status.tierModels).toEqual({
        frugal: 'inherit',
        standard: 'inherit',
        frontier: 'custom/frontier',
      });
      const agent = await connection.call('ges_agent', { action: 'get', name: 'architect' });
      expect(agent.model).toBe('custom/frontier');
    } finally {
      await connection.close();
    }
  });

  it.each([
    ['grok-build', 'grok'],
    ['unknown-codex-proxy', 'claude-code'],
  ])('handles %s without guessing an unknown host', async (name, expected) => {
    const connection = await connect(name);
    try {
      expect((await connection.call('ges_status')).client).toBe(expected);
    } finally {
      await connection.close();
    }
  });
});

describe('detectClientHost', () => {
  it.each(['codex', 'Codex CLI', 'OpenAI Codex', 'codex-mcp-client', 'codex_vscode'])(
    'recognizes %s',
    (name) => {
      expect(detectClientHost(name)).toBe('codex');
    },
  );
  it('does not infer hosts from substrings', () => {
    expect(detectClientHost('my-codex-wrapper')).toBeUndefined();
    expect(detectClientHost(undefined)).toBeUndefined();
  });
});
