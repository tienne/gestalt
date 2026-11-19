/**
 * 저장 IR이 어느 커밋에서 그려졌는지 기록하고 지금과 비교하는 git 조회 모음.
 * validator는 동기 함수라 여기 함수도 전부 동기로 둔다. git이 없거나 레포가 아니면 던지지 않고 비어 있는 값을 돌려준다.
 */
import { execFileSync } from 'node:child_process';
import type { ArchitectureIr } from './types.js';
import { CODE_LOCATION_RE, type FindMovedFile } from './validator.js';

/** head가 없을 때 rename을 찾아볼 최근 커밋 수. 임시값이라 여기 한 곳에만 둔다 */
export const RENAME_FALLBACK_COMMITS = 200;

const HEX_COMMIT = /^[0-9a-f]{7,64}$/;

function git(root: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

function nulTokens(out: string): string[] {
  return out.split('\0').filter((t) => t.length > 0);
}

/** 지금 HEAD 커밋. git 레포가 아니거나 커밋이 없으면 undefined */
export function readHead(root: string): string | undefined {
  const out = git(root, ['rev-parse', 'HEAD'])?.trim();
  return out !== undefined && HEX_COMMIT.test(out) ? out : undefined;
}

function commitExists(root: string, head: string): boolean {
  return git(root, ['cat-file', '-e', `${head}^{commit}`]) !== undefined;
}

/** 작업 트리에서 커밋 안 된 추적 파일 경로. 추적 안 하는 새 파일은 세지 않는다 */
function uncommittedPaths(root: string): string[] | undefined {
  const out = git(root, ['status', '--porcelain', '-z', '--untracked-files=no']);
  if (out === undefined) return undefined;
  const tokens = nulTokens(out);
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i]!;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    // rename과 copy는 다음 토큰에 원래 경로가 붙는다. 옮겨 간 옛 경로도 바뀐 파일로 센다
    if (status.includes('R') || status.includes('C')) {
      const orig = tokens[i + 1];
      if (status.includes('R') && orig !== undefined) paths.push(orig);
      i += 1;
    }
  }
  return paths;
}

export type ChangedSince =
  | { ok: true; changed: string[]; uncommitted: string[] }
  | { ok: false; reason: 'not_git' | 'head_not_found' };

/** 기록된 head 이후 커밋으로 바뀐 파일과 아직 커밋 안 된 파일 */
export function changedFilesSince(root: string, head: string): ChangedSince {
  if (readHead(root) === undefined) return { ok: false, reason: 'not_git' };
  if (!HEX_COMMIT.test(head) || !commitExists(root, head)) {
    return { ok: false, reason: 'head_not_found' };
  }
  // rename을 짝짓지 않아야 옮겨 간 옛 경로도 목록에 남는다. 근거는 옛 경로를 가리키고 있다
  const diff = git(root, ['diff', '--name-only', '--no-renames', '-z', head, 'HEAD']);
  const uncommitted = uncommittedPaths(root);
  if (diff === undefined || uncommitted === undefined) return { ok: false, reason: 'not_git' };
  return { ok: true, changed: nulTokens(diff).sort(), uncommitted: uncommitted.sort() };
}

/**
 * 옛 경로 → 지금 경로. head가 있으면 head..HEAD, 없으면 최근 커밋 몇 개를 본다.
 * 스테이징된 rename도 넣고 a→b→c 같은 사슬은 끝까지 따라간다.
 */
export function findRenames(root: string, sinceHead?: string): Map<string, string> {
  const steps: Array<[string, string]> = [];
  const range =
    sinceHead !== undefined && HEX_COMMIT.test(sinceHead) && commitExists(root, sinceHead)
      ? [`${sinceHead}..HEAD`]
      : ['-n', String(RENAME_FALLBACK_COMMITS), 'HEAD'];
  const log = git(root, [
    'log',
    '-M',
    '--diff-filter=R',
    '--name-status',
    '--format=',
    '-z',
    ...range,
  ]);
  if (log !== undefined) {
    const tokens = nulTokens(log.replace(/\n/g, '\0'));
    const commits: Array<[string, string]> = [];
    for (let i = 0; i < tokens.length; i += 1) {
      if (!/^R\d*$/.test(tokens[i]!)) continue;
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      if (from !== undefined && to !== undefined) commits.push([from, to]);
      i += 2;
    }
    // git log는 최신부터 나오므로 뒤집어 오래된 이동부터 적용한다
    steps.push(...commits.reverse());
  }
  const status = git(root, ['status', '--porcelain', '-z', '--untracked-files=no']);
  if (status !== undefined) {
    const tokens = nulTokens(status);
    for (let i = 0; i < tokens.length; i += 1) {
      const entry = tokens[i]!;
      const xy = entry.slice(0, 2);
      if (xy.includes('R') || xy.includes('C')) {
        const orig = tokens[i + 1];
        if (xy[0] === 'R' && orig !== undefined) steps.push([orig, entry.slice(3)]);
        i += 1;
      }
    }
  }
  const next = new Map<string, string>();
  for (const [from, to] of steps) next.set(from, to);
  const resolved = new Map<string, string>();
  for (const from of next.keys()) {
    let cur = next.get(from)!;
    const seen = new Set([from]);
    while (next.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = next.get(cur)!;
    }
    if (cur !== from) resolved.set(from, cur);
  }
  return resolved;
}

