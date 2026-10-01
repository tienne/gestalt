import { describe, it, expect, afterEach } from 'vitest';
import { resolve } from 'node:path';
import {
  buildStructuralCommands,
  collectChangedFiles,
  detectPackageManager,
  findCommandMismatches,
} from '../../../src/execute/structural-commands.js';
import { createFakeRepo, cleanupFakeRepos } from '../../helpers/fake-repo.js';

const SCRIPTS = JSON.stringify({ scripts: { lint: 'x', build: 'x', test: 'x' } });

afterEach(() => cleanupFakeRepos());

describe('detectPackageManager', () => {
  it('follows the lockfile', () => {
    expect(detectPackageManager(createFakeRepo({ files: { 'pnpm-lock.yaml': '' } }).root)).toBe(
      'pnpm',
    );
    expect(detectPackageManager(createFakeRepo({ files: { 'yarn.lock': '' } }).root)).toBe('yarn');
    expect(detectPackageManager(createFakeRepo({ files: { 'bun.lockb': '' } }).root)).toBe('bun');
    expect(
      detectPackageManager(createFakeRepo({ files: { 'package-lock.json': '{}' } }).root),
    ).toBe('npm');
  });

  it('prefers pnpm when package-lock.json is committed alongside pnpm-lock.yaml', () => {
    const repo = createFakeRepo({ files: { 'pnpm-lock.yaml': '', 'package-lock.json': '{}' } });
    expect(detectPackageManager(repo.root)).toBe('pnpm');
  });

  it('lets the packageManager field override the lockfile', () => {
    const repo = createFakeRepo({
      files: {
        'package.json': JSON.stringify({ packageManager: 'yarn@4.1.0' }),
        'pnpm-lock.yaml': '',
      },
    });
    expect(detectPackageManager(repo.root)).toBe('yarn');
  });

  it('ignores an unsupported packageManager value and uses the lockfile', () => {
    const repo = createFakeRepo({
      files: { 'package.json': JSON.stringify({ packageManager: 'deno@2' }), 'yarn.lock': '' },
    });
    expect(detectPackageManager(repo.root)).toBe('yarn');
  });

  it('falls back to npm without any hint', () => {
    expect(detectPackageManager(createFakeRepo().root)).toBe('npm');
  });
});

describe('buildStructuralCommands', () => {
  it('uses the detected package manager', () => {
    const repo = createFakeRepo({ files: { 'package.json': SCRIPTS, 'pnpm-lock.yaml': '' } });
    expect(buildStructuralCommands(repo.root)).toEqual([
      { name: 'lint', command: 'pnpm run lint' },
      { name: 'build', command: 'pnpm run build' },
      { name: 'test', command: 'pnpm run test' },
    ]);
  });

  it('narrows tests with root-relative paths, adding -- only for npm', () => {
    const pnpmRepo = createFakeRepo({ files: { 'package.json': SCRIPTS, 'pnpm-lock.yaml': '' } });
    const npmRepo = createFakeRepo({ files: { 'package.json': SCRIPTS } });
    const files = (root: string) => [resolve(root, 'a.test.ts'), resolve(root, 'tests/b.test.ts')];

    expect(buildStructuralCommands(pnpmRepo.root, files(pnpmRepo.root)).at(-1)!.command).toBe(
      'pnpm run test a.test.ts tests/b.test.ts',
    );
    expect(buildStructuralCommands(npmRepo.root, files(npmRepo.root)).at(-1)!.command).toBe(
      'npm run test -- a.test.ts tests/b.test.ts',
    );
  });

  it.each([
    ['a shell metacharacter', 'tests/a;rm -rf.test.ts'],
    ['a command substitution', 'tests/$(id).test.ts'],
    ['a space', 'tests/my file.test.ts'],
    ['a path outside the root', '../other/a.test.ts'],
  ])('falls back to the full suite for %s', (_label, file) => {
    const repo = createFakeRepo({ files: { 'package.json': SCRIPTS, 'pnpm-lock.yaml': '' } });
    const files = [resolve(repo.root, 'tests/ok.test.ts'), resolve(repo.root, file)];
    expect(buildStructuralCommands(repo.root, files).at(-1)!.command).toBe('pnpm run test');
  });

  it('falls back to the full suite when too many tests are affected', () => {
    const repo = createFakeRepo({ files: { 'package.json': SCRIPTS, 'pnpm-lock.yaml': '' } });
    const files = Array.from({ length: 51 }, (_, i) => resolve(repo.root, `t${i}.test.ts`));
    expect(buildStructuralCommands(repo.root, files).at(-1)!.command).toBe('pnpm run test');
  });

  it('runs the full suite when no test files are given', () => {
    const repo = createFakeRepo({ files: { 'package.json': SCRIPTS, 'pnpm-lock.yaml': '' } });
    expect(buildStructuralCommands(repo.root, []).at(-1)!.command).toBe('pnpm run test');
  });

  it('drops missing lint/build scripts but always keeps test', () => {
    const repo = createFakeRepo({ files: { 'package.json': JSON.stringify({ scripts: {} }) } });
    expect(buildStructuralCommands(repo.root).map((c) => c.name)).toEqual(['test']);
  });
});

