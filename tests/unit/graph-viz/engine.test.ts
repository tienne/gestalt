import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { GraphVisualizationEngine } from '../../../src/graph-viz/engine.js';
import { CodeGraphStore } from '../../../src/code-graph/storage.js';
import { NodeKind, EdgeKind } from '../../../src/code-graph/types.js';
import type { CodeGraphNode, CodeGraphEdge } from '../../../src/code-graph/types.js';

// ─── Helpers ─────────────────────────────────────────────────────

function makeNode(id: string): CodeGraphNode {
  return {
    id,
    kind: NodeKind.File,
    name: id,
    filePath: `src/${id}.ts`,
    isTest: false,
    updatedAt: Date.now(),
  };
}

function makeEdge(sourceId: string, targetId: string): CodeGraphEdge {
  return { kind: EdgeKind.IMPORTS_FROM, sourceId, targetId, updatedAt: Date.now() };
}

/**
 * 테스트용 임시 저장소 디렉토리.
 * 각 테스트가 고유 경로를 사용해 병렬 실행 시 충돌을 방지한다.
 */
function testDbPath(): { repoRoot: string; dbPath: string; cleanup: () => void } {
  const id = randomUUID();
  const repoRoot = join('.gestalt-test', `graph-viz-engine-${id}`);
  const gestaltDir = join(repoRoot, '.gestalt');
  const dbPath = join(gestaltDir, 'code-graph.db');
  return {
    repoRoot,
    dbPath,
    cleanup: () => {
      if (existsSync(repoRoot)) rmSync(repoRoot, { recursive: true });
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('GraphVisualizationEngine', () => {
  const engines: GraphVisualizationEngine[] = [];

  afterEach(async () => {
    await Promise.all(engines.map((e) => e.stop().catch(() => {})));
    engines.length = 0;
    vi.restoreAllMocks();
  });

  it('DB가 존재하면 노드/엣지를 로드하고 서버를 기동한다', async () => {
    const { repoRoot, dbPath, cleanup } = testDbPath();

    try {
      // DB를 미리 생성하고 데이터 삽입
      mkdirSync(join(repoRoot, '.gestalt'), { recursive: true });
      const store = new CodeGraphStore(dbPath);
      const node = makeNode(`file-${randomUUID()}`);
      const edge = makeEdge(node.id, node.id);
      store.upsertNode(node);
      store.upsertEdge(edge);
      store.close();

      const engine = new GraphVisualizationEngine();
      engines.push(engine);

      const result = await engine.start({ repoRoot, openBrowser: false });

      expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(result.port).toBeGreaterThan(0);
      expect(result.message).toContain('1 nodes');
      expect(result.message).toContain('1 edges');
    } finally {
      cleanup();
    }
  });

  it('DB가 없으면 CodeGraphEngine.build()를 자동 호출한다', async () => {
    const { repoRoot, cleanup } = testDbPath();

    try {
      // DB를 생성하지 않은 채로 시작 — engine.ts 내부에서 build()를 호출해야 함
      // CodeGraphEngine.build를 모킹해 실제 파일 시스템 분석을 건너뜀
      const { CodeGraphEngine } = await import('../../../src/code-graph/engine.js');
      const buildSpy = vi.spyOn(CodeGraphEngine.prototype, 'build').mockImplementation(() => {
        // DB 파일만 만들어 두어 이후 CodeGraphStore가 열 수 있도록 함
        const gestaltDir = join(repoRoot, '.gestalt');
        mkdirSync(gestaltDir, { recursive: true });
        const store = new CodeGraphStore(join(gestaltDir, 'code-graph.db'));
        store.close();
        return { nodesBuilt: 0, edgesBuilt: 0, timeTakenMs: 1, installedHook: false };
      });

      const engine = new GraphVisualizationEngine();
      engines.push(engine);

      const result = await engine.start({ repoRoot, openBrowser: false });

      expect(buildSpy).toHaveBeenCalledOnce();
      expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      cleanup();
    }
  });

  it('stop()은 미시작 상태에서 호출해도 에러가 없다', async () => {
    const engine = new GraphVisualizationEngine();
    await expect(engine.stop()).resolves.toBeUndefined();
  });

  it('포트를 지정하면 해당 포트(또는 이후 포트)로 서버가 기동된다', async () => {
    const { repoRoot, dbPath, cleanup } = testDbPath();

    try {
      mkdirSync(join(repoRoot, '.gestalt'), { recursive: true });
      const store = new CodeGraphStore(dbPath);
      store.close();

      const engine = new GraphVisualizationEngine();
      engines.push(engine);

      const result = await engine.start({ repoRoot, port: 28500, openBrowser: false });
      expect(result.port).toBeGreaterThanOrEqual(28500);
    } finally {
      cleanup();
    }
  });
});
