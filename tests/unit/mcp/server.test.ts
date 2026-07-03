import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
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
