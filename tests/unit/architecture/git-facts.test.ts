import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  changedFilesSince,
  createGitMoveFinder,
  findRenames,
  readHead,
  viewFreshness,
} from '../../../src/architecture/git-facts.js';
import type { ArchitectureIr } from '../../../src/architecture/types.js';

let root: string;

function git(...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
}

function write(path: string, body: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), body);
}

function commit(message: string): string {
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

beforeEach(() => {
  root = resolve('.gestalt-test', `git-facts-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  git('init', '-q');
  write('src/a.ts', 'export const a = 1;\nexport const b = 2;\n');
  write('src/keep.ts', 'export const keep = true;\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readHead', () => {
  it('커밋이 없으면 undefined, 있으면 40자 해시', () => {
    expect(readHead(root)).toBeUndefined();
    const head = commit('init');
    expect(readHead(root)).toBe(head);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('git 레포가 아니면 undefined', () => {
    // .gestalt-test는 이 레포 안이라 바깥 HEAD가 잡힌다. 레포 밖 임시 폴더로 본다
    const plain = mkdtempSync(join(tmpdir(), 'git-facts-plain-'));
    try {
      expect(readHead(plain)).toBeUndefined();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('changedFilesSince', () => {
  it('기록된 head 이후 커밋된 파일과 커밋 안 된 파일을 따로 센다', () => {
    const head = commit('init');
    write('src/a.ts', 'export const a = 2;\n');
    commit('edit a');
    write('src/keep.ts', 'export const keep = false;\n');
    write('src/untracked.ts', 'x\n');
    const result = changedFilesSince(root, head);
    expect(result).toEqual({ ok: true, changed: ['src/a.ts'], uncommitted: ['src/keep.ts'] });
  });

  it('옮겨 간 파일은 옛 경로와 새 경로를 둘 다 바뀐 파일로 센다', () => {
    const head = commit('init');
    git('mv', 'src/a.ts', 'src/b.ts');
    commit('move');
    git('mv', 'src/keep.ts', 'src/kept.ts');
    const result = changedFilesSince(root, head);
    expect(result).toEqual({
      ok: true,
      changed: ['src/a.ts', 'src/b.ts'],
      uncommitted: ['src/keep.ts', 'src/kept.ts'],
    });
  });

  it('없는 커밋이면 head_not_found', () => {
    commit('init');
    expect(changedFilesSince(root, 'deadbeefdeadbeef')).toEqual({
      ok: false,
      reason: 'head_not_found',
    });
  });

  it('커밋이 없는 레포면 not_git', () => {
    expect(changedFilesSince(root, 'deadbeefdeadbeef')).toEqual({ ok: false, reason: 'not_git' });
  });
});

describe('findRenames', () => {
  it('커밋된 rename 사슬을 끝까지 따라간다', () => {
    const head = commit('init');
    git('mv', 'src/a.ts', 'src/b.ts');
    commit('a → b');
    mkdirSync(join(root, 'lib'), { recursive: true });
    git('mv', 'src/b.ts', 'lib/c.ts');
    commit('b → c');
    const renames = findRenames(root, head);
    expect(renames.get('src/a.ts')).toBe('lib/c.ts');
    expect(renames.get('src/b.ts')).toBe('lib/c.ts');
  });

  it('head가 없으면 최근 커밋에서 찾는다', () => {
    commit('init');
    git('mv', 'src/a.ts', 'src/moved.ts');
    commit('move');
    expect(findRenames(root).get('src/a.ts')).toBe('src/moved.ts');
  });

  it('스테이징된 rename도 넣는다', () => {
    commit('init');
    mkdirSync(join(root, 'pkg'), { recursive: true });
    git('mv', 'src/a.ts', 'pkg/a.ts');
    expect(findRenames(root).get('src/a.ts')).toBe('pkg/a.ts');
  });

  it('커밋이 없는 레포면 빈 결과', () => {
    expect(findRenames(root).size).toBe(0);
  });
});

describe('createGitMoveFinder', () => {
  it('옮겨진 파일의 지금 경로를 하나 돌려주고 모르는 파일은 빈 배열', () => {
    const head = commit('init');
    git('mv', 'src/a.ts', 'src/renamed.ts');
    commit('move');
    const find = createGitMoveFinder(new Map([['web', head]]));
    expect(find('web', root, 'src/a.ts')).toEqual(['src/renamed.ts']);
    expect(find('web', root, './src/a.ts')).toEqual(['src/renamed.ts']);
    expect(find('web', root, 'src/nope.ts')).toEqual([]);
  });
});

describe('viewFreshness', () => {
  function irWith(head?: string): ArchitectureIr {
    return {
      schemaVersion: '1.0.0',
      view: 'screen-chain',
      repos: [{ id: 'web', name: 'acme-web', root: '.', ...(head ? { head } : {}) }],
      nodes: [
        {
          id: 'a',
          kind: 'screen',
          label: 'A',
          repo: 'web',
          evidence: [{ type: 'code', location: 'web:src/a.ts:1', visibility: 'public' }],
        },
        {
          id: 'k',
          kind: 'app_module',
          label: 'Keep',
          repo: 'web',
          evidence: [{ type: 'code', location: 'web:./src/keep.ts:1', visibility: 'public' }],
        },
      ],
      edges: [],
      unresolved: [],
      sourcesUsed: [],
      generatedAt: '2026-01-01T00:00:00.000Z',
    } as ArchitectureIr;
  }

  it('head가 없는 예전 IR은 unknown과 이유', () => {
    commit('init');
    const result = viewFreshness(irWith(), () => root);
    expect(result.status).toBe('unknown');
    expect(result.repos[0]).toMatchObject({ repo: 'web', status: 'unknown', reason: 'no_head' });
    expect(result.staleEvidenceFiles).toEqual([]);
  });

  it('바뀐 게 없으면 fresh', () => {
    const head = commit('init');
    const result = viewFreshness(irWith(head), () => root);
    expect(result).toEqual({
      status: 'fresh',
      repos: [
        { repo: 'web', status: 'fresh', head, current: head, changedFiles: 0, uncommitted: 0 },
      ],
      staleEvidenceFiles: [],
    });
  });

  it('근거 파일 중 커밋됐거나 커밋 안 된 변경을 모은다', () => {
    const head = commit('init');
    write('src/a.ts', 'changed\n');
    write('src/other.ts', 'x\n');
    commit('edit');
    write('src/keep.ts', 'dirty\n');
    const result = viewFreshness(irWith(head), () => root);
    expect(result.status).toBe('stale');
    expect(result.repos[0]).toMatchObject({ status: 'stale', changedFiles: 2, uncommitted: 1 });
    expect(result.staleEvidenceFiles).toEqual(['web:src/a.ts', 'web:src/keep.ts']);
  });

  it('기록된 커밋이 없으면 head_not_found', () => {
    commit('init');
    const result = viewFreshness(irWith('deadbeefdeadbeef'), () => root);
    expect(result.repos[0]).toMatchObject({ status: 'unknown', reason: 'head_not_found' });
  });
});
