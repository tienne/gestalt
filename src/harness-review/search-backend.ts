import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { SearchBackend, SearchBackendKind } from './types.js';

export interface SearchHit {
  /** owner/name 표기 */
  repo: string;
  /** 레포 루트 기준, 항상 슬래시 구분자 */
  path: string;
  /** 1부터 시작 */
  line: number;
  /** 매치된 줄 전체. MAX_HIT_TEXT_LENGTH에서 자른다 */
  text: string;
}

export interface SkippedRepo {
  repo: string;
  reason: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** 검색하지 못한 레포. 결과가 비었다고 "참조 없음"으로 읽지 않게 따로 싣는다 */
  skipped: SkippedRepo[];
}

export interface SearchOptions {
  /** 레포당 상한. 넘으면 앞쪽만 남긴다 */
  maxHitsPerRepo?: number;
  /**
   * 이 문자열도 함께 있는 결과만 쓸 질의. GitHub 백엔드는 질의에 AND로 붙여 서버가 거르게 하고
   * 로컬 백엔드는 무시한다. 부르는 쪽이 어차피 결과를 다시 거르므로 로컬에서 더 찾아도 틀리지 않는다
   */
  requireAlso?: string;
}

export interface BackendCounts {
  /** 실제로 찾은 질의 수 */
  searched: number;
  /** 한도나 막힘 때문에 보내지 않은 질의 수 */
  skipped: number;
}

/** 식별자 문자열을 관련 레포에서 찾는 역방향 검색. 구현체를 바꿔 끼워도 호출부는 그대로다 */
export interface CodeSearchBackend extends SearchBackend {
  /** identifier는 정규식이 아닌 고정 문자열로 찾는다. repos는 owner/name 목록 */
  search(identifier: string, repos: string[], opts?: SearchOptions): Promise<SearchResult>;
  /**
   * 그 레포에 이 경로의 파일이 있는지. `/`가 없으면 같은 이름의 파일이 어디든 있는지 본다.
   * 모르면 undefined다. 파일 목록을 싸게 못 얻는 백엔드는 구현하지 않는다
   */
  hasFile?(repo: string, path: string): boolean | undefined;
  /**
   * 앞으로 보낼 질의마다 넘길 레포 목록을 미리 알린다. 한도가 있는 백엔드가 남은 질의로
   * 기다릴지 정하는 데 쓴다
   */
  plan?(queryRepos: string[][]): void;
  /** 백엔드별 범위. refs.json에 그대로 싣는다 */
  counts?(): Partial<Record<SearchBackendKind, BackendCounts>>;
}

export const DEFAULT_MAX_HITS_PER_REPO = 100;
export const MAX_HIT_TEXT_LENGTH = 300;

const MAX_FILE_BYTES = 1_000_000;
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

export interface LocalRepoSource {
  /** owner/name */
  repo: string;
  /** clone이나 워크트리 디렉토리 */
  dir: string;
  /** 지정하면 워킹트리 대신 이 ref(브랜치, SHA)의 트리를 본다 */
  ref?: string;
}

export class LocalCloneBackend implements CodeSearchBackend {
  readonly kind = 'localClone' as const;
  readonly capabilities = {
    fixedStringSearch: true,
    refSnapshot: true,
    rateLimited: false,
  };

  private readonly sources = new Map<string, LocalRepoSource>();

  private searchedCount = 0;
  private skippedCount = 0;

  private readonly fileLists = new Map<string, { paths: Set<string>; names: Set<string> } | null>();

  constructor(sources: LocalRepoSource[]) {
    for (const s of sources) this.sources.set(s.repo, s);
  }