describe('collectChangedFiles', () => {
  it('includes staged, unstaged and untracked files on top of the last commit', () => {
    const repo = createFakeRepo({ files: { 'a.ts': '1', 'b.ts': '1', 'c.ts': '1' } });
    repo.commit('second', { 'committed.ts': '1' });
    repo.write('a.ts', '2');
    repo.write('b.ts', '2');
    repo.git('add', 'b.ts');
    repo.write('new.test.ts', 'x');

    const files = collectChangedFiles(repo.root);
    expect(files.sort()).toEqual(
      ['a.ts', 'b.ts', 'committed.ts', 'new.test.ts'].map((f) => resolve(repo.root, f)).sort(),
    );
  });

  it('still sees the working tree in a single-commit repo', () => {
    const repo = createFakeRepo({ files: { 'a.ts': '1' } });
    repo.write('a.ts', '2');
    expect(collectChangedFiles(repo.root)).toEqual([resolve(repo.root, 'a.ts')]);
  });

  it('keeps non-ASCII paths unescaped even with core.quotePath on', () => {
    const repo = createFakeRepo({ files: { '한글.ts': '1' } });
    repo.git('config', 'core.quotePath', 'true');
    repo.write('한글.ts', '2');
    repo.write('새파일.test.ts', 'x');
    expect(collectChangedFiles(repo.root).sort()).toEqual(
      ['새파일.test.ts', '한글.ts'].map((f) => resolve(repo.root, f)).sort(),
    );
  });

  it('resolves paths against a repoRoot that is a subdirectory of the repo', () => {
    const repo = createFakeRepo({ files: { 'pkg/a.ts': '1', 'other/b.ts': '1' } });
    repo.write('pkg/a.ts', '2');
    repo.write('other/b.ts', '2');
    repo.write('pkg/new.test.ts', 'x');
    const pkgRoot = resolve(repo.root, 'pkg');
    expect(collectChangedFiles(pkgRoot).sort()).toEqual(
      ['a.ts', 'new.test.ts'].map((f) => resolve(pkgRoot, f)).sort(),
    );
  });

  it('keeps deleted files so blast-radius can find their importers', () => {
    const repo = createFakeRepo({ files: { 'a.ts': '1', 'b.ts': '1' } });
    repo.remove('a.ts');
    expect(collectChangedFiles(repo.root)).toEqual([resolve(repo.root, 'a.ts')]);
  });

  it('throws when git fails so the caller can fall back to the full suite', () => {
    expect(() => collectChangedFiles(resolve('.gestalt-test', 'not-a-repo-xyz'))).toThrow();
  });
});

describe('findCommandMismatches', () => {
  const requested = [
    { name: 'lint', command: 'pnpm run lint' },
    { name: 'test', command: 'pnpm run test' },
  ];

  it('accepts exactly the requested commands', () => {
    const submitted = {
      commands: requested.map((c) => ({ ...c, exitCode: 0, output: '' })),
      allPassed: true,
    };
    expect(findCommandMismatches(requested, submitted)).toEqual([]);
  });

  it('reports a swapped command and a missing one', () => {
    const submitted = {
      commands: [{ name: 'lint', command: 'echo ok', exitCode: 0, output: '' }],
      allPassed: true,
    };
    const mismatches = findCommandMismatches(requested, submitted);
    expect(mismatches).toHaveLength(2);
    expect(mismatches[0]).toContain('lint');
    expect(mismatches[1]).toContain('test: missing');
  });
});
