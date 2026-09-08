import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer } from '../../../src/mcp/server.js';
import type { GestaltConfig } from '../../../src/core/config.js';

type ToolHandler = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => { content: Array<{ type: string; text: string }> };

type RegisteredToolMap = Record<
  string,
  { inputSchema?: Record<string, unknown>; handler?: ToolHandler }
>;

/** Invoke a registered tool's handler and parse its JSON text payload. */
function callTool(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const tool = registeredTools(server)[name];
  if (!tool?.handler) throw new Error(`Tool ${name} has no handler`);
  const result = tool.handler(args, {});
  const text = result.content[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

interface ServerWithRegisteredTools {
  _registeredTools: RegisteredToolMap;
}

const expectedPassthroughTools = [
  'ges_interview',
  'ges_generate_spec',
  'ges_execute',
  'ges_create_agent',
  'ges_agent',
  'ges_benchmark',
  'ges_status',
  'ges_code_graph',
  'ges_graph_visualize',
  'ges_generate_kb',
  'ges_search',
  'ges_sync',
  'ges_pr',
];

let dbPaths: string[] = [];

function dbPath(): string {
  const path = `.gestalt-test/mcp-server-${randomUUID()}.db`;
  dbPaths.push(path);
  return path;
}

function registeredTools(server: unknown): RegisteredToolMap {
  return (server as ServerWithRegisteredTools)._registeredTools;
}

function toolNames(server: unknown): string[] {
  return Object.keys(registeredTools(server)).sort();
}

function inputKeys(tool: { inputSchema?: Record<string, unknown> } | undefined): string[] {
  const schema = tool?.inputSchema;
  if (!schema) return [];

  const shape = schema['shape'];
  if (typeof shape === 'function') {
    const result = shape() as Record<string, unknown>;
    return Object.keys(result);
  }
  if (shape && typeof shape === 'object') return Object.keys(shape);

  return Object.keys(schema);
}

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '.jsonl']) {
    const file = path + suffix;
    if (existsSync(file)) rmSync(file);
  }
}

afterEach(() => {
  for (const path of dbPaths) cleanupDb(path);
  dbPaths = [];
});

describe('createMcpServer', () => {
  it('registers the full passthrough MCP surface when no API key is configured', async () => {
    const { server, eventStore } = await createMcpServer({
      dbPath: dbPath(),
      llm: { apiKey: '', model: 'test-model' },
    });

    try {
      expect(toolNames(server)).toEqual(expectedPassthroughTools.sort());
    } finally {
      eventStore.close();
    }
  });

  it('keeps execution support tools registered when an API key enables normal interview mode', async () => {
    const { server, eventStore } = await createMcpServer({
      dbPath: dbPath(),
      llm: { apiKey: 'sk-ant-test', model: 'test-model' },
      client: 'claude-code',
    });

    try {
      const names = toolNames(server);

      expect(names).toContain('ges_execute');
      expect(names).toContain('ges_agent');
      expect(names).toContain('ges_benchmark');
      expect(names).toContain('ges_code_graph');
      expect(names).toContain('ges_create_agent');
    } finally {
      eventStore.close();
    }
  });

  it('uses passthrough interview and spec schemas for Codex even when an API key exists', async () => {
    const { server, eventStore } = await createMcpServer({
      dbPath: dbPath(),
      llm: { apiKey: 'sk-ant-test', model: 'test-model' },
      client: 'codex',
    });

    try {
      const tools = registeredTools(server);

      expect(inputKeys(tools['ges_interview'])).toContain('generatedQuestion');
      expect(inputKeys(tools['ges_interview'])).toContain('resolutionScore');
      expect(inputKeys(tools['ges_generate_spec'])).toContain('text');
      expect(inputKeys(tools['ges_generate_spec'])).toContain('spec');
    } finally {
      eventStore.close();
    }
  });

  it('uses passthrough interview and spec schemas for Grok even when an API key exists', async () => {
    const { server, eventStore } = await createMcpServer({
      dbPath: dbPath(),
      llm: { apiKey: 'sk-ant-test', model: 'test-model' },
      client: 'grok',
    });

    try {
      const tools = registeredTools(server);

      expect(inputKeys(tools['ges_interview'])).toContain('generatedQuestion');
      expect(inputKeys(tools['ges_interview'])).toContain('resolutionScore');
      expect(inputKeys(tools['ges_generate_spec'])).toContain('text');
      expect(inputKeys(tools['ges_generate_spec'])).toContain('spec');
    } finally {
      eventStore.close();
    }
  });

  it('exposes reasoningModel via the passthrough ges_status handler (default real path, no session)', async () => {
    // No API key → passthrough interview registration wins → handleStatusPassthrough is the live handler.
    const { server, eventStore } = await createMcpServer({
      dbPath: dbPath(),
      llm: { apiKey: '', model: 'test-model' },
    });

    try {
      const status = callTool(server, 'ges_status', { sessionType: 'all' });

      // sessionId 없이 호출해도 resolved config 값이 나와야 한다 (스킬이 gestalt.json 직접 파싱 안 하게 하는 목적).
      expect(status.reasoningModel).toBe('fable');
      expect(status.reasoningModelFallback).toBe('opus');
      // tierModels도 같은 경로로 나와야 한다. 스킬들이 이 값으로 frugal 모델을 고르므로,
      // handleStatus에만 넣으면 단위 테스트는 통과하고 실제 호출에는 안 나온다.
      expect(status.tierModels).toEqual({ frugal: 'haiku', standard: 'sonnet', frontier: 'opus' });
    } finally {
      eventStore.close();
    }
  });

  it('reflects overridden tierModels through the passthrough ges_status handler', async () => {
    const { server, eventStore } = await createMcpServer({
      dbPath: dbPath(),
      llm: { apiKey: '', model: 'test-model' },
      tierModels: { frugal: 'sonnet', standard: 'sonnet', frontier: 'opus' },
    });

    try {
      const status = callTool(server, 'ges_status', { sessionType: 'all' });
      expect(status.tierModels.frugal).toBe('sonnet');
    } finally {
      eventStore.close();
    }
  });

  it('reflects overridden reasoningModel through the passthrough ges_status handler', async () => {
    const { server, eventStore } = await createMcpServer({
      dbPath: dbPath(),
      llm: { apiKey: '', model: 'test-model' },
      reasoningModel: 'sonnet',
      reasoningModelFallback: 'haiku',
    });

    try {
      const status = callTool(server, 'ges_status', { sessionType: 'all' });
      expect(status.reasoningModel).toBe('sonnet');
      expect(status.reasoningModelFallback).toBe('haiku');
    } finally {
      eventStore.close();
    }
  });

  it('uses passthrough interview for Claude Code even when an API key exists', async () => {
    const overrides: Partial<GestaltConfig> = {
      dbPath: dbPath(),
      llm: { apiKey: 'sk-ant-test', model: 'test-model' },
      client: 'claude-code',
    };
    const { server, eventStore } = await createMcpServer(overrides);

    try {
      const tools = registeredTools(server);

      // claude-code는 호스트가 LLM 역할 → passthrough 강제 (API 키 유무 무관)
      expect(inputKeys(tools['ges_interview'])).toContain('generatedQuestion');
      expect(inputKeys(tools['ges_generate_spec'])).toContain('text');
      expect(tools['ges_execute']).toBeDefined();
      expect(tools['ges_code_graph']).toBeDefined();
    } finally {
      eventStore.close();
    }
  });
});

