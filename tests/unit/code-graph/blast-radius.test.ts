import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CodeGraphStore } from '../../../src/code-graph/storage.js';
import { computeBlastRadius } from '../../../src/code-graph/blast-radius.js';
import { NodeKind, EdgeKind } from '../../../src/code-graph/types.js';
import type { CodeGraphNode, CodeGraphEdge } from '../../../src/code-graph/types.js';

function makeNode(id: string, filePath: string, isTest = false): CodeGraphNode {
  return {
    id,
    kind: NodeKind.Function,
    name: id.split(':').pop() ?? id,
    filePath,
    isTest,
    updatedAt: Date.now(),
  };
}

function makeEdge(sourceId: string, targetId: string, kind: EdgeKind = EdgeKind.IMPORTS_FROM): CodeGraphEdge {
  return {
    kind,
    sourceId,
    targetId,
    updatedAt: Date.now(),
  };
}

describe('computeBlastRadius()', () => {
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

  it('changedFiles가 빈 배열이면 빈 결과를 반환한다', () => {
    store.upsertNode(makeNode('function:src/a.ts:fn', 'src/a.ts'));

    const result = computeBlastRadius(store, []);

    expect(result.changedFiles).toHaveLength(0);
    expect(result.impactedFiles).toHaveLength(0);
    expect(result.impactedNodes).toHaveLength(0);
    expect(result.riskScore).toBe(0);
    expect(result.summary).toContain('No changed files');
  });

  it('변경 파일을 직접 의존하는 노드를 추적한다', () => {
    // 그래프: consumer.ts → auth.ts (consumer가 auth를 import)
    const authNode = makeNode('function:src/auth.ts:login', 'src/auth.ts');
    const consumerNode = makeNode('function:src/consumer.ts:use', 'src/consumer.ts');

    store.upsertNode(authNode);
    store.upsertNode(consumerNode);

    // consumer → auth (consumer가 auth에 의존)
    store.upsertEdge(makeEdge('function:src/consumer.ts:use', 'function:src/auth.ts:login'));

    const result = computeBlastRadius(store, ['src/auth.ts']);

    // consumer가 auth에 의존하므로 영향받음
    expect(result.impactedNodes.some((n) => n.filePath === 'src/consumer.ts')).toBe(true);
    expect(result.changedFiles).toContain('src/auth.ts');
  });

  it('maxDepth=1이면 1단계 의존만 추적한다', () => {
    // 그래프: C → B → A (A가 변경됨)
    const nodeA = makeNode('fn:src/a.ts:fnA', 'src/a.ts');
    const nodeB = makeNode('fn:src/b.ts:fnB', 'src/b.ts');
    const nodeC = makeNode('fn:src/c.ts:fnC', 'src/c.ts');

    store.upsertNode(nodeA);
    store.upsertNode(nodeB);
    store.upsertNode(nodeC);

    // B → A, C → B (역방향 BFS)
    store.upsertEdge(makeEdge('fn:src/b.ts:fnB', 'fn:src/a.ts:fnA'));
    store.upsertEdge(makeEdge('fn:src/c.ts:fnC', 'fn:src/b.ts:fnB'));

    const resultDepth1 = computeBlastRadius(store, ['src/a.ts'], 1);

    // depth=1이면 B만 포함, C는 포함 안 됨
    const impactedFilePaths = resultDepth1.impactedNodes.map((n) => n.filePath);
    expect(impactedFilePaths).toContain('src/b.ts');
    expect(impactedFilePaths).not.toContain('src/c.ts');
    expect(resultDepth1.maxDepthUsed).toBe(1);
  });

  it('maxDepth=2이면 2단계 의존까지 추적한다', () => {
    // 그래프: C → B → A (A가 변경됨)
    const nodeA = makeNode('fn:src/a.ts:fnA', 'src/a.ts');
    const nodeB = makeNode('fn:src/b.ts:fnB', 'src/b.ts');
    const nodeC = makeNode('fn:src/c.ts:fnC', 'src/c.ts');

    store.upsertNode(nodeA);
    store.upsertNode(nodeB);
    store.upsertNode(nodeC);

    store.upsertEdge(makeEdge('fn:src/b.ts:fnB', 'fn:src/a.ts:fnA'));
    store.upsertEdge(makeEdge('fn:src/c.ts:fnC', 'fn:src/b.ts:fnB'));

    const resultDepth2 = computeBlastRadius(store, ['src/a.ts'], 2);

    const impactedFilePaths = resultDepth2.impactedNodes.map((n) => n.filePath);
    expect(impactedFilePaths).toContain('src/b.ts');
    expect(impactedFilePaths).toContain('src/c.ts');
  });

  it('테스트 파일이 impactedNodes에서 먼저 정렬된다', () => {
    const authNode = makeNode('fn:src/auth.ts:login', 'src/auth.ts');
    const appNode = makeNode('fn:src/app.ts:run', 'src/app.ts');
    const testNode = makeNode('fn:tests/auth.test.ts:testLogin', 'tests/auth.test.ts', true);

    store.upsertNode(authNode);
    store.upsertNode(appNode);
    store.upsertNode(testNode);

    // appNode와 testNode 모두 authNode에 의존
    store.upsertEdge(makeEdge('fn:src/app.ts:run', 'fn:src/auth.ts:login'));
    store.upsertEdge(makeEdge('fn:tests/auth.test.ts:testLogin', 'fn:src/auth.ts:login'));

    const result = computeBlastRadius(store, ['src/auth.ts'], 2);

    // impactedNodes에서 isTest=true인 노드가 앞에 와야 함
    const firstNonSeedImpacted = result.impactedNodes[0];
    expect(firstNonSeedImpacted?.isTest).toBe(true);
  });

  it('테스트 파일이 impactedFiles에서 먼저 정렬된다', () => {
    const authNode = makeNode('fn:src/auth.ts:login', 'src/auth.ts');
    const testNode = makeNode('fn:tests/auth.test.ts:testLogin', 'tests/auth.test.ts', true);
    const appNode = makeNode('fn:src/app.ts:run', 'src/app.ts');

    store.upsertNode(authNode);
    store.upsertNode(testNode);
    store.upsertNode(appNode);

    store.upsertEdge(makeEdge('fn:tests/auth.test.ts:testLogin', 'fn:src/auth.ts:login'));
    store.upsertEdge(makeEdge('fn:src/app.ts:run', 'fn:src/auth.ts:login'));

    const result = computeBlastRadius(store, ['src/auth.ts'], 2);

    // impactedFiles에서 테스트 파일이 먼저 나와야 함
    const testFileIndex = result.impactedFiles.findIndex((f) => f.includes('.test.'));
    const nonTestIndex = result.impactedFiles.findIndex((f) => f === 'src/app.ts');

    if (testFileIndex !== -1 && nonTestIndex !== -1) {
      expect(testFileIndex).toBeLessThan(nonTestIndex);
    }
  });

  it('순환 의존성이 있어도 무한 루프 없이 종료된다', () => {
    // A → B → C → A (순환)
    const nodeA = makeNode('fn:src/a.ts:fnA', 'src/a.ts');
    const nodeB = makeNode('fn:src/b.ts:fnB', 'src/b.ts');
    const nodeC = makeNode('fn:src/c.ts:fnC', 'src/c.ts');

    store.upsertNode(nodeA);
    store.upsertNode(nodeB);
    store.upsertNode(nodeC);

    store.upsertEdge(makeEdge('fn:src/a.ts:fnA', 'fn:src/b.ts:fnB'));
    store.upsertEdge(makeEdge('fn:src/b.ts:fnB', 'fn:src/c.ts:fnC'));
    store.upsertEdge(makeEdge('fn:src/c.ts:fnC', 'fn:src/a.ts:fnA'));

    // 타임아웃 없이 정상 종료되어야 함
    expect(() => computeBlastRadius(store, ['src/a.ts'], 3)).not.toThrow();
  });

  it('riskScore가 0과 1 사이의 값이다', () => {
    const nodeA = makeNode('fn:src/a.ts:fnA', 'src/a.ts');
    const nodeB = makeNode('fn:src/b.ts:fnB', 'src/b.ts');
    const nodeC = makeNode('fn:src/c.ts:fnC', 'src/c.ts');

    store.upsertNode(nodeA);
    store.upsertNode(nodeB);
    store.upsertNode(nodeC);

    store.upsertEdge(makeEdge('fn:src/b.ts:fnB', 'fn:src/a.ts:fnA'));
    store.upsertEdge(makeEdge('fn:src/c.ts:fnC', 'fn:src/a.ts:fnA'));

    const result = computeBlastRadius(store, ['src/a.ts'], 2);

    expect(result.riskScore).toBeGreaterThanOrEqual(0);
    expect(result.riskScore).toBeLessThanOrEqual(1);
  });

  it('노드가 하나도 없는 그래프에서 riskScore는 0이다', () => {
    const result = computeBlastRadius(store, ['src/auth.ts'], 2);

    expect(result.riskScore).toBe(0);
  });

  it('summary 문자열이 변경 파일 수와 영향 파일 수를 포함한다', () => {
    const nodeA = makeNode('fn:src/a.ts:fnA', 'src/a.ts');
    const nodeB = makeNode('fn:src/b.ts:fnB', 'src/b.ts');
    store.upsertNode(nodeA);
    store.upsertNode(nodeB);
    store.upsertEdge(makeEdge('fn:src/b.ts:fnB', 'fn:src/a.ts:fnA'));

    const result = computeBlastRadius(store, ['src/a.ts'], 2);

    expect(result.summary).toContain('Changed 1 file(s)');
    expect(result.summary).toMatch(/Risk: (LOW|MEDIUM|HIGH)/);
  });

  it('의존하는 노드가 없으면 impactedNodes가 비어있다', () => {
    store.upsertNode(makeNode('fn:src/a.ts:fnA', 'src/a.ts'));
    // 아무 엣지 없음

    const result = computeBlastRadius(store, ['src/a.ts'], 2);

    expect(result.impactedNodes).toHaveLength(0);
    expect(result.changedFiles).toContain('src/a.ts');
  });
});
