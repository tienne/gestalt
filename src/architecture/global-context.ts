import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findClaudeProjectMemoryDirs, type ExecGit } from '../utils/claude-projects.js';
import type { Visibility } from './types.js';

export interface ContextCandidate {
  via: 'repo' | 'global';
  /** 세션이 그대로 읽을 수 있게 절대경로로 둔다 */
  identifier: string;
  exists: boolean;
  visibility: Visibility;
}

export interface CollectGlobalContextOptions {
  repoRoot: string;
  /** 기본값은 os.homedir(). 테스트에서 주입한다 */
  homeDir?: string;
  /** 기본값은 `<homeDir>/.claude/projects` */
  projectsRoot?: string;
  execGit?: ExecGit;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function listMarkdown(dir: string, recursive: boolean): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { recursive, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => join(d.parentPath, d.name));
  } catch {
    return [];
  }
}

/**
 * 아키텍처 뷰를 그리기 전에 세션이 읽어볼 만한 맥락 파일 후보를 모은다. 본문은 읽지 않는다.
 * 레포 밖 홈 디렉토리 파일은 private이다. 개인 메모가 공유 HTML로 새지 않게 출처에서부터 표시한다.
 */
export function collectGlobalContext(opts: CollectGlobalContextOptions): ContextCandidate[] {
  const { repoRoot } = opts;
  const homeDir = opts.homeDir ?? homedir();
  const projectsRoot = opts.projectsRoot ?? join(homeDir, '.claude', 'projects');
  const candidates: ContextCandidate[] = [];

  const fixed = (via: ContextCandidate['via'], path: string, visibility: Visibility) =>
    candidates.push({ via, identifier: path, exists: isFile(path), visibility });

  fixed('repo', join(repoRoot, 'CLAUDE.md'), 'public');
  fixed('repo', join(repoRoot, 'AGENTS.md'), 'public');
  fixed('repo', join(repoRoot, '.gestalt', 'memory.json'), 'public');
  for (const path of listMarkdown(join(repoRoot, 'docs'), true)) {
    candidates.push({ via: 'repo', identifier: path, exists: true, visibility: 'public' });
  }

  fixed('global', join(homeDir, '.claude', 'CLAUDE.md'), 'private');
  const { memoryDirs } = findClaudeProjectMemoryDirs({
    repoRoot,
    projectsRoot,
    execGit: opts.execGit,
  });
  for (const dir of memoryDirs) {
    for (const path of listMarkdown(dir, false)) {
      candidates.push({ via: 'global', identifier: path, exists: true, visibility: 'private' });
    }
  }

  // 홈 디렉토리 안에서 레포를 연 경우 같은 파일이 두 번 잡힐 수 있다. 먼저 넣은 repo 쪽을 남긴다
  const unique = new Map<string, ContextCandidate>();
  for (const c of candidates) {
    if (!unique.has(c.identifier)) unique.set(c.identifier, c);
  }
  return [...unique.values()].sort(compareCandidate);
}

function compareCandidate(a: ContextCandidate, b: ContextCandidate): number {
  if (a.via !== b.via) return a.via === 'repo' ? -1 : 1;
  if (a.identifier === b.identifier) return 0;
  return a.identifier < b.identifier ? -1 : 1;
}
