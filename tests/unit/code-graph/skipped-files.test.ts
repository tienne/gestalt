/**
 * 그래프에 못 들어간 파일이 결과에 드러나는지 검증한다.
 *
 * 조용히 건너뛰면 nodesBuilt만 보고 전부 처리됐다고 읽는다. 빠진 파일은
 * 그래프에 없으므로 이후 blast-radius가 영향 범위에서 영영 누락하는데,
 * 이 누락은 깊이 상한과 달리 파라미터를 올려도 되살아나지 않는다.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CodeGraphEngine } from '../../../src/code-graph/engine.js';

describe('CodeGraphEngine.build() — 건너뛴 파일 보고', () => {
  let engine: CodeGraphEngine;
  let repoRoot: string;

  beforeEach(() => {
    engine = new CodeGraphEngine();
    repoRoot = resolve(process.cwd(), '.gestalt-test', `skipped-${randomUUID()}`);
    mkdirSync(repoRoot, { recursive: true });
  });

  afterEach(() => {
    engine.close();
    if (existsSync(repoRoot)) rmSync(repoRoot, { recursive: true, force: true });
  });

  it('전부 정상이면 skippedFiles가 비어 있다', () => {
    writeFileSync(join(repoRoot, 'ok.ts'), 'export function fn() {\n  return 1;\n}\n');

    const result = engine.build(repoRoot, { mode: 'full' });

    expect(result.skippedFiles).toEqual([]);
    expect(result.nodesBuilt).toBeGreaterThan(0);
  });

  it('읽지 못한 파일을 사유와 함께 보고한다', () => {
    writeFileSync(join(repoRoot, 'ok.ts'), 'export function fn() {\n  return 1;\n}\n');

    const unreadable = join(repoRoot, 'locked.ts');
    writeFileSync(unreadable, 'export function locked() {}\n');
    chmodSync(unreadable, 0o000);

    const result = engine.build(repoRoot, { mode: 'full' });

    // root로 돌리면 권한이 무시돼 읽혀버린다. 그 환경에선 이 검증을 건너뛴다.
    if (result.skippedFiles.length === 0) {
      chmodSync(unreadable, 0o644);
      return;
    }

    expect(result.skippedFiles).toHaveLength(1);
    expect(result.skippedFiles[0]!.filePath).toContain('locked.ts');
    expect(result.skippedFiles[0]!.reason).toBeTruthy();

    // 건너뛴 파일이 있어도 나머지는 정상 처리된다
    expect(result.nodesBuilt).toBeGreaterThan(0);

    chmodSync(unreadable, 0o644);
  });
});
