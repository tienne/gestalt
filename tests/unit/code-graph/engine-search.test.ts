import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CodeGraphEngine } from '../../../src/code-graph/engine.js';
import { CodeGraphStore } from '../../../src/code-graph/storage.js';
import { NodeKind } from '../../../src/code-graph/types.js';
import type { CodeGraphNode } from '../../../src/code-graph/types.js';

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

describe('CodeGraphEngine search', () => {
  let repoRoot: string;
  let dbPath: string;
  let engine: CodeGraphEngine;
  let store: CodeGraphStore;

  beforeEach(() => {
    // 엔진 DB 경로가 <repoRoot>/.gestalt/code-graph.db로 고정되므로 repoRoot 격리.
    repoRoot = join('.gestalt-test', randomUUID());
    dbPath = join(repoRoot, '.gestalt', 'code-graph.db');
    mkdirSync(join(repoRoot, '.gestalt'), { recursive: true });

    engine = new CodeGraphEngine();
    // 엔진과 동일 DB 경로로 store를 열어 노드를 삽입 (engine.getStore와 같은 파일).
    store = new CodeGraphStore(dbPath);
  });

  afterEach(() => {
    store.close();
    engine.close();
    if (existsSync(repoRoot)) rmSync(repoRoot, { recursive: true, force: true });
  });

  describe('listAllFiles()', () => {
    it('중복 filePath 노드를 유니크화하고 사전순으로 정렬한다', () => {
      // 동일 filePath를 가진 복수 노드 + 여러 파일을 비정렬 순서로 삽입
      store.upsertNode(
        makeNode({ id: 'function:src/zeta.ts:fn1', filePath: 'src/zeta.ts', name: 'fn1' }),
      );
      store.upsertNode(
        makeNode({ id: 'function:src/auth.ts:login', filePath: 'src/auth.ts', name: 'login' }),
      );
      store.upsertNode(
        makeNode({ id: 'function:src/auth.ts:logout', filePath: 'src/auth.ts', name: 'logout' }),
      );
      store.upsertNode(
        makeNode({ id: 'function:src/middle.ts:mid', filePath: 'src/middle.ts', name: 'mid' }),
      );

      const result = engine.listAllFiles(repoRoot);

      // 유니크: src/auth.ts가 2개 노드를 가져도 1개만
      expect(result).toEqual(['src/auth.ts', 'src/middle.ts', 'src/zeta.ts']);
      // 사전순 정렬 검증 (명시적)
      expect(result[0]!).toBe('src/auth.ts');
      expect(result[1]!).toBe('src/middle.ts');
      expect(result[2]!).toBe('src/zeta.ts');
    });

    it('빈 그래프에서 []를 반환한다', () => {
      const result = engine.listAllFiles(repoRoot);
      expect(result).toEqual([]);
    });
  });

  describe('searchByKeywords() 빈 키워드 방어', () => {
    beforeEach(() => {
      // 매칭 대상 노드 삽입
      store.upsertNode(
        makeNode({ id: 'function:src/auth.ts:login', filePath: 'src/auth.ts', name: 'login' }),
      );
      store.upsertNode(
        makeNode({ id: 'function:src/user.ts:getUser', filePath: 'src/user.ts', name: 'getUser' }),
      );
    });

    it('[] → []', () => {
      expect(engine.searchByKeywords(repoRoot, [])).toEqual([]);
    });

    it("[''] → [] (빈 문자열이 전체 매칭 우회로가 되지 않는다)", () => {
      expect(engine.searchByKeywords(repoRoot, [''])).toEqual([]);
    });

    it("['   '] → [] (공백 키워드는 trim 후 제거된다)", () => {
      expect(engine.searchByKeywords(repoRoot, ['   '])).toEqual([]);
    });

    it("['', 'auth'] → 'auth' 매칭만 발생 (빈 키워드로 전체 매칭되지 않는다)", () => {
      const result = engine.searchByKeywords(repoRoot, ['', 'auth']);
      // 'auth'는 src/auth.ts에만 매칭. 빈 키워드가 살아있다면 src/user.ts도 포함되었을 것.
      expect(result).toEqual(['src/auth.ts']);
      expect(result).not.toContain('src/user.ts');
    });
  });
});
