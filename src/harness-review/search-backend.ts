import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { SearchBackend } from './types.js';

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
}

/** 식별자 문자열을 관련 레포에서 찾는 역방향 검색. 구현체를 바꿔 끼워도 호출부는 그대로다 */
export interface CodeSearchBackend extends SearchBackend {
  /** identifier는 정규식이 아닌 고정 문자열로 찾는다. repos는 owner/name 목록 */
  search(identifier: string, repos: string[], opts?: SearchOptions): Promise<SearchResult>;
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

  constructor(sources: LocalRepoSource[]) {
    for (const s of sources) this.sources.set(s.repo, s);
  }

  async search(
    identifier: string,
    repos: string[],
    opts: SearchOptions = {},
  ): Promise<SearchResult> {
    const max = opts.maxHitsPerRepo ?? DEFAULT_MAX_HITS_PER_REPO;
    const result: SearchResult = { hits: [], skipped: [] };
    if (identifier === '') return result;

    for (const repo of repos) {
      const source = this.sources.get(repo);
      if (!source) {
        result.skipped.push({ repo, reason: '로컬 clone 경로가 없다' });
        continue;
      }
      try {
        const hits = source.ref ? grepRef(source, identifier) : grepWorktree(source, identifier);
        result.hits.push(...hits.slice(0, max));
      } catch (e) {
        result.skipped.push({ repo, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return result;
  }
}

function toHit(repo: string, path: string, line: number, text: string): SearchHit {
  return { repo, path, line, text: text.slice(0, MAX_HIT_TEXT_LENGTH) };
}

function isSkippedPath(relPath: string): boolean {
  return relPath.split('/').some((seg) => SKIPPED_DIRS.has(seg));
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

  const prefix = `${ref}:`;
  const hits: SearchHit[] = [];
  for (const raw of r.stdout.split('\n')) {
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
