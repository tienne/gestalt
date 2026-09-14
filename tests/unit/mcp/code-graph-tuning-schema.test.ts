/**
 * 이력 신호 임계 파라미터의 범위 검증.
 *
 * 같은 파라미터가 두 군데 선언돼 있다 — `schemas.ts`의 공개 스키마와
 * `server.ts`가 `server.tool()`에 인라인으로 넘기는 shape. 한쪽만 고치면
 * 호출 경로에 따라 통과 여부가 갈린다. 그래서 같은 표를 양쪽에 돌린다.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { createMcpServer } from '../../../src/mcp/server.js';
import { codeGraphInputSchema } from '../../../src/mcp/schemas.js';
import { handleCodeGraphPassthrough } from '../../../src/mcp/tools/code-graph-passthrough.js';
import { codeGraphEngine } from '../../../src/code-graph/index.js';

interface RegisteredTool {
  inputSchema?: { shape?: Record<string, ZodTypeAny> };
}

const dbPaths: string[] = [];

function dbPath(): string {
  const path = `.gestalt-test/code-graph-tuning-${randomUUID()}.db`;
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

/** [필드, 값, 통과해야 하는가] */
const CASES: [string, unknown, boolean][] = [
  ['limit', 30, true],
  ['limit', 0, true],
  ['limit', 500, true],
  ['limit', -1, false],
  ['limit', 1.5, false],
  ['limit', 501, false],
  ['minPairCount', 3, true],
  ['minPairCount', 0, true],
  ['minPairCount', -1, false],
  ['minPairCount', 2.5, false],
  ['minConfidence', 0, true],
  ['minConfidence', 0.3, true],
  ['minConfidence', 1, true],
  ['minConfidence', -0.1, false],
  ['minConfidence', 1.1, false],
];

describe('code graph 임계 파라미터 범위', () => {
  it('schemas.ts의 공개 스키마가 범위를 강제한다', () => {
    for (const [field, value, shouldPass] of CASES) {
      const parsed = codeGraphInputSchema.safeParse({
        action: 'co_change',
        repoRoot: '/repo',
        [field]: value,
      });
      expect(parsed.success, `${field}=${String(value)}`).toBe(shouldPass);
    }
  });

  it('server.ts의 인라인 shape가 같은 범위를 강제한다', async () => {
    const { server, eventStore } = await createMcpServer({
      dbPath: dbPath(),
      llm: { apiKey: '', model: 'test-model' },
    });

    try {
      const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
        ._registeredTools;
      const shape = tools['ges_code_graph']?.inputSchema?.shape;
      expect(shape).toBeDefined();

      for (const [field, value, shouldPass] of CASES) {
        const fieldSchema = shape![field];
        expect(fieldSchema, `${field} is declared inline`).toBeDefined();
        expect(fieldSchema!.safeParse(value).success, `${field}=${String(value)}`).toBe(shouldPass);
      }
    } finally {
      eventStore.close();
    }
  });
});

describe('임계 파라미터가 세 액션에 모두 닿는다', () => {
  const tuning = { limit: 7, minPairCount: 2, minConfidence: 0.4 };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blast_radius가 임계를 엔진까지 넘긴다', async () => {
    const spy = vi
      .spyOn(codeGraphEngine, 'blastRadius')
      .mockReturnValue({} as ReturnType<typeof codeGraphEngine.blastRadius>);

    await handleCodeGraphPassthrough({
      action: 'blast_radius',
      repoRoot: '/repo',
      ...tuning,
    });

    expect(spy.mock.calls[0]![1]!.coChange).toEqual(tuning);
  });

  it('diff_radius가 임계를 엔진까지 넘긴다', async () => {
    const spy = vi
      .spyOn(codeGraphEngine, 'diffRadius')
      .mockReturnValue({} as ReturnType<typeof codeGraphEngine.diffRadius>);

    await handleCodeGraphPassthrough({
      action: 'diff_radius',
      repoRoot: '/repo',
      ...tuning,
    });

    expect(spy.mock.calls[0]![1]!.coChange).toEqual(tuning);
  });

  it('co_change도 같은 임계를 받는다', async () => {
    const spy = vi
      .spyOn(codeGraphEngine, 'coChange')
      .mockReturnValue({} as ReturnType<typeof codeGraphEngine.coChange>);

    await handleCodeGraphPassthrough({
      action: 'co_change',
      repoRoot: '/repo',
      ...tuning,
    });

    expect(spy.mock.calls[0]![1]).toMatchObject(tuning);
  });
});
