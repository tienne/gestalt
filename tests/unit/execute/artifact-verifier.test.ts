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

  it('git 레포가 아니면 기준 트리를 잡지 않는다', async () => {
    expect(await captureWorkingTreeBaseline(dir)).toBeNull();
  });

  it('없는 디렉토리면 기준 트리를 잡지 않는다', async () => {
    expect(await captureWorkingTreeBaseline(join(dir, 'nope'))).toBeNull();
  });

  it('시작 뒤로 수정한 tracked 파일은 changed다', async () => {
    initRepo(dir);
    const baseline = (await captureWorkingTreeBaseline(dir))!;
    writeFileSync(join(dir, 'tracked.ts'), 'export const a = 2;\n');

    const result = await verifyArtifacts(baseline, ['tracked.ts']);
    expect(result.verified).toBe(true);
    expect(result.files).toEqual([{ path: 'tracked.ts', status: 'changed' }]);
  });

  it('손대지 않은 파일은 unchanged라 통과하지 않는다', async () => {
    initRepo(dir);
    const baseline = (await captureWorkingTreeBaseline(dir))!;

    const result = await verifyArtifacts(baseline, ['tracked.ts']);
    expect(result.verified).toBe(false);
    expect(result.files[0]!.status).toBe('unchanged');
  });

  it('시작 전부터 dirty였던 파일은 그 시점 내용과 비교한다', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'dirty.ts'), 'export const b = 2;\n');
    const baseline = (await captureWorkingTreeBaseline(dir))!;

    // HEAD와는 다르지만 시작 시점 그대로다
    expect((await verifyArtifacts(baseline, ['dirty.ts'])).files[0]!.status).toBe('unchanged');

    writeFileSync(join(dir, 'dirty.ts'), 'export const b = 3;\n');
    expect((await verifyArtifacts(baseline, ['dirty.ts'])).files[0]!.status).toBe('changed');
  });

  it('새로 만든 untracked 파일은 changed다', async () => {
    initRepo(dir);
    const baseline = (await captureWorkingTreeBaseline(dir))!;
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'new.ts'), 'export {};\n');

    expect((await verifyArtifacts(baseline, ['src/new.ts'])).files[0]!.status).toBe('changed');
  });

  it('시작 전부터 있던 untracked 파일은 그대로면 unchanged다', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'scratch.ts'), 'x\n');
    const baseline = (await captureWorkingTreeBaseline(dir))!;

    expect((await verifyArtifacts(baseline, ['scratch.ts'])).files[0]!.status).toBe('unchanged');
  });

  it('커밋까지 마친 변경도 changed다', async () => {
    initRepo(dir);
    const baseline = (await captureWorkingTreeBaseline(dir))!;
    writeFileSync(join(dir, 'tracked.ts'), 'export const a = 3;\n');
    git(dir, 'commit', '-q', '-am', 'change');

    expect((await verifyArtifacts(baseline, ['tracked.ts'])).files[0]!.status).toBe('changed');
  });

  it('시작 때 있던 파일을 지웠으면 changed다', async () => {
    initRepo(dir);
    const baseline = (await captureWorkingTreeBaseline(dir))!;
    unlinkSync(join(dir, 'tracked.ts'));

    expect((await verifyArtifacts(baseline, ['tracked.ts'])).files[0]!.status).toBe('changed');
  });

  it('처음부터 없던 파일은 missing이다', async () => {
    initRepo(dir);
    const baseline = (await captureWorkingTreeBaseline(dir))!;

    expect((await verifyArtifacts(baseline, ['ghost.ts'])).files[0]!.status).toBe('missing');
  });

  it('레포 밖 경로와 gitignore 경로와 디렉토리는 확인 불가로 막는다', async () => {
    initRepo(dir);
    const baseline = (await captureWorkingTreeBaseline(dir))!;
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'out.js'), 'x\n');
    mkdirSync(join(dir, 'lib'));

    const result = await verifyArtifacts(baseline, ['../elsewhere.ts', 'dist/out.js', 'lib']);
    expect(result.verified).toBe(false);
    expect(result.files.map((f) => f.status)).toEqual(['outside_repo', 'ignored', 'directory']);
  });

  it('절대 경로와 하위 cwd 기준 상대 경로를 같은 파일로 푼다', async () => {
    initRepo(dir);
    mkdirSync(join(dir, 'pkg'));
    const baseline = (await captureWorkingTreeBaseline(join(dir, 'pkg')))!;
    writeFileSync(join(dir, 'pkg', 'mod.ts'), 'x\n');
    writeFileSync(join(dir, 'tracked.ts'), 'changed\n');

    const result = await verifyArtifacts(baseline, ['mod.ts', join(dir, 'tracked.ts')]);
    expect(result.files.map((f) => f.status)).toEqual(['changed', 'changed']);
  });

  it('하나라도 안 바뀌었으면 전체가 통과하지 않는다', async () => {
    initRepo(dir);
    const baseline = (await captureWorkingTreeBaseline(dir))!;
    writeFileSync(join(dir, 'tracked.ts'), 'changed\n');

    const result = await verifyArtifacts(baseline, ['tracked.ts', 'dirty.ts']);
    expect(result.verified).toBe(false);
    expect(result.files.map((f) => f.status)).toEqual(['changed', 'unchanged']);
  });

  it('커밋이 없는 레포에서도 새 파일을 changed로 본다', async () => {
    initRepo(dir, false);
    const baseline = (await captureWorkingTreeBaseline(dir))!;
    expect(baseline.head).toBeNull();
    writeFileSync(join(dir, 'first.ts'), 'x\n');

    expect((await verifyArtifacts(baseline, ['first.ts'])).files[0]!.status).toBe('changed');
  });

  it('개행이 든 artifact는 invalid_path로 막고 다른 항목의 판정을 밀지 않는다', async () => {
    initRepo(dir);
    const baseline = (await captureWorkingTreeBaseline(dir))!;
    writeFileSync(join(dir, 'tracked.ts'), 'changed\n');

    const result = await verifyArtifacts(baseline, ['ghost.ts\n', 'tracked.ts', 'dirty.ts']);
    expect(result.files.map((f) => f.status)).toEqual(['invalid_path', 'changed', 'unchanged']);
  });

  it('이름에 개행이 든 untracked 파일이 있어도 기준 트리를 잡는다', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'odd\nname.ts'), 'x\n');
    const baseline = (await captureWorkingTreeBaseline(dir))!;
    expect(baseline.dirty['odd\nname.ts']).toMatch(/^[0-9a-f]{40}$/);

    writeFileSync(join(dir, 'tracked.ts'), 'changed\n');
    expect((await verifyArtifacts(baseline, ['tracked.ts'])).files[0]!.status).toBe('changed');
  });

  it('비ASCII 이름의 gitignore 경로도 ignored로 본다', async () => {
    initRepo(dir);
    writeFileSync(join(dir, '.gitignore'), 'dist/\n산출물/\n');
    git(dir, 'commit', '-q', '-am', 'ignore');
    const baseline = (await captureWorkingTreeBaseline(dir))!;
    mkdirSync(join(dir, '산출물'));
    writeFileSync(join(dir, '산출물', '결과.js'), 'x\n');

    expect((await verifyArtifacts(baseline, ['산출물/결과.js'])).files[0]!.status).toBe('ignored');
  });

  it("'..'로 시작하는 레포 안 파일은 레포 밖으로 보지 않는다", async () => {
    initRepo(dir);
    const baseline = (await captureWorkingTreeBaseline(dir))!;
    writeFileSync(join(dir, '..foo.ts'), 'x\n');

    expect((await verifyArtifacts(baseline, ['..foo.ts'])).files[0]!.status).toBe('changed');
  });

  it('같은 artifact를 두 번 적어도 한 번만 대조한다', async () => {
    initRepo(dir);
    const baseline = (await captureWorkingTreeBaseline(dir))!;
    writeFileSync(join(dir, 'tracked.ts'), 'changed\n');

    const result = await verifyArtifacts(baseline, ['tracked.ts', 'tracked.ts']);
    expect(result.files).toEqual([{ path: 'tracked.ts', status: 'changed' }]);
  });

  it('시작 때 rename돼 있던 파일은 새 경로와 옛 경로 둘 다 시작 시점과 비교한다', async () => {
    initRepo(dir);
    git(dir, 'mv', 'tracked.ts', 'moved.ts');
    const baseline = (await captureWorkingTreeBaseline(dir))!;

    expect((await verifyArtifacts(baseline, ['moved.ts'])).files[0]!.status).toBe('unchanged');
    expect((await verifyArtifacts(baseline, ['tracked.ts'])).files[0]!.status).toBe('missing');

    writeFileSync(join(dir, 'moved.ts'), 'changed\n');
    expect((await verifyArtifacts(baseline, ['moved.ts'])).files[0]!.status).toBe('changed');
  });

  it('시작 때 지워져 있던 tracked 파일은 다시 만들어야 changed다', async () => {
    initRepo(dir);
    unlinkSync(join(dir, 'tracked.ts'));
    const baseline = (await captureWorkingTreeBaseline(dir))!;
    expect(baseline.dirty['tracked.ts']).toBeNull();

    expect((await verifyArtifacts(baseline, ['tracked.ts'])).files[0]!.status).toBe('missing');
    writeFileSync(join(dir, 'tracked.ts'), 'back\n');
    expect((await verifyArtifacts(baseline, ['tracked.ts'])).files[0]!.status).toBe('changed');
  });

  it('FIFO는 읽지 않고 없는 파일처럼 다룬다', async () => {
    initRepo(dir);
    const baseline = (await captureWorkingTreeBaseline(dir))!;
    execFileSync('mkfifo', [join(dir, 'pipe')]);

    expect((await verifyArtifacts(baseline, ['pipe'])).files[0]!.status).toBe('missing');
  });

  it('작업 트리가 git 레포가 아니게 되면 예외를 던진다', async () => {
    initRepo(dir);
    const baseline = (await captureWorkingTreeBaseline(dir))!;
    rmSync(join(dir, '.git'), { recursive: true, force: true });

    await expect(verifyArtifacts(baseline, ['tracked.ts'])).rejects.toThrow();
  });
});
