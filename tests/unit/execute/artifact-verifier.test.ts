import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  captureWorkingTreeBaseline,
  verifyArtifacts,
} from '../../../src/execute/artifact-verifier.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function initRepo(dir: string, withCommit = true): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  if (!withCommit) return;
  writeFileSync(join(dir, 'tracked.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'dirty.ts'), 'export const b = 1;\n');
  writeFileSync(join(dir, '.gitignore'), 'dist/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

// git을 여러 번 띄우므로 부하가 걸린 머신에서는 기본 5초를 넘긴다
describe('artifact-verifier', { timeout: 30_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gestalt-artifact-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('git 레포가 아니면 기준 트리를 잡지 않는다', () => {
    expect(captureWorkingTreeBaseline(dir)).toBeNull();
  });

  it('없는 디렉토리면 기준 트리를 잡지 않는다', () => {
    expect(captureWorkingTreeBaseline(join(dir, 'nope'))).toBeNull();
  });

  it('시작 뒤로 수정한 tracked 파일은 changed다', () => {
    initRepo(dir);
    const baseline = captureWorkingTreeBaseline(dir)!;
    writeFileSync(join(dir, 'tracked.ts'), 'export const a = 2;\n');

    const result = verifyArtifacts(baseline, ['tracked.ts']);
    expect(result.verified).toBe(true);
    expect(result.files).toEqual([{ path: 'tracked.ts', status: 'changed' }]);
  });

  it('손대지 않은 파일은 unchanged라 통과하지 않는다', () => {
    initRepo(dir);
    const baseline = captureWorkingTreeBaseline(dir)!;

    const result = verifyArtifacts(baseline, ['tracked.ts']);
    expect(result.verified).toBe(false);
    expect(result.files[0]!.status).toBe('unchanged');
  });

  it('시작 전부터 dirty였던 파일은 그 시점 내용과 비교한다', () => {
    initRepo(dir);
    writeFileSync(join(dir, 'dirty.ts'), 'export const b = 2;\n');
    const baseline = captureWorkingTreeBaseline(dir)!;

    // HEAD와는 다르지만 시작 시점 그대로다
    expect(verifyArtifacts(baseline, ['dirty.ts']).files[0]!.status).toBe('unchanged');

    writeFileSync(join(dir, 'dirty.ts'), 'export const b = 3;\n');
    expect(verifyArtifacts(baseline, ['dirty.ts']).files[0]!.status).toBe('changed');
  });

  it('새로 만든 untracked 파일은 changed다', () => {
    initRepo(dir);
    const baseline = captureWorkingTreeBaseline(dir)!;
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'new.ts'), 'export {};\n');

    expect(verifyArtifacts(baseline, ['src/new.ts']).files[0]!.status).toBe('changed');
  });

  it('시작 전부터 있던 untracked 파일은 그대로면 unchanged다', () => {
    initRepo(dir);
    writeFileSync(join(dir, 'scratch.ts'), 'x\n');
    const baseline = captureWorkingTreeBaseline(dir)!;

    expect(verifyArtifacts(baseline, ['scratch.ts']).files[0]!.status).toBe('unchanged');
  });

  it('커밋까지 마친 변경도 changed다', () => {
    initRepo(dir);
    const baseline = captureWorkingTreeBaseline(dir)!;
    writeFileSync(join(dir, 'tracked.ts'), 'export const a = 3;\n');
    git(dir, 'commit', '-q', '-am', 'change');

    expect(verifyArtifacts(baseline, ['tracked.ts']).files[0]!.status).toBe('changed');
  });

  it('시작 때 있던 파일을 지웠으면 changed다', () => {
    initRepo(dir);
    const baseline = captureWorkingTreeBaseline(dir)!;
    unlinkSync(join(dir, 'tracked.ts'));

    expect(verifyArtifacts(baseline, ['tracked.ts']).files[0]!.status).toBe('changed');
  });

  it('처음부터 없던 파일은 missing이다', () => {
    initRepo(dir);
    const baseline = captureWorkingTreeBaseline(dir)!;

    expect(verifyArtifacts(baseline, ['ghost.ts']).files[0]!.status).toBe('missing');
  });

  it('레포 밖 경로와 gitignore 경로와 디렉토리는 확인 불가로 막는다', () => {
    initRepo(dir);
    const baseline = captureWorkingTreeBaseline(dir)!;
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'out.js'), 'x\n');
    mkdirSync(join(dir, 'lib'));

    const result = verifyArtifacts(baseline, ['../elsewhere.ts', 'dist/out.js', 'lib']);
    expect(result.verified).toBe(false);
    expect(result.files.map((f) => f.status)).toEqual(['outside_repo', 'ignored', 'directory']);
  });

  it('절대 경로와 하위 cwd 기준 상대 경로를 같은 파일로 푼다', () => {
    initRepo(dir);
    mkdirSync(join(dir, 'pkg'));
    const baseline = captureWorkingTreeBaseline(join(dir, 'pkg'))!;
    writeFileSync(join(dir, 'pkg', 'mod.ts'), 'x\n');
    writeFileSync(join(dir, 'tracked.ts'), 'changed\n');

    const result = verifyArtifacts(baseline, ['mod.ts', join(dir, 'tracked.ts')]);
    expect(result.files.map((f) => f.status)).toEqual(['changed', 'changed']);
  });

  it('하나라도 안 바뀌었으면 전체가 통과하지 않는다', () => {
    initRepo(dir);
    const baseline = captureWorkingTreeBaseline(dir)!;
    writeFileSync(join(dir, 'tracked.ts'), 'changed\n');

    const result = verifyArtifacts(baseline, ['tracked.ts', 'dirty.ts']);
    expect(result.verified).toBe(false);
    expect(result.files.map((f) => f.status)).toEqual(['changed', 'unchanged']);
  });

  it('커밋이 없는 레포에서도 새 파일을 changed로 본다', () => {
    initRepo(dir, false);
    const baseline = captureWorkingTreeBaseline(dir)!;
    expect(baseline.head).toBeNull();
    writeFileSync(join(dir, 'first.ts'), 'x\n');

    expect(verifyArtifacts(baseline, ['first.ts']).files[0]!.status).toBe('changed');
  });
});
