/**
 * CodeGraphEngine 통합 테스트
 *
 * CodeGraphEngine은 `glob` 패키지에 의존하므로, engine을 직접 import하는 대신
 * CodeGraphStore + computeBlastRadius를 조합하여 engine의 핵심 로직을 검증한다.
 * (glob이 설치되면 import 방식으로 전환 가능)
 */
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CodeGraphStore } from '../../../src/code-graph/storage.js';
import { computeBlastRadius } from '../../../src/code-graph/blast-radius.js';
import { NodeKind, EdgeKind } from '../../../src/code-graph/types.js';
import type { CodeGraphNode, CodeGraphEdge } from '../../../src/code-graph/types.js';

function makeNode(
  id: string,
  filePath: string,
  isTest = false,
  kind = NodeKind.Function,
): CodeGraphNode {
  return {
    id,
    kind,
    name: id.split(':').pop() ?? id,
    filePath,
    isTest,
    updatedAt: Date.now(),
  };
}

function makeEdge(
  sourceId: string,
  targetId: string,
  kind: EdgeKind = EdgeKind.CALLS,
): CodeGraphEdge {
  return { kind, sourceId, targetId, updatedAt: Date.now() };
}

describe('CodeGraph Engine (store + blast-radius)', () => {
  let store: CodeGraphStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/code-graph-${randomUUID()}.db`;
    store = new CodeGraphStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(`${dbPath}-wal`)) rmSync(`${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) rmSync(`${dbPath}-shm`);
  });

  describe('dbExists 시뮬레이션', () => {
    it('store 초기화 후 DB 파일이 존재한다', () => {
      // CodeGraphEngine.dbExists()와 동일한 로직: existsSync(dbPath)
      expect(existsSync(dbPath)).toBe(true);
    });

    it('존재하지 않는 경로는 false를 반환한다', () => {
      expect(existsSync('.gestalt-test/nonexistent.db')).toBe(false);
    });
  });

  describe('stats() 시뮬레이션', () => {
    it('빈 그래프에서 모든 카운트가 0이다', () => {
      const stats = store.getStats(dbPath);
      expect(stats.totalFiles).toBe(0);
      expect(stats.totalNodes).toBe(0);
      expect(stats.totalEdges).toBe(0);
      expect(stats.lastBuiltAt).toBeNull();
      expect(stats.dbSizeBytes).toBeGreaterThan(0);
    });

    it('노드와 엣지 삽입 후 stats가 갱신된다', () => {
      store.upsertNode(makeNode('fn:src/a.ts:fnA', 'src/a.ts'));
      store.upsertNode(makeNode('fn:src/b.ts:fnB', 'src/b.ts'));
      store.upsertNode(makeNode('fn:src/c.ts:fnC', 'src/c.ts'));
      store.upsertEdge(makeEdge('fn:src/a.ts:fnA', 'fn:src/b.ts:fnB'));
      store.upsertEdge(makeEdge('fn:src/b.ts:fnB', 'fn:src/c.ts:fnC'));

      const stats = store.getStats(dbPath);
      expect(stats.totalFiles).toBe(3);
      expect(stats.totalNodes).toBe(3);
      expect(stats.totalEdges).toBe(2);
      expect(stats.lastBuiltAt).not.toBeNull();
    });
  });

  describe('query() 시뮬레이션 — callers_of', () => {
    it('특정 함수를 호출하는 노드를 찾는다', () => {
      const targetId = 'function:/repo/src/auth.ts:login';
      const callerId = 'function:/repo/src/app.ts:run';
      const unrelatedId = 'function:/repo/src/other.ts:doSomething';

      store.upsertNode(makeNode(targetId, '/repo/src/auth.ts'));
      store.upsertNode(makeNode(callerId, '/repo/src/app.ts'));
      store.upsertNode(makeNode(unrelatedId, '/repo/src/other.ts'));

      // app → auth (CALLS)
      store.upsertEdge(makeEdge(callerId, targetId, EdgeKind.CALLS));
      // other → auth (IMPORTS_FROM, CALLS가 아님)
      store.upsertEdge(makeEdge(unrelatedId, targetId, EdgeKind.IMPORTS_FROM));

      // callers_of: targetId를 target으로 가지는 CALLS 엣지의 source만 반환
      const incomingEdges = store.getEdgesByTarget(targetId);
      const callerNodes = incomingEdges
        .filter((e) => e.kind === EdgeKind.CALLS)
        .map((e) => store.getNodeById(e.sourceId))
        .filter(Boolean);

      expect(callerNodes).toHaveLength(1);
      expect(callerNodes[0]?.id).toBe(callerId);
    });
  });

  describe('query() 시뮬레이션 — callees_of', () => {
    it('특정 함수가 호출하는 노드를 찾는다', () => {
      const sourceId = 'function:/repo/src/app.ts:run';
      const calleeA = 'function:/repo/src/auth.ts:login';
      const calleeB = 'function:/repo/src/db.ts:connect';

      store.upsertNode(makeNode(sourceId, '/repo/src/app.ts'));
      store.upsertNode(makeNode(calleeA, '/repo/src/auth.ts'));
      store.upsertNode(makeNode(calleeB, '/repo/src/db.ts'));

      store.upsertEdge(makeEdge(sourceId, calleeA, EdgeKind.CALLS));
      store.upsertEdge(makeEdge(sourceId, calleeB, EdgeKind.CALLS));

      const outEdges = store.getEdgesBySource(sourceId);
      const calleeNodes = outEdges
        .filter((e) => e.kind === EdgeKind.CALLS)
        .map((e) => store.getNodeById(e.targetId))
        .filter(Boolean);

      expect(calleeNodes).toHaveLength(2);
      const calleeIds = calleeNodes.map((n) => n?.id);
      expect(calleeIds).toContain(calleeA);
      expect(calleeIds).toContain(calleeB);
    });
  });

  describe('query() 시뮬레이션 — tests_for', () => {
    it('특정 파일에 대한 테스트 노드를 찾는다', () => {
      const authFileId = 'file:/repo/src/auth.ts';
      const testFileId = 'file:/repo/tests/auth.test.ts';
      const nonTestFileId = 'file:/repo/src/consumer.ts';

      store.upsertNode(makeNode(authFileId, '/repo/src/auth.ts', false, NodeKind.File));
      store.upsertNode(makeNode(testFileId, '/repo/tests/auth.test.ts', true, NodeKind.File));
      store.upsertNode(makeNode(nonTestFileId, '/repo/src/consumer.ts', false, NodeKind.File));

      store.upsertEdge(makeEdge(testFileId, authFileId, EdgeKind.IMPORTS_FROM));
      store.upsertEdge(makeEdge(nonTestFileId, authFileId, EdgeKind.IMPORTS_FROM));

      // tests_for: isTest=true인 노드만
      const incomingEdges = store.getEdgesByTarget(authFileId);
      const testNodes = incomingEdges
        .map((e) => store.getNodeById(e.sourceId))
        .filter((n) => n?.isTest === true);

      expect(testNodes).toHaveLength(1);
      expect(testNodes[0]?.id).toBe(testFileId);
    });
  });

  describe('query() 시뮬레이션 — imports_of', () => {
    it('특정 파일을 import하는 노드를 찾는다', () => {
      const authFileId = 'file:/repo/src/auth.ts';
      const importerA = 'file:/repo/src/app.ts';
      const importerB = 'file:/repo/src/middleware.ts';
      const unrelated = 'file:/repo/src/db.ts';

      store.upsertNode(makeNode(authFileId, '/repo/src/auth.ts', false, NodeKind.File));
      store.upsertNode(makeNode(importerA, '/repo/src/app.ts', false, NodeKind.File));
      store.upsertNode(makeNode(importerB, '/repo/src/middleware.ts', false, NodeKind.File));
      store.upsertNode(makeNode(unrelated, '/repo/src/db.ts', false, NodeKind.File));

      store.upsertEdge(makeEdge(importerA, authFileId, EdgeKind.IMPORTS_FROM));
      store.upsertEdge(makeEdge(importerB, authFileId, EdgeKind.IMPORTS_FROM));
      // unrelated는 auth를 import하지 않음

      const incomingEdges = store.getEdgesByTarget(authFileId);
      const importerNodes = incomingEdges
        .filter((e) => e.kind === EdgeKind.IMPORTS_FROM)
        .map((e) => store.getNodeById(e.sourceId))
        .filter(Boolean);

      expect(importerNodes).toHaveLength(2);
      const importerIds = importerNodes.map((n) => n?.id);
      expect(importerIds).toContain(importerA);
      expect(importerIds).toContain(importerB);
      expect(importerIds).not.toContain(unrelated);
    });

    it('아무도 import하지 않는 파일은 빈 결과를 반환한다', () => {
      const isolatedId = 'file:/repo/src/isolated.ts';
      store.upsertNode(makeNode(isolatedId, '/repo/src/isolated.ts', false, NodeKind.File));

      const incomingEdges = store.getEdgesByTarget(isolatedId);
      const importerNodes = incomingEdges
        .filter((e) => e.kind === EdgeKind.IMPORTS_FROM)
        .map((e) => store.getNodeById(e.sourceId))
        .filter(Boolean);

      expect(importerNodes).toHaveLength(0);
    });
  });

  describe('blastRadius() 시뮬레이션', () => {
    it('변경 파일 기반으로 영향 범위를 계산한다', () => {
      const authPath = '/repo/src/auth.ts';
      const appPath = '/repo/src/app.ts';
      const testPath = '/repo/tests/auth.test.ts';

      store.upsertNode(makeNode(`fn:${authPath}:login`, authPath));
      store.upsertNode(makeNode(`fn:${appPath}:run`, appPath));
      store.upsertNode(makeNode(`fn:${testPath}:testLogin`, testPath, true));

      store.upsertEdge(makeEdge(`fn:${appPath}:run`, `fn:${authPath}:login`));
      store.upsertEdge(makeEdge(`fn:${testPath}:testLogin`, `fn:${authPath}:login`));

      const result = computeBlastRadius(store, [authPath], 2);

      expect(result.changedFiles).toContain(authPath);
      expect(result.maxDepthUsed).toBe(2);
      expect(result.riskScore).toBeGreaterThanOrEqual(0);
      expect(result.riskScore).toBeLessThanOrEqual(1);
    });
  });

  describe('incremental build 시뮬레이션', () => {
    it('파일 해시가 같으면 데이터를 유지한다 (skip 시뮬레이션)', () => {
      const filePath = '/repo/src/auth.ts';
      const hash = 'sha256:abcdef';

      // fileHash를 가진 File 노드를 먼저 삽입 (getFileHash는 LIMIT 1 반환)
      store.upsertNode({
        id: `file:${filePath}`,
        kind: NodeKind.File,
        name: 'auth.ts',
        filePath,
        isTest: false,
        fileHash: hash,
        updatedAt: Date.now(),
      });

      const savedHash = store.getFileHash(filePath);
      expect(savedHash).toBe(hash);

      // 해시가 같으면 스킵 (incremental mode)
      const shouldSkip = savedHash === hash;
      expect(shouldSkip).toBe(true);
    });

    it('파일 해시가 다르면 업데이트가 필요하다', () => {
      const filePath = '/repo/src/auth.ts';
      const oldHash = 'sha256:old';
      const newHash = 'sha256:new';

      store.upsertNode({
        id: `file:${filePath}`,
        kind: NodeKind.File,
        name: 'auth.ts',
        filePath,
        isTest: false,
        fileHash: oldHash,
        updatedAt: Date.now(),
      });

      const savedHash = store.getFileHash(filePath);
      const shouldSkip = savedHash === newHash;
      expect(shouldSkip).toBe(false);
    });
  });
});
