import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ArtifactCheck, ArtifactVerification, WorkingTreeBaseline } from '../core/types.js';
import { ARTIFACT_GIT_TIMEOUT_MS } from '../core/constants.js';

// Passthrough라 파일을 바꾸는 건 호스트다. 서버가 볼 수 있는 건 호스트가 남긴 git 작업 트리뿐이라
// 완료 보고를 받으면 그 트리를 실행 시작 시점과 대조한다.

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf-8',
    timeout: ARTIFACT_GIT_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function tryGit(cwd: string, args: string[], input?: string): string | null {
  try {
    return git(cwd, args, input);
  } catch {
    return null;
  }
}

/** 상대 경로들의 현재 blob 해시. 없는 파일은 null */
function hashFiles(repoRoot: string, paths: string[]): Map<string, string | null> {
  const result = new Map<string, string | null>();
  const existing = paths.filter((p) => existsSync(resolve(repoRoot, p)));
  for (const p of paths) result.set(p, null);
  if (existing.length === 0) return result;

  const lines = git(repoRoot, ['hash-object', '--stdin-paths'], existing.join('\n') + '\n')
    .trim()
    .split('\n');
  existing.forEach((p, i) => result.set(p, lines[i] ?? null));
  return result;
}

/** HEAD 기준 blob 해시. HEAD에 없는 경로는 null */
function headBlobs(repoRoot: string, head: string, paths: string[]): Map<string, string | null> {
  const result = new Map<string, string | null>();
  if (paths.length === 0) return result;

  const lines = git(
    repoRoot,
    ['cat-file', '--batch-check'],
    paths.map((p) => `${head}:${p}`).join('\n') + '\n',
  )
    .trim()
    .split('\n');
  paths.forEach((p, i) => {
    const [sha, type] = (lines[i] ?? '').split(' ');
    result.set(p, type === 'blob' && sha ? sha : null);
  });
  return result;
}

/** `git status -z` 출력에서 경로만 뽑는다. rename은 새 경로와 옛 경로가 둘 다 나온다 */
function parseStatusPaths(raw: string): string[] {
  const entries = raw.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const code = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (code.includes('R') || code.includes('C')) {
      const from = entries[i + 1];
      if (from) paths.push(from);
      i++;
    }
  }
  return paths;
}

/**
 * 실행 시작 시점의 작업 트리를 잡아둔다. git 레포가 아니면 null을 돌려주고
 * 그 세션은 완료 보고를 대조하지 않는다.
 */
export function captureWorkingTreeBaseline(cwd: string): WorkingTreeBaseline | null {
  if (!existsSync(cwd)) return null;
  const top = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  if (top === null) return null;

  const repoRoot = top.trim();
  const head = tryGit(repoRoot, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() || null;
  const dirtyPaths = parseStatusPaths(
    git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  );

  return {
    repoRoot,
    cwd: realpathSync(cwd),
    head,
    dirty: Object.fromEntries(hashFiles(repoRoot, dirtyPaths)),
    capturedAt: new Date().toISOString(),
  };
}

/** 아직 없는 파일도 있어서 존재하는 가장 가까운 조상까지 올라가 realpath를 푼다 (macOS의 /var → /private/var) */
function toRealPath(absPath: string): string {
  let current = absPath;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absPath;
    tail.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return resolve(realpathSync(current), ...tail);
}

function toRepoRelative(baseline: WorkingTreeBaseline, artifact: string): string | null {
  const abs = toRealPath(resolve(baseline.cwd, artifact));
  const rel = relative(baseline.repoRoot, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * artifacts로 주장된 파일이 실행 시작 뒤로 실제로 바뀌었는지 확인한다.
 * 지워진 파일도 시작 시점에 있었다면 바뀐 것으로 친다.
 */
export function verifyArtifacts(
  baseline: WorkingTreeBaseline,
  artifacts: string[],
): ArtifactVerification {
  const files: ArtifactCheck[] = [];
  const candidates: Array<{ path: string; rel: string }> = [];

  for (const path of artifacts) {
    const rel = toRepoRelative(baseline, path);
    if (rel === null) {
      files.push({ path, status: 'outside_repo' });
      continue;
    }
    const abs = resolve(baseline.repoRoot, rel);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      files.push({ path, status: 'directory' });
      continue;
    }
    candidates.push({ path, rel });
  }

  const rels = candidates.map((c) => c.rel);
  if (rels.length === 0) return { verified: false, files };

  // check-ignore는 걸린 게 하나도 없으면 exit 1이라 null로 떨어진다
  const ignored = new Set(
    (tryGit(baseline.repoRoot, ['check-ignore', '--stdin'], rels.join('\n') + '\n') ?? '')
      .split('\n')
      .filter(Boolean),
  );
  const current = hashFiles(baseline.repoRoot, rels);
  const fromHead = baseline.head
    ? headBlobs(
        baseline.repoRoot,
        baseline.head,
        rels.filter((r) => !(r in baseline.dirty)),
      )
    : new Map<string, string | null>();

  for (const { path, rel } of candidates) {
    if (ignored.has(rel)) {
      files.push({ path, status: 'ignored' });
      continue;
    }
    const now = current.get(rel) ?? null;
    const before =
      rel in baseline.dirty ? (baseline.dirty[rel] ?? null) : (fromHead.get(rel) ?? null);
    if (now === null && before === null) files.push({ path, status: 'missing' });
    else if (now === before) files.push({ path, status: 'unchanged' });
    else files.push({ path, status: 'changed' });
  }

  const order = new Map(artifacts.map((a, i) => [a, i]));
  files.sort((a, b) => order.get(a.path)! - order.get(b.path)!);
  return { verified: files.every((f) => f.status === 'changed'), files };
}
