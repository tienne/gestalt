/**
 * 회귀 테스트 — Code Graph 증분 빌드 시 역방향 엣지 유실 버그
 *
 * 시나리오: A가 F를 import하는 상태에서 F의 내용만 변경한 뒤 incremental 빌드를 하면,
 * 기존 로직은 F 재파싱 직전 deleteByFile(F)로 "A→F" 엣지까지 지우면서
 * A는 변경되지 않아 재파싱 대상에서 빠져 그 엣지가 복원되지 않았다.
 *
 * 수정 후에는 engine.build()가 변경 파일(F)을 참조하는 파일(A)도
 * store.getReferencingFiles(F)로 조회해 함께 재파싱 대상에 포함시킨다.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CodeGraphEngine } from '../../../src/code-graph/engine.js';
import { CodeGraphStore } from '../../../src/code-graph/storage.js';
import { EdgeKind } from '../../../src/code-graph/types.js';

/**
 * 실제 파일시스템에 A(importer)/F(imported) 2개 TS 파일을 갖는 격리된 repoRoot를 만든다.
 * repoRoot는 반드시 절대 경로여야 한다 — engine.query()가 상대 target을
 * resolve(repoRoot, target)으로 절대화하는데, repoRoot 자체가 상대 경로면
 * getFilesRecursively가 만든 노드의 file_path(상대 경로)와 어긋난다.
 */
function setupRepo(): { repoRoot: string; aPath: string; fPath: string; cleanup: () => void } {
  const repoRoot = resolve(process.cwd(), '.gestalt-test', `incremental-build-${randomUUID()}`);
  mkdirSync(repoRoot, { recursive: true });

  const fPath = join(repoRoot, 'f.ts');
  const aPath = join(repoRoot, 'a.ts');

  writeFileSync(fPath, 'export function helper() {\n  return 1;\n}\n');
  writeFileSync(
    aPath,
    "import { helper } from './f.js';\n\nexport function useHelper() {\n  return helper();\n}\n",
  );

  return {
    repoRoot,
    aPath,
    fPath,
    cleanup: () => {
      if (existsSync(repoRoot)) rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

describe('Code Graph 증분 빌드 — 역방향 엣지 유실 회귀 테스트', () => {
  let engine: CodeGraphEngine;
  let repo: ReturnType<typeof setupRepo>;

  beforeEach(() => {
    engine = new CodeGraphEngine();
    repo = setupRepo();
  });

  afterEach(() => {
    engine.close();
    repo.cleanup();
  });

  it('full 빌드 직후 A→F IMPORTS_FROM 엣지가 존재한다', () => {
    const result = engine.build(repo.repoRoot, { mode: 'full' });
    expect(result.nodesBuilt).toBeGreaterThan(0);
    expect(result.edgesBuilt).toBeGreaterThan(0);

    const imports = engine.query(repo.repoRoot, 'imports_of', repo.fPath);
    const importerIds = imports.nodes.map((n) => n.filePath);
    expect(importerIds).toContain(repo.aPath);
  });

  it('F만 변경 후 incremental 빌드를 해도 A→F 엣지가 살아남는다 (회귀 재현)', () => {
    engine.build(repo.repoRoot, { mode: 'full' });

    // F의 내용만 변경 (A는 건드리지 않는다)
    writeFileSync(repo.fPath, 'export function helper() {\n  return 2;\n}\n');

    engine.build(repo.repoRoot, { mode: 'incremental' });

    // 수정 전이었다면 deleteByFile(F)가 A→F 엣지까지 지우고 A는 재파싱되지 않아
    // 여기서 importerIds가 비어있었을 것이다.
    const imports = engine.query(repo.repoRoot, 'imports_of', repo.fPath);
    const importerIds = imports.nodes.map((n) => n.filePath);
    expect(importerIds).toContain(repo.aPath);
    expect(
      imports.edges.some(
        (e) => e.kind === EdgeKind.IMPORTS_FROM && e.targetId === `file:${repo.fPath}`,
      ),
    ).toBe(true);
  });

  it('여러 번의 incremental 빌드를 거듭해도 A→F 엣지가 누적 유실되지 않는다', () => {
    engine.build(repo.repoRoot, { mode: 'full' });

    for (let i = 0; i < 3; i++) {
      writeFileSync(repo.fPath, `export function helper() {\n  return ${i + 2};\n}\n`);
      engine.build(repo.repoRoot, { mode: 'incremental' });

      const imports = engine.query(repo.repoRoot, 'imports_of', repo.fPath);
      const importerIds = imports.nodes.map((n) => n.filePath);
      expect(importerIds, `iteration ${i}에서 A→F 엣지가 사라짐`).toContain(repo.aPath);
    }
  });

  it('getReferencingFiles가 F를 참조하는 A를 실제로 반환한다', () => {
    engine.build(repo.repoRoot, { mode: 'full' });

    const dbPath = join(repo.repoRoot, '.gestalt', 'code-graph.db');
    engine.close(); // 동일 파일에 대한 별도 연결로 조회하기 전에 엔진 커넥션을 정리

    const store = new CodeGraphStore(dbPath);
    try {
      const referencing = store.getReferencingFiles(repo.fPath);
      expect(referencing).toContain(repo.aPath);
      expect(referencing).not.toContain(repo.fPath); // 자기 자신 제외
    } finally {
      store.close();
    }
  });

  it('그래프가 비어있으면 getReferencingFiles는 빈 배열을 반환한다', () => {
    const dbPath = join(repo.repoRoot, '.gestalt', 'code-graph.db');
    mkdirSync(join(repo.repoRoot, '.gestalt'), { recursive: true });

    const store = new CodeGraphStore(dbPath);
    try {
      expect(store.getReferencingFiles(repo.fPath)).toEqual([]);
    } finally {
      store.close();
    }
  });
});
