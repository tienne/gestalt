import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectGlobalContext } from '../../../src/architecture/global-context.js';
import { encodeClaudeProjectDir, type ExecGit } from '../../../src/utils/claude-projects.js';

let tmpRoot: string;
let repoRoot: string;
let homeDir: string;
let projectsRoot: string;

// git을 실제로 부르면 테스트 디렉토리가 이 레포 안이라 이 레포의 remote가 잡힌다
const noGit: ExecGit = () => {
  throw new Error('no git');
};

beforeEach(() => {
  tmpRoot = resolve('.gestalt-test', `architecture-global-context-${randomUUID()}`);
  repoRoot = join(tmpRoot, 'acme-web');
  homeDir = join(tmpRoot, 'home');
  projectsRoot = join(homeDir, '.claude', 'projects');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(projectsRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function collect() {
  return collectGlobalContext({ repoRoot, homeDir, projectsRoot, execGit: noGit });
}

describe('collectGlobalContext', () => {
  it('파일이 하나도 없으면 고정 후보만 exists false로 돌려준다', () => {
    expect(collect()).toEqual([
      {
        via: 'repo',
        identifier: join(repoRoot, '.gestalt', 'memory.json'),
        exists: false,
        visibility: 'public',
      },
      { via: 'repo', identifier: join(repoRoot, 'AGENTS.md'), exists: false, visibility: 'public' },
      { via: 'repo', identifier: join(repoRoot, 'CLAUDE.md'), exists: false, visibility: 'public' },
      {
        via: 'global',
        identifier: join(homeDir, '.claude', 'CLAUDE.md'),
        exists: false,
        visibility: 'private',
      },
    ]);
  });

  it('레포 문서는 public, 홈 아래 파일은 private으로 모으고 정렬한다', () => {
    writeFileSync(join(repoRoot, 'CLAUDE.md'), 'x');
    mkdirSync(join(repoRoot, 'docs', 'nested'), { recursive: true });
    writeFileSync(join(repoRoot, 'docs', 'b.md'), 'x');
    writeFileSync(join(repoRoot, 'docs', 'nested', 'a.md'), 'x');
    writeFileSync(join(repoRoot, 'docs', 'diagram.png'), 'x');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(join(homeDir, '.claude', 'CLAUDE.md'), 'x');
    const memoryDir = join(projectsRoot, encodeClaudeProjectDir(repoRoot), 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'MEMORY.md'), 'x');
    writeFileSync(join(memoryDir, 'notes.txt'), 'x');

    const result = collect();
    const ids = result.map((c) => c.identifier);
    expect(ids).toEqual([
      join(repoRoot, '.gestalt', 'memory.json'),
      join(repoRoot, 'AGENTS.md'),
      join(repoRoot, 'CLAUDE.md'),
      join(repoRoot, 'docs', 'b.md'),
      join(repoRoot, 'docs', 'nested', 'a.md'),
      join(homeDir, '.claude', 'CLAUDE.md'),
      join(memoryDir, 'MEMORY.md'),
    ]);
    for (const c of result) {
      expect(c.visibility).toBe(c.via === 'repo' ? 'public' : 'private');
    }
    expect(result.find((c) => c.identifier.endsWith('MEMORY.md'))).toMatchObject({
      via: 'global',
      exists: true,
    });
  });
});
