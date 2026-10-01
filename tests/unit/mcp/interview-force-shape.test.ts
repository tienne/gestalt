/**
 * MCP SDK는 등록 shape에 없는 키를 handler에 넘기기 전에 지운다.
 * handler를 직접 부르는 테스트로는 shape 누락이 안 잡혀서 등록된 shape를 따로 본다.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { createMcpServer } from '../../../src/mcp/server.js';

interface RegisteredTool {
  inputSchema?: { shape?: Record<string, ZodTypeAny> };
}

const dbPaths: string[] = [];

function dbPath(): string {
  const path = `.gestalt-test/interview-force-shape-${randomUUID()}.db`;
  dbPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of dbPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`, { force: true });
    }
  }
});

describe('ges_interview 등록 shape의 force', () => {
  // API 키가 있어도 client가 단일 호스트면 passthrough로 뜬다. normal 모드는 키와 'both'가 함께일 때만이다.
  it.each([
    ['passthrough', '', 'claude-code'],
    ['normal', 'sk-ant-test', 'both'],
  ] as const)('%s 모드 shape에 force가 있다', async (mode, apiKey, client) => {
    const { server, eventStore } = await createMcpServer({
      dbPath: dbPath(),
      llm: { apiKey, model: 'test-model' },
      client,
    });

    try {
      const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
        ._registeredTools;
      const shape = tools['ges_interview']?.inputSchema?.shape;
      // compress는 passthrough에만 등록된다. 모드가 의도대로 떴는지 이걸로 본다.
      expect(shape?.['compressedSummary'] !== undefined).toBe(mode === 'passthrough');
      const force = shape?.['force'];
      expect(force).toBeDefined();
      expect(force!.safeParse(true).success).toBe(true);
    } finally {
      eventStore.close();
    }
  });
});
