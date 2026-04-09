import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CodeGraphStore } from '../../../src/code-graph/storage.js';
import { NodeKind, EdgeKind } from '../../../src/code-graph/types.js';
import type { CodeGraphNode, CodeGraphEdge } from '../../../src/code-graph/types.js';

function makeNode(overrides: Partial<CodeGraphNode> = {}): CodeGraphNode {
  return {
    id: `function:src/auth.ts:login-${randomUUID()}`,
    kind: NodeKind.Function,
    name: 'login',
    filePath: 'src/auth.ts',
    lineStart: 10,
    lineEnd: 20,
    isTest: false,
    fileHash: 'abc123',
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeEdge(
  sourceId: string,
  targetId: string,
  overrides: Partial<CodeGraphEdge> = {},
): CodeGraphEdge {
  return {
    kind: EdgeKind.CALLS,
    sourceId,
    targetId,
    line: 15,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('CodeGraphStore', () => {
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

  it('WAL 모드로 DB를 초기화한다', () => {
    expect(existsSync(dbPath)).toBe(true);
  });

  describe('upsertNode()', () => {
    it('노드를 삽입한다', () => {
      const node = makeNode({ id: 'function:src/auth.ts:login', filePath: 'src/auth.ts' });
      store.upsertNode(node);

      const result = store.getNodeById('function:src/auth.ts:login');
      expect(result).not.toBeNull();
      expect(result?.name).toBe('login');
      expect(result?.kind).toBe(NodeKind.Function);
      expect(result?.filePath).toBe('src/auth.ts');
    });

    it('동일 id로 다시 삽입하면 업데이트된다', () => {
      const node = makeNode({
        id: 'function:src/auth.ts:login',
        name: 'login',
        filePath: 'src/auth.ts',
      });
      store.upsertNode(node);

      const updatedNode = { ...node, name: 'loginUpdated', lineStart: 99 };
      store.upsertNode(updatedNode);

      const result = store.getNodeById('function:src/auth.ts:login');
      expect(result?.name).toBe('loginUpdated');
      expect(result?.lineStart).toBe(99);
    });

    it('isTest 플래그가 올바르게 저장된다', () => {
      const testNode = makeNode({
        id: 'function:tests/auth.test.ts:testLogin',
        filePath: 'tests/auth.test.ts',
        isTest: true,
      });
      store.upsertNode(testNode);

      const result = store.getNodeById('function:tests/auth.test.ts:testLogin');
      expect(result?.isTest).toBe(true);
    });

    it('선택 필드(lineStart, lineEnd, fileHash)가 없어도 삽입된다', () => {
      const node: CodeGraphNode = {
        id: 'file:src/minimal.ts',
        kind: NodeKind.File,
        name: 'minimal.ts',
        filePath: 'src/minimal.ts',
        isTest: false,
        updatedAt: Date.now(),
      };
      store.upsertNode(node);

      const result = store.getNodeById('file:src/minimal.ts');
      expect(result).not.toBeNull();
      expect(result?.lineStart).toBeUndefined();
      expect(result?.fileHash).toBeUndefined();
    });
  });

  describe('upsertEdge()', () => {
    it('엣지를 삽입한다', () => {
      const source = makeNode({ id: 'function:src/a.ts:foo', filePath: 'src/a.ts' });
      const target = makeNode({ id: 'function:src/b.ts:bar', filePath: 'src/b.ts' });
      store.upsertNode(source);
      store.upsertNode(target);

      const edge = makeEdge('function:src/a.ts:foo', 'function:src/b.ts:bar');
      store.upsertEdge(edge);

      const edges = store.getEdgesBySource('function:src/a.ts:foo');
      expect(edges).toHaveLength(1);
      expect(edges[0]?.kind).toBe(EdgeKind.CALLS);
      expect(edges[0]?.targetId).toBe('function:src/b.ts:bar');
    });

    it('동일 source-target-kind 엣지를 중복 삽입하면 하나만 유지된다', () => {
      store.upsertEdge(makeEdge('src-id', 'tgt-id', { kind: EdgeKind.IMPORTS_FROM }));
      store.upsertEdge(makeEdge('src-id', 'tgt-id', { kind: EdgeKind.IMPORTS_FROM }));

      const edges = store.getEdgesBySource('src-id');
      const importEdges = edges.filter((e) => e.kind === EdgeKind.IMPORTS_FROM);
      expect(importEdges).toHaveLength(1);
    });

    it('다른 kind는 각각 독립적으로 삽입된다', () => {
      store.upsertEdge(makeEdge('src-id', 'tgt-id', { kind: EdgeKind.CALLS }));
      store.upsertEdge(makeEdge('src-id', 'tgt-id', { kind: EdgeKind.IMPORTS_FROM }));

      const edges = store.getEdgesBySource('src-id');
      expect(edges).toHaveLength(2);
    });
  });

  describe('getNodesByFile()', () => {
    it('특정 파일의 노드만 반환한다', () => {
      store.upsertNode(
        makeNode({ id: 'function:src/auth.ts:login', filePath: 'src/auth.ts', name: 'login' }),
      );
      store.upsertNode(
        makeNode({ id: 'function:src/auth.ts:logout', filePath: 'src/auth.ts', name: 'logout' }),
      );
      store.upsertNode(
        makeNode({ id: 'function:src/user.ts:getUser', filePath: 'src/user.ts', name: 'getUser' }),
      );

      const authNodes = store.getNodesByFile('src/auth.ts');
      expect(authNodes).toHaveLength(2);
      expect(authNodes.map((n) => n.name)).toContain('login');
      expect(authNodes.map((n) => n.name)).toContain('logout');
    });

    it('존재하지 않는 파일은 빈 배열을 반환한다', () => {
      const result = store.getNodesByFile('non-existent.ts');
      expect(result).toHaveLength(0);
    });
  });

  describe('getEdgesBySource() / getEdgesByTarget()', () => {
    it('source 기준으로 엣지를 조회한다', () => {
      store.upsertEdge(makeEdge('node-A', 'node-B'));
      store.upsertEdge(makeEdge('node-A', 'node-C'));
      store.upsertEdge(makeEdge('node-X', 'node-B'));

      const edges = store.getEdgesBySource('node-A');
      expect(edges).toHaveLength(2);
      const targets = edges.map((e) => e.targetId);
      expect(targets).toContain('node-B');
      expect(targets).toContain('node-C');
    });

    it('target 기준으로 엣지를 조회한다', () => {
      store.upsertEdge(makeEdge('node-A', 'node-B'));
      store.upsertEdge(makeEdge('node-X', 'node-B'));
      store.upsertEdge(makeEdge('node-Y', 'node-C'));

      const edges = store.getEdgesByTarget('node-B');
      expect(edges).toHaveLength(2);
      const sources = edges.map((e) => e.sourceId);
      expect(sources).toContain('node-A');
      expect(sources).toContain('node-X');
    });

    it('존재하지 않는 node는 빈 배열을 반환한다', () => {
      expect(store.getEdgesBySource('no-such-node')).toHaveLength(0);
      expect(store.getEdgesByTarget('no-such-node')).toHaveLength(0);
    });
  });

  describe('deleteByFile()', () => {
    it('파일 삭제 시 해당 파일의 노드가 제거된다', () => {
      store.upsertNode(makeNode({ id: 'function:src/auth.ts:login', filePath: 'src/auth.ts' }));
      store.upsertNode(makeNode({ id: 'function:src/user.ts:getUser', filePath: 'src/user.ts' }));

      store.deleteByFile('src/auth.ts');

      expect(store.getNodesByFile('src/auth.ts')).toHaveLength(0);
      expect(store.getNodesByFile('src/user.ts')).toHaveLength(1);
    });

    it('파일 삭제 시 해당 노드에 연결된 엣지도 삭제된다', () => {
      const authNodeId = 'function:src/auth.ts:login';
      const userNodeId = 'function:src/user.ts:getUser';

      store.upsertNode(makeNode({ id: authNodeId, filePath: 'src/auth.ts' }));
      store.upsertNode(makeNode({ id: userNodeId, filePath: 'src/user.ts' }));

      // authNode → userNode (outgoing from auth)
      store.upsertEdge(makeEdge(authNodeId, userNodeId));
      // userNode → authNode (incoming to auth)
      store.upsertEdge(makeEdge(userNodeId, authNodeId));

      store.deleteByFile('src/auth.ts');

      // authNode가 source 또는 target인 엣지 모두 삭제되어야 함
      expect(store.getEdgesBySource(authNodeId)).toHaveLength(0);
      expect(store.getEdgesByTarget(authNodeId)).toHaveLength(0);
    });

    it('존재하지 않는 파일을 삭제해도 에러가 발생하지 않는다', () => {
      expect(() => store.deleteByFile('non-existent.ts')).not.toThrow();
    });
  });

  describe('getStats()', () => {
    it('노드와 엣지가 없을 때 0으로 반환된다', () => {
      const stats = store.getStats(dbPath);
      expect(stats.totalFiles).toBe(0);
      expect(stats.totalNodes).toBe(0);
      expect(stats.totalEdges).toBe(0);
      expect(stats.lastBuiltAt).toBeNull();
    });

    it('노드 삽입 후 통계가 갱신된다', () => {
      store.upsertNode(makeNode({ id: 'node:src/a.ts:fn1', filePath: 'src/a.ts' }));
      store.upsertNode(makeNode({ id: 'node:src/a.ts:fn2', filePath: 'src/a.ts' }));
      store.upsertNode(makeNode({ id: 'node:src/b.ts:fn3', filePath: 'src/b.ts' }));
      store.upsertEdge(makeEdge('node:src/a.ts:fn1', 'node:src/b.ts:fn3'));

      const stats = store.getStats(dbPath);
      expect(stats.totalFiles).toBe(2);
      expect(stats.totalNodes).toBe(3);
      expect(stats.totalEdges).toBe(1);
      expect(stats.lastBuiltAt).not.toBeNull();
    });

    it('dbSizeBytes가 0보다 크다 (DB 파일 존재 시)', () => {
      store.upsertNode(makeNode({ id: 'node:src/a.ts:fn', filePath: 'src/a.ts' }));
      const stats = store.getStats(dbPath);
      expect(stats.dbSizeBytes).toBeGreaterThan(0);
    });
  });

  describe('getFileHash()', () => {
    it('저장된 파일 해시를 반환한다', () => {
      store.upsertNode(
        makeNode({
          id: 'file:src/auth.ts',
          filePath: 'src/auth.ts',
          fileHash: 'deadbeef1234',
        }),
      );

      const hash = store.getFileHash('src/auth.ts');
      expect(hash).toBe('deadbeef1234');
    });

    it('존재하지 않는 파일은 null을 반환한다', () => {
      const hash = store.getFileHash('non-existent.ts');
      expect(hash).toBeNull();
    });

    it('fileHash가 없는 노드는 null을 반환한다', () => {
      store.upsertNode(
        makeNode({
          id: 'file:src/no-hash.ts',
          filePath: 'src/no-hash.ts',
          fileHash: undefined,
        }),
      );

      const hash = store.getFileHash('src/no-hash.ts');
      expect(hash).toBeNull();
    });
  });
});
