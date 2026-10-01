import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMcpServer } from '../../../src/mcp/server.js';
import { executeInputSchema, interviewInputSchema } from '../../../src/mcp/schemas.js';

// MCP SDK가 등록 스키마로 입력을 먼저 검증한 뒤 핸들러가 schemas.ts로 다시 파싱한다.
// 두 곳의 action 목록이 어긋나면 핸들러가 처리하는 action이 SDK에서 거절된다.

interface RegisteredTool {
  description?: string;
  inputSchema?: z.ZodObject<z.ZodRawShape>;
}

let dbPaths: string[] = [];

function dbPath(): string {
  const path = `.gestalt-test/mcp-schema-parity-${randomUUID()}.db`;
  dbPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of dbPaths) {
    for (const suffix of ['', '-wal', '-shm', '.jsonl']) {
      if (existsSync(path + suffix)) rmSync(path + suffix);
    }
  }
  dbPaths = [];
});

// API 키가 있어도 client가 단일 호스트면 passthrough로 뜬다. normal 모드는 키와 'both'가 함께일 때만이다.
async function withTools(
  mode: 'passthrough' | 'normal',
  fn: (tools: Record<string, RegisteredTool>) => void,
): Promise<void> {
  const { server, eventStore } = await createMcpServer({
    dbPath: dbPath(),
    llm: { apiKey: mode === 'normal' ? 'sk-ant-test' : '', model: 'test-model' },
    client: mode === 'normal' ? 'both' : 'claude-code',
  });
  try {
    fn(
      (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools,
    );
  } finally {
    eventStore.close();
  }
}

/** guardShape가 감싼 래퍼를 벗겨 action enum의 선택지를 꺼낸다. */
function registeredActions(tool: RegisteredTool | undefined): string[] {
  let node: z.ZodTypeAny | undefined = tool?.inputSchema?.shape['action'];
  while (node && !(node instanceof z.ZodEnum)) {
    const def = node._def as { schema?: z.ZodTypeAny; innerType?: z.ZodTypeAny };
    node = def.schema ?? def.innerType;
  }
  if (!node) throw new Error('registered action enum not found');
  return [...(node as z.ZodEnum<[string, ...string[]]>).options];
}

describe('등록 스키마와 schemas.ts의 action 목록', () => {
  it('passthrough ges_interview는 schemas.ts와 같다', async () => {
    await withTools('passthrough', (tools) => {
      const tool = tools['ges_interview'];
      expect(registeredActions(tool)).toEqual(interviewInputSchema.shape.action.options);
      for (const action of interviewInputSchema.shape.action.options) {
        expect(tool?.description).toContain(action);
      }
    });
  });

  it('passthrough ges_interview가 compress 호출을 통과시킨다', async () => {
    await withTools('passthrough', (tools) => {
      const schema = tools['ges_interview']?.inputSchema;
      const parsed = schema?.safeParse({
        action: 'compress',
        sessionId: 's-1',
        compressedSummary: 'summary',
      });
      expect(parsed?.success).toBe(true);
    });
  });

  it('normal ges_interview는 passthrough 전용인 compress만 빠진다', async () => {
    await withTools('normal', (tools) => {
      const expected = interviewInputSchema.shape.action.options.filter((a) => a !== 'compress');
      expect(registeredActions(tools['ges_interview'])).toEqual(expected);
    });
  });

  it('ges_execute는 schemas.ts와 같고 설명에도 전부 나온다', async () => {
    await withTools('passthrough', (tools) => {
      const tool = tools['ges_execute'];
      expect(registeredActions(tool)).toEqual(executeInputSchema.shape.action.options);
      for (const action of executeInputSchema.shape.action.options) {
        expect(tool?.description).toContain(action);
      }
    });
  });
});