  hasFile(repo: string, path: string): boolean | undefined {
    const list = this.fileList(repo);
    if (!list) return undefined;
    const clean = path.replace(/^\.\//, '').replace(/\/$/, '');
    if (!clean.includes('/')) return list.names.has(clean);
    // 모노레포면 같은 경로가 한 단계 안쪽(plugins/*/.claude-plugin/plugin.json)에 있다
    return (
      list.paths.has(clean) ||
      [...list.paths].some((p) => p.startsWith(`${clean}/`) || p.endsWith(`/${clean}`))
    );
  }

  private fileList(repo: string): { paths: Set<string>; names: Set<string> } | null {
    if (this.fileLists.has(repo)) return this.fileLists.get(repo)!;
    const source = this.sources.get(repo);
    let list: { paths: Set<string>; names: Set<string> } | null = null;
    if (source && (source.ref || isGitRoot(source.dir))) {
      const args = source.ref
        ? ['-C', source.dir, 'ls-tree', '-r', '--name-only', source.ref]
        : ['-C', source.dir, 'ls-files'];
      const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      });
      if (r.status === 0) {
        const paths = new Set(r.stdout.split('\n').filter(Boolean));
        list = { paths, names: new Set([...paths].map((p) => p.slice(p.lastIndexOf('/') + 1))) };
      }
    }
    this.fileLists.set(repo, list);
    return list;
  }

  async search(
    identifier: string,
    repos: string[],
    opts: SearchOptions = {},
  ): Promise<SearchResult> {
    const max = opts.maxHitsPerRepo ?? DEFAULT_MAX_HITS_PER_REPO;
    const result: SearchResult = { hits: [], skipped: [] };
    if (identifier === '') return result;
    this.searchRepos(identifier, repos, max, result);
    if (result.skipped.length > 0) this.skippedCount++;
    else this.searchedCount++;
    return result;
  }

  counts(): Partial<Record<SearchBackendKind, BackendCounts>> {
    return { localClone: { searched: this.searchedCount, skipped: this.skippedCount } };
  }

  private searchRepos(
    identifier: string,
    repos: string[],
    max: number,
    result: SearchResult,
  ): void {
    for (const repo of repos) {
      const source = this.sources.get(repo);
      if (!source) {
        result.skipped.push({ repo, reason: '로컬 clone 경로가 없다' });
        continue;
      }
      try {
        const hits = source.ref
          ? grepRef(source, identifier)
          : (grepGitWorktree(source, identifier) ?? grepWorktree(source, identifier));
        result.hits.push(...hits.slice(0, max));
      } catch (e) {
        result.skipped.push({ repo, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }
}

function toHit(repo: string, path: string, line: number, text: string): SearchHit {
  return { repo, path, line, text: text.slice(0, MAX_HIT_TEXT_LENGTH) };
}

function isSkippedPath(relPath: string): boolean {
  return relPath.split('/').some((seg) => SKIPPED_DIRS.has(seg));
}

/**
 * git 작업 트리면 git grep으로 찾는다. 파일을 직접 훑으면 식별자마다 레포 전체를 다시 읽고
 * node_modules 같은 무시 디렉토리까지 내려갔다가 걸러내서, 큰 레포에서는 식별자 수십 개에 몇 분이 걸린다.
 * git 레포가 아니면 null을 돌려 직접 훑기로 넘긴다
 */
const gitRootCache = new Map<string, boolean>();

// 바깥 레포 안에 든 일반 디렉토리면 git이 바깥 레포를 잡는다. 디렉토리가 곧 작업 트리 루트일 때만 쓴다
function isGitRoot(dir: string): boolean {
  const cached = gitRootCache.get(dir);
  if (cached !== undefined) return cached;
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const ok = r.status === 0 && realpathSync(r.stdout.trim()) === realpathSync(dir);
  gitRootCache.set(dir, ok);
  return ok;
}

function grepGitWorktree(source: LocalRepoSource, identifier: string): SearchHit[] | null {
  if (!isGitRoot(source.dir)) return null;
  const r = spawnSync(
    'git',
    ['-C', source.dir, 'grep', '-n', '-F', '-I', '--null', '--no-color', '-e', identifier, '--'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.error) return null;
  if (r.status === 1) return [];
  if (r.status !== 0) return null;
  return parseGrepLines(source, r.stdout, '');
}

function parseGrepLines(source: LocalRepoSource, stdout: string, prefix: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const raw of stdout.split('\n')) {
    if (!raw.startsWith(prefix)) continue;
    // --null이면 경로와 줄 번호 뒤에 각각 NUL이 붙는다
    const m = /^([^\0]*)\0(\d+)\0(.*)$/.exec(raw.slice(prefix.length));
    if (!m) continue;
    const path = m[1]!;
    if (isSkippedPath(path)) continue;
    hits.push(toHit(source.repo, path, Number(m[2]!), m[3]!.trimEnd()));
  }
  return hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

function grepWorktree(source: LocalRepoSource, identifier: string): SearchHit[] {
  const entries = readdirSync(source.dir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((d) => d.isFile())
    .map((d) => relative(source.dir, join(d.parentPath, d.name)).split(sep).join('/'))
    .filter((p) => !isSkippedPath(p))
    .sort();

  const hits: SearchHit[] = [];
  for (const path of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(source.dir, path));
    } catch {
      continue;
    }
    if (buf.length > MAX_FILE_BYTES || buf.includes(0)) continue;
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((text, i) => {
      if (text.includes(identifier)) hits.push(toHit(source.repo, path, i + 1, text.trimEnd()));
    });
  }
  return hits;
}

function grepRef(source: LocalRepoSource, identifier: string): SearchHit[] {
  const ref = source.ref!;
  const r = spawnSync(
    'git',
    [
      '-C',
      source.dir,
      'grep',
      '-n',
      '-F',
      '-I',
      '--null',
      '--no-color',
      '-e',
      identifier,
      ref,
      '--',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.error) throw r.error;
  // status 1은 매치 없음이다
  if (r.status === 1) return [];
  if (r.status !== 0) throw new Error(`git grep 실패 (${ref}): ${r.stderr.trim()}`);

  return parseGrepLines(source, r.stdout, `${ref}:`);
}
