import { execFile } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ArtifactCheck, ArtifactVerification, WorkingTreeBaseline } from '../core/types.js';
import { ARTIFACT_GIT_TIMEOUT_MS } from '../core/constants.js';

// Passthrough라 파일을 바꾸는 건 호스트다. 서버가 볼 수 있는 건 호스트가 남긴 git 작업 트리뿐이라
// 완료 보고를 받으면 그 트리를 실행 시작 시점과 대조한다.

// MCP 서버는 한 프로세스에서 모든 도구 호출을 받으므로 git을 기다리는 동안 다른 호출을 막지 않게 비동기로 부른다.
// core.fsmonitor는 레포 설정이 외부 명령을 돌리게 하는 자리라 끈다.
// hash-object의 clean 필터는 끄면 HEAD blob과 해시가 어긋나서 못 끈다. 그래서 cwd 레포의 filter 설정은 대조 중에 돈다.
function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.fsmonitor=false', ...args],
      {
        cwd,
        encoding: 'utf-8',
        timeout: ARTIFACT_GIT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error(`git ${args[0]} failed: ${error.message}`));
          return;
        }
        resolvePromise(stdout);
      },
    );
    // git이 입력을 다 읽기 전에 끝나면 EPIPE가 stdin 스트림 에러로 따로 올라온다. 리스너가 없으면 서버가 죽는다.
    // 실패 자체는 위 콜백이 reject하고 덜 읽힌 출력은 splitLines가 줄 수로 잡는다
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

async function tryGit(cwd: string, args: string[], input?: string): Promise<string | null> {
  try {
    return await git(cwd, args, input);
  } catch {
    return null;
  }
}

const UNSAFE_PATH = /[\n\r\0]/;
const BATCH_CHECK_LINE = /^([0-9a-f]{40}|[0-9a-f]{64}) (\w+) \d+$/;

/** 줄 단위 stdin에 실을 수 없는 경로가 섞이면 출력 줄과 짝이 어긋난다 */
function splitLines(raw: string, expected: number, what: string): string[] {
  const lines = raw.trim().split('\n');
  if (lines.length !== expected) {
    throw new Error(`${what}: expected ${expected} lines, got ${lines.length}`);
  }
  return lines;
}

function isHashable(abs: string): boolean {
  if (!existsSync(abs)) return false;
  const st = lstatSync(abs);
  return st.isFile() || st.isSymbolicLink();
}

/** 상대 경로들의 현재 blob 해시. 없거나 일반 파일이 아니면 null */
async function hashFiles(repoRoot: string, paths: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  for (const p of paths) result.set(p, null);

  const existing = paths.filter((p) => isHashable(resolve(repoRoot, p)));
  const batch = existing.filter((p) => !UNSAFE_PATH.test(p));
  const single = existing.filter((p) => UNSAFE_PATH.test(p));

  if (batch.length > 0) {
    const out = await git(repoRoot, ['hash-object', '--stdin-paths'], batch.join('\n') + '\n');
    const lines = splitLines(out, batch.length, 'hash-object');
    batch.forEach((p, i) => result.set(p, lines[i]!));
  }
  for (const p of single) {
    result.set(p, (await git(repoRoot, ['hash-object', '--', p])).trim());
  }
  return result;
}

/** HEAD 기준 blob 해시. HEAD에 없는 경로는 null */
async function headBlobs(
  repoRoot: string,
  head: string,
  paths: string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (paths.length === 0) return result;

  const out = await git(
    repoRoot,
    ['cat-file', '--batch-check'],
    paths.map((p) => `${head}:${p}`).join('\n') + '\n',
  );
  const lines = splitLines(out, paths.length, 'cat-file');
  // 없는 객체는 `<입력> missing`으로 나온다. 경로에 공백이 있으면 그 입력이 sha 자리처럼 읽히므로 hex로 확인한다
  paths.forEach((p, i) => {
    const m = BATCH_CHECK_LINE.exec(lines[i]!);
    result.set(p, m && m[2] === 'blob' ? m[1]! : null);
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
 * 실행 시작 시점의 작업 트리를 잡아둔다. git 레포가 아니면 null이다.
 * 레포인데 git 호출이 실패하면 예외를 던진다. 부르는 쪽이 두 경우를 나눠 응답에 드러낸다.
 */
export async function captureWorkingTreeBaseline(cwd: string): Promise<WorkingTreeBaseline | null> {
  if (!existsSync(cwd)) return null;
  const top = await tryGit(cwd, ['rev-parse', '--show-toplevel']);
  if (top === null) return null;

  const repoRoot = top.trim();
  const head = (await tryGit(repoRoot, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim() || null;
  const dirtyPaths = parseStatusPaths(
    await git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  );

  return {
    repoRoot,
    cwd: realpathSync(cwd),
    head,
    dirty: Object.fromEntries(await hashFiles(repoRoot, dirtyPaths)),
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
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * artifacts로 주장된 파일이 실행 시작 뒤로 실제로 바뀌었는지 확인한다.
 * 지워진 파일도 시작 시점에 있었다면 바뀐 것으로 친다.
 */
export async function verifyArtifacts(
  baseline: WorkingTreeBaseline,
  artifacts: string[],
): Promise<ArtifactVerification> {
  const files: ArtifactCheck[] = [];
  const candidates: Array<{ path: string; rel: string }> = [];

  for (const path of new Set(artifacts)) {
    if (UNSAFE_PATH.test(path)) {
      files.push({ path, status: 'invalid_path' });
      continue;
    }
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
    if (existsSync(abs) && !isHashable(abs)) {
      files.push({ path, status: 'not_regular_file' });
      continue;
    }
    candidates.push({ path, rel });
  }

  const rels = candidates.map((c) => c.rel);
  if (rels.length === 0) return { verified: false, files: sortByInput(files, artifacts) };

  // check-ignore는 걸린 게 하나도 없으면 exit 1이라 null로 떨어진다.
  // -z가 없으면 비ASCII 경로가 따옴표와 8진수 이스케이프로 나와 이름이 안 맞는다
  const ignored = new Set(
    (
      (await tryGit(
        baseline.repoRoot,
        ['check-ignore', '-z', '--stdin'],
        rels.join('\0') + '\0',
      )) ?? ''
    )
      .split('\0')
      .filter(Boolean),
  );
  const current = await hashFiles(baseline.repoRoot, rels);
  const fromHead = baseline.head
    ? await headBlobs(
        baseline.repoRoot,
        baseline.head,
        rels.filter((r) => !Object.hasOwn(baseline.dirty, r)),
      )
    : new Map<string, string | null>();

  for (const { path, rel } of candidates) {
    if (ignored.has(rel)) {
      files.push({ path, status: 'ignored' });
      continue;
    }
    const now = current.get(rel) ?? null;
    const before = Object.hasOwn(baseline.dirty, rel)
      ? (baseline.dirty[rel] ?? null)
      : (fromHead.get(rel) ?? null);
    if (now === null && before === null) files.push({ path, status: 'missing' });
    else if (now === before) files.push({ path, status: 'unchanged' });
    else files.push({ path, status: 'changed' });
  }

  const sorted = sortByInput(files, artifacts);
  return { verified: sorted.every((f) => f.status === 'changed'), files: sorted };
}

function sortByInput(files: ArtifactCheck[], artifacts: string[]): ArtifactCheck[] {
  const order = new Map<string, number>();
  artifacts.forEach((a, i) => {
    if (!order.has(a)) order.set(a, i);
  });
  return [...files].sort((a, b) => order.get(a.path)! - order.get(b.path)!);
}
