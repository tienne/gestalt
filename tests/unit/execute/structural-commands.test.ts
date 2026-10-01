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

  it('narrows tests with the given files, adding -- only for npm', () => {
    const pnpmRepo = createFakeRepo({ files: { 'package.json': SCRIPTS, 'pnpm-lock.yaml': '' } });
    const npmRepo = createFakeRepo({ files: { 'package.json': SCRIPTS } });
    const files = ['/r/a.test.ts', '/r/b.test.ts'];

    expect(buildStructuralCommands(pnpmRepo.root, files).at(-1)!.command).toBe(
      'pnpm run test /r/a.test.ts /r/b.test.ts',
    );
    expect(buildStructuralCommands(npmRepo.root, files).at(-1)!.command).toBe(
      'npm run test -- /r/a.test.ts /r/b.test.ts',
    );
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
