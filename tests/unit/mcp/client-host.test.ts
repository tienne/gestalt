import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHostProfile, loadConfig } from '../../../src/core/config.js';
import { describeClientHost, detectClientHost } from '../../../src/mcp/client-host.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import * as hostAdapters from '../../../src/mcp/host-adapter.js';
import * as statusTools from '../../../src/mcp/tools/status.js';

const capturedCodex = JSON.parse(
  readFileSync(
    new URL('../../fixtures/mcp/codex-cli-0.166.0-initialize.json', import.meta.url),
    'utf8',
  ),
) as { clientInfo: { name: string; version: string; title: string }; protocolVersion: string };

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

  async function connect(
    name: string | { name: string; version: string; title?: string },
    clientOverride?: 'both' | 'grok' | 'codex',
    beforeInitialize?: () => void,
  ) {
    const result = await createMcpServer({
      dbPath: resolve(cwd, 'events.db'),
      llm: { apiKey: '', model: 'test-model' },
      ...(clientOverride ? { client: clientOverride } : {}),
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await result.server.connect(serverTransport);
    beforeInitialize?.();
    const client = new Client(typeof name === 'string' ? { name, version: 'test' } : name, {
      capabilities: {},
    });
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
    const connection = await connect(capturedCodex.clientInfo);
    try {
      const status = await connection.call('ges_status');
      expect(status.client).toBe('codex');
      expect(status.hostClient).toBe('codex');
      expect(status.clientDetection).toEqual({
        name: capturedCodex.clientInfo.name,
        nameTruncated: false,
        detectedHost: 'codex',
        warning: null,
      });
      expect(status.modelWarnings).toEqual([]);
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

  it.each(['claude-code', 'unknown-wrapper'])(
    'separates explicit Codex writes from the %s model profile',
    async (name) => {
      writeFileSync('gestalt.json', JSON.stringify({ client: 'codex' }));
      const connection = await connect(name);
      try {
        const status = await connection.call('ges_status');
        expect(status.client).toBe('codex');
        expect(status.hostClient).toBe(name === 'claude-code' ? 'claude-code' : 'codex');
        expect(status.reasoningModel).toBe(name === 'claude-code' ? 'fable' : 'inherit');
      } finally {
        await connection.close();
      }
    },
  );

  it.each(['codex', 'both', 'grok'] as const)(
    'reports unknown handshake evidence independently of explicit %s config',
    async (client) => {
      const connection = await connect('unknown-codex-proxy', client);
      try {
        const status = await connection.call('ges_status');
        expect(status.client).toBe(client);
        expect(status.hostClient).toBe(client === 'both' ? 'claude-code' : client);
        expect(status.clientDetection).toMatchObject({
          name: 'unknown-codex-proxy',
          detectedHost: null,
        });
        expect(status.clientDetection.warning).toContain('GESTALT_CLIENT');
        expect(status.clientDetection.warning).toContain('not recognized');
        expect(status.clientDetection.warning).not.toContain('did not include');
        expect(status.reasoningModel).toBe(client === 'codex' ? 'inherit' : 'fable');
      } finally {
        await connection.close();
      }
    },
  );

  it('keeps runtime diagnostics on errors and ignores config-supplied diagnostic data', async () => {
    writeFileSync(
      'gestalt.json',
      JSON.stringify({
        client: 'both',
        reasoningModel: 'opuss',
        clientDetection: { name: 'fake', detectedHost: 'codex', warning: null },
        modelWarnings: [{ path: 'fake', suggestion: 'fake' }],
      }),
    );
    const connection = await connect('unknown-wrapper');
    try {
      const status = await connection.call('ges_status');
      const error = await connection.call('ges_status', { sessionId: 'nonexistent-session' });
      expect(error.error).toBeTruthy();
      for (const result of [status, error]) {
        expect(result.clientDetection).toMatchObject({
          name: 'unknown-wrapper',
          detectedHost: null,
        });
        expect(result.reasoningModel).toBe('opuss');
        expect(result.modelWarnings).toEqual([
          expect.objectContaining({ path: 'reasoningModel', model: 'opuss', suggestion: 'opus' }),
        ]);
      }
    } finally {
      await connection.close();
    }
  });

  it('bounds unknown client names in the actual status response', async () => {
    const connection = await connect('unrecognized-' + 'x'.repeat(1000));
    try {
      const status = await connection.call('ges_status');
      expect(status.clientDetection.name).toHaveLength(128);
      expect(status.clientDetection.nameTruncated).toBe(true);
      expect(status.clientDetection.detectedHost).toBeNull();
      expect(status.clientDetection.warning).toBeTruthy();
    } finally {
      await connection.close();
    }
  });

  it('sanitizes only the displayed name without recognizing the sanitized value', async () => {
    const connection = await connect('codex\ncli');
    try {
      const status = await connection.call('ges_status');
      expect(status.clientDetection).toMatchObject({
        name: 'codex cli',
        nameTruncated: false,
        detectedHost: null,
      });
      expect(status.clientDetection.warning).toContain('not recognized');
      expect(status.client).toBe('claude-code');
      expect(detectClientHost(status.clientDetection.name)).toBe('codex');
    } finally {
      await connection.close();
    }
  });

  it('keeps engine settings fixed when initialize reloads only the host profile', async () => {
    const observed = vi.spyOn(statusTools, 'buildStatusConfigInfo');
    writeFileSync(
      'gestalt.json',
      JSON.stringify({
        interview: { maxRounds: 7 },
        execute: { driftThreshold: 0.2 },
        notifications: false,
        skillsDir: resolve(cwd, 'original-skills'),
      }),
    );
    const connection = await connect('codex', undefined, () => {
      writeFileSync(
        'gestalt.json',
        JSON.stringify({
          interview: { maxRounds: 99 },
          execute: { driftThreshold: 0.8 },
          reasoningModel: 'custom/new-reasoner',
          reasoningModelFallback: 'custom/new-fallback',
          tierModels: {
            frugal: 'custom/frugal',
            standard: 'custom/standard',
            frontier: 'custom/frontier',
          },
          notifications: true,
          skillsDir: resolve(cwd, 'changed-skills'),
        }),
      );
    });
    try {
      const status = await connection.call('ges_status');
      expect(status.reasoningModel).toBe('custom/new-reasoner');
      expect(status.hostClient).toBe('codex');
      const config = observed.mock.calls.at(-1)![0]!;
      expect(config.interview.maxRounds).toBe(7);
      expect(config.execute.driftThreshold).toBe(0.2);
      expect(config.notifications).toBe(false);
      expect(config.skillsDir).toBe(resolve(cwd, 'original-skills'));
      expect(status.reasoningModelFallback).toBe('custom/new-fallback');
      expect(status.tierModels).toEqual({
        frugal: 'custom/frugal',
        standard: 'custom/standard',
        frontier: 'custom/frontier',
      });
      expect(Object.keys(getHostProfile(config)).sort()).toEqual([
        'client',
        'hostClient',
        'reasoningModel',
        'reasoningModelFallback',
        'tierModels',
      ]);
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
  it('distinguishes missing names from empty unrecognized names without losing fallback guidance', () => {
    const missing = describeClientHost(undefined);
    const empty = describeClientHost('');
    expect(missing).toMatchObject({ name: null, nameTruncated: false, detectedHost: null });
    expect(empty).toMatchObject({ name: '', nameTruncated: false, detectedHost: null });
    expect(missing.warning).toContain('did not include a client name');
    expect(missing.warning).not.toContain('not recognized');
    expect(empty.warning).toContain('not recognized');
    expect(empty.warning).not.toContain('did not include');
    for (const result of [missing, empty]) {
      expect(result.warning).toContain('GESTALT_CLIENT');
      expect(result.warning).toContain('codex, grok, or claude-code');
      expect(result.warning).toContain('client=both retains Claude-compatible model defaults');
    }
    expect(statusTools.buildStatusConfigInfo(loadConfig({}, isolated)).clientDetection).toBeNull();
  });

  it('replaces control, bidi, and line/paragraph separators in display data only', () => {
    const raw = 'host\u0000\u001b\u0085\u202e\u2066\u2028\u2029name';
    const result = describeClientHost(raw);
    expect(result).toMatchObject({
      name: 'host' + ' '.repeat(7) + 'name',
      nameTruncated: false,
      detectedHost: null,
    });
    expect(result.warning).toContain('not recognized');
    expect(detectClientHost(raw)).toBeUndefined();
  });

  it.each([
    ['x'.repeat(128), 'x'.repeat(128), false],
    ['x'.repeat(129), 'x'.repeat(128), true],
    ['x'.repeat(127) + '😀', 'x'.repeat(127) + '😀', false],
    ['x'.repeat(127) + '😀y', 'x'.repeat(127) + '😀', true],
  ] as const)(
    'bounds %s by Unicode code points without splitting emoji',
    (name, expected, truncated) => {
      const result = describeClientHost(name);
      expect(result.name).toBe(expected);
      expect(result.nameTruncated).toBe(truncated);
      expect(Array.from(result.name!)).toHaveLength(128);
      expect(result.name).not.toContain('…');
    },
  );

  it('does not infer hosts from substrings', () => {
    expect(detectClientHost('my-codex-wrapper')).toBeUndefined();
    expect(detectClientHost(undefined)).toBeUndefined();
  });
});