/**
 * validator의 findMoved 자리에 넣을 git 구현. 레포마다 git을 한 번만 부르도록 결과를 담아 둔다.
 * sinceHeads는 저장 IR의 repos[].head다. 없는 레포는 최근 커밋으로 찾는다.
 */
export function createGitMoveFinder(
  sinceHeads: ReadonlyMap<string, string> = new Map(),
): FindMovedFile {
  const cache = new Map<string, Map<string, string>>();
  return (repoId, root, relPath) => {
    const key = `${repoId}\0${root}`;
    let renames = cache.get(key);
    if (renames === undefined) {
      renames = findRenames(root, sinceHeads.get(repoId));
      cache.set(key, renames);
    }
    const to = renames.get(relPath.replace(/^\.\//, ''));
    return to === undefined ? [] : [to];
  };
}

export type RepoFreshness =
  | {
      repo: string;
      status: 'fresh' | 'stale';
      head: string;
      current: string;
      /** head 이후 커밋으로 바뀐 파일 수 */
      changedFiles: number;
      /** 아직 커밋 안 된 추적 파일 수 */
      uncommitted: number;
    }
  | {
      repo: string;
      status: 'unknown';
      reason: 'no_head' | 'not_git' | 'head_not_found';
      message: string;
    };

export interface ViewFreshness {
  /** 레포 하나라도 낡았으면 stale, 판단 못 한 레포만 있으면 unknown */
  status: 'fresh' | 'stale' | 'unknown';
  repos: RepoFreshness[];
  /** 근거로 쓰인 파일 중 head 이후 바뀐 것. `<repo>:<경로>` 꼴 */
  staleEvidenceFiles: string[];
}

/** IR 어디에 있든 code 근거의 레포와 파일 경로를 모은다(노드, 엣지, 흐름, 투영) */
function codeEvidenceFiles(value: unknown, out: Map<string, Set<string>>): void {
  if (Array.isArray(value)) {
    for (const v of value) codeEvidenceFiles(v, out);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  if (obj['type'] === 'code' && typeof obj['location'] === 'string') {
    const m = CODE_LOCATION_RE.exec(obj['location']);
    if (m) {
      const files = out.get(m[1]!) ?? new Set<string>();
      files.add(m[2]!.replace(/^\.\//, ''));
      out.set(m[1]!, files);
    }
  }
  for (const v of Object.values(obj)) codeEvidenceFiles(v, out);
}

const UNKNOWN_MESSAGE: Record<'no_head' | 'not_git' | 'head_not_found', string> = {
  no_head: '저장 IR에 커밋 해시가 없다(예전 IR). 다시 render하면 기록된다.',
  not_git: 'git 레포가 아니거나 커밋이 없어 비교하지 못했다.',
  head_not_found: '기록된 커밋을 지금 레포에서 찾지 못했다(rebase나 얕은 clone).',
};

/** 저장 IR의 repos[].head와 지금 HEAD를 비교한다. rootOf는 레포 id를 절대 경로로 푼다 */
export function viewFreshness(
  ir: ArchitectureIr,
  rootOf: (repo: ArchitectureIr['repos'][number]) => string,
): ViewFreshness {
  const evidence = new Map<string, Set<string>>();
  codeEvidenceFiles(ir, evidence);
  const repos: RepoFreshness[] = [];
  const stale: string[] = [];
  for (const repo of ir.repos) {
    const unknown = (reason: 'no_head' | 'not_git' | 'head_not_found'): RepoFreshness => ({
      repo: repo.id,
      status: 'unknown',
      reason,
      message: UNKNOWN_MESSAGE[reason],
    });
    if (repo.head === undefined) {
      repos.push(unknown('no_head'));
      continue;
    }
    const root = rootOf(repo);
    const current = readHead(root);
    const since = changedFilesSince(root, repo.head);
    if (current === undefined || !since.ok) {
      repos.push(unknown(since.ok ? 'not_git' : since.reason));
      continue;
    }
    const touched = new Set([...since.changed, ...since.uncommitted]);
    const files = [...(evidence.get(repo.id) ?? [])].filter((f) => touched.has(f)).sort();
    stale.push(...files.map((f) => `${repo.id}:${f}`));
    repos.push({
      repo: repo.id,
      status: touched.size > 0 ? 'stale' : 'fresh',
      head: repo.head,
      current,
      changedFiles: since.changed.length,
      uncommitted: since.uncommitted.length,
    });
  }
  const status = repos.some((r) => r.status === 'stale')
    ? 'stale'
    : repos.length > 0 && repos.every((r) => r.status === 'fresh')
      ? 'fresh'
      : 'unknown';
  return { status, repos, staleEvidenceFiles: stale };
}
