import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../../src/mcp/server.js';
import type { GestaltConfig } from '../../../src/core/config.js';

type RegisteredToolMap = Record<string, { inputSchema?: Record<string, unknown> }>;

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

  it('keeps direct-LLM interview and spec schemas for Claude Code when an API key exists', async () => {
    const overrides: Partial<GestaltConfig> = {
      dbPath: dbPath(),
      llm: { apiKey: 'sk-ant-test', model: 'test-model' },
      client: 'claude-code',
    };
    const { server, eventStore } = await createMcpServer(overrides);

    try {
      const tools = registeredTools(server);

      expect(inputKeys(tools['ges_interview'])).not.toContain('generatedQuestion');
      expect(inputKeys(tools['ges_generate_spec'])).not.toContain('text');
      expect(tools['ges_execute']).toBeDefined();
      expect(tools['ges_code_graph']).toBeDefined();
    } finally {
      eventStore.close();
    }
  });
});
