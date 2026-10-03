import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ExecGit = (cwd: string, args: string[]) => string;

export interface FindClaudeProjectMemoryDirsOptions {
  repoRoot: string;
  /** 기본값은 ~/.claude/projects. 테스트에서 주입한다. */
  projectsRoot?: string;
  /** 워크트리 밖에서 같은 레포를 열었던 경로. */
  extraRoots?: string[];
  execGit?: ExecGit;
}

export interface ClaudeProjectMemoryMatch {
  remoteKey: string | null;
  matchedPaths: string[];
  memoryDirs: string[];
}

const defaultExecGit: ExecGit = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 16 * 1024 * 1024,
  });

export function encodeClaudeProjectDir(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9-]/g, '-');
}

export function normalizeRemoteUrl(url: string): string {
  let rest = url.trim();
  rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  rest = rest.replace(/^[^@/]*@/, '');
  // scp 꼴(host:org/repo)은 첫 콜론이 구분자이고 URL 꼴의 host:port는 포트를 버린다.
  rest = rest.replace(/^([^/:]+):(\d+)\//, '$1/').replace(/^([^/:]+):/, '$1/');
  rest = rest
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const slash = rest.indexOf('/');
  if (slash < 0) return rest.toLowerCase();
  return rest.slice(0, slash).toLowerCase() + rest.slice(slash);
}

export function listWorktreePaths(repoRoot: string, execGit: ExecGit = defaultExecGit): string[] {
  try {
    const out = execGit(repoRoot, ['worktree', 'list', '--porcelain']);
    return out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function remoteKeyOf(dir: string, execGit: ExecGit): string | null {
  try {
    const url = execGit(dir, ['remote', 'get-url', 'origin']).trim();
    return url ? normalizeRemoteUrl(url) : null;
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 인코딩은 손실이 있어(`/`, `.`, `-`가 모두 `-`) 디렉토리 이름만으론 원래 경로를 못 얻는다.
 * 조각 사이 구분자를 실제 파일시스템에 대어 보며 존재하는 경로로 복원한다.
 */
function restorePath(encoded: string): string | null {
  if (!encoded.startsWith('-')) return null;
  const pieces = encoded.slice(1).split('-');
  const listCache = new Map<string, string[]>();
  const list = (dir: string): string[] => {
    let v = listCache.get(dir);
    if (!v) {
      try {
        v = readdirSync(dir);
      } catch {
        v = [];
      }
      listCache.set(dir, v);
    }
    return v;
  };
  const join2 = (dir: string, seg: string) => (dir === '/' ? `/${seg}` : `${dir}/${seg}`);

  const walk = (i: number, dir: string, seg: string): string | null => {
    // 지금까지의 조각이 dir 아래 어떤 항목의 접두어도 아니면 더 이어 봐야 헛걸음이다.
    if (!list(dir).some((n) => n.startsWith(seg))) return null;
    if (i === pieces.length) {
      const full = join2(dir, seg);
      return seg && existsSync(full) ? full : null;
    }
    const next = pieces[i]!;
    if (seg && isDir(join2(dir, seg))) {
      const r = walk(i + 1, join2(dir, seg), next);
      if (r) return r;
    }
    for (const sep of ['-', '.']) {
      const r = walk(i + 1, dir, seg + sep + next);
      if (r) return r;
    }
    return null;
  };

  return walk(1, '/', pieces[0]!);
}

export function findClaudeProjectMemoryDirs(
  opts: FindClaudeProjectMemoryDirsOptions,
): ClaudeProjectMemoryMatch {
  const execGit = opts.execGit ?? defaultExecGit;
  const projectsRoot = opts.projectsRoot ?? join(homedir(), '.claude', 'projects');
  const remoteKey = remoteKeyOf(opts.repoRoot, execGit);

  const memoryDirs = new Set<string>();
  const matchedPaths = new Set<string>();
  const seenEncoded = new Set<string>();

  const tryPath = (absPath: string) => {
    const encoded = encodeClaudeProjectDir(absPath);
    seenEncoded.add(encoded);
    const mem = join(projectsRoot, encoded, 'memory');
    if (isDir(mem)) {
      memoryDirs.add(mem);
      matchedPaths.add(absPath);
    }
  };

  const firstPass = new Set([
    opts.repoRoot,
    ...listWorktreePaths(opts.repoRoot, execGit),
    ...(opts.extraRoots ?? []),
  ]);
  for (const p of firstPass) tryPath(p);

  if (remoteKey && isDir(projectsRoot)) {
    let entries: string[];
    try {
      entries = readdirSync(projectsRoot);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (seenEncoded.has(entry)) continue;
      const mem = join(projectsRoot, entry, 'memory');
      if (!isDir(mem)) continue;
      const restored = restorePath(entry);
      if (!restored || !isDir(restored)) continue;
      if (remoteKeyOf(restored, execGit) === remoteKey) {
        memoryDirs.add(mem);
        matchedPaths.add(restored);
      }
    }
  }

  return {
    remoteKey,
    matchedPaths: [...matchedPaths].sort(),
    memoryDirs: [...memoryDirs].sort(),
  };
}