// ─── 업데이트 알림이 도구 응답에 실리는 자리 ─────────────────────────────────

describe('업데이트 알림', () => {
  /** 캐시가 남아 있으면 fetch를 안 타서 mock한 latest가 안 걸린다 */
  async function clearUpdateCache() {
    const { gestaltPath } = await import('../../../src/core/home.js');
    rmSync(gestaltPath('.update-check'), { force: true });
  }

  /** 서버 기동 때 도는 조회를 흉내내 "새 버전 있음" 상태를 만든다 */
  async function primeUpdateAvailable() {
    await clearUpdateCache();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ version: '999.0.0' }),
    } as Response);

    const { checkForUpdates, resetUpdateBanner } = await import('../../../src/core/version.js');
    resetUpdateBanner();
    await checkForUpdates();
    fetchSpy.mockRestore();
    await clearUpdateCache();
  }

  /**
   * "이미 최신" 상태를 만든다.
   *
   * `resetUpdateBanner()`만으로는 안 된다 — 그건 1회 플래그만 되돌리고 앞 테스트가
   * 채워둔 조회 결과는 모듈에 그대로 남는다. latest를 낮은 값으로 다시 조회시켜 덮는다.
   */
  async function primeUpToDate() {
    await clearUpdateCache();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.0.1' }),
    } as Response);

    const { checkForUpdates, resetUpdateBanner } = await import('../../../src/core/version.js');
    resetUpdateBanner();
    await checkForUpdates();
    fetchSpy.mockRestore();
    await clearUpdateCache();
  }

  afterEach(async () => {
    await clearUpdateCache();
    const { resetUpdateBanner } = await import('../../../src/core/version.js');
    resetUpdateBanner();
  });

  /** 배너를 붙이든 말든 첫 블록은 그대로 도구 결과여야 한다 */
  function rawCall(server: unknown, name: string) {
    const tool = registeredTools(server)[name];
    if (!tool?.handler) throw new Error(`Tool ${name} has no handler`);
    return tool.handler({ sessionType: 'all' }, {});
  }

  it('첫 도구 호출에 알림이 따라붙는다', async () => {
    await primeUpdateAvailable();
    const { server, eventStore } = await createMcpServer({ dbPath: dbPath() });

    try {
      const result = rawCall(server, 'ges_status');
      expect(result.content).toHaveLength(2);
      expect(result.content[1]?.text).toContain('999.0.0');
    } finally {
      eventStore.close();
    }
  });

  // 스킬들이 content[0]을 JSON.parse 한다. 알림을 같은 블록에 이어 붙이면 전부 깨진다.
  it('알림이 붙어도 첫 블록은 그대로 JSON이다', async () => {
    await primeUpdateAvailable();
    const { server, eventStore } = await createMcpServer({ dbPath: dbPath() });

    try {
      const result = rawCall(server, 'ges_status');
      expect(() => JSON.parse(result.content[0]?.text ?? '')).not.toThrow();
    } finally {
      eventStore.close();
    }
  });

  it('두 번째 호출부터는 안 붙는다', async () => {
    await primeUpdateAvailable();
    const { server, eventStore } = await createMcpServer({ dbPath: dbPath() });

    try {
      rawCall(server, 'ges_status');
      expect(rawCall(server, 'ges_status').content).toHaveLength(1);
    } finally {
      eventStore.close();
    }
  });

  // 게슈탈트를 안 쓰는 세션에 얹지 않는다는 게 이 방식을 고른 이유다.
  it('최신이면 아무것도 안 붙는다', async () => {
    await primeUpToDate();

    const { server, eventStore } = await createMcpServer({ dbPath: dbPath() });
    try {
      expect(rawCall(server, 'ges_status').content).toHaveLength(1);
    } finally {
      eventStore.close();
    }
  });
});
