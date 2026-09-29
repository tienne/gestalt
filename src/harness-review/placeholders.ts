/**
 * 자리표시자 파일 단위 해석.
 *
 * `{REPO_ROOT}`, `{DESIGN_ROOT}`, `$REPO_ROOT`는 같은 토큰이어도 파일마다 다른 레포를 가리킨다.
 * 그래서 토큰 하나로 레포를 정하지 않고 그 파일이 토큰 뒤에 적은 경로들이 실제로 있는 레포를 찾는다.
 * 자기 레포에 경로가 있으면 거기서 끝낸다. 다른 레포에도 같은 경로가 있는 흔한 경우의 오탐을 막으려는 순서다.
 * 여러 레포에 맞거나 하나도 안 맞으면 코드가 정하지 않고 LLM 판정 후보로 넘긴다.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Placeholder } from './types.js';

export interface PlaceholderRepo {
  /** 'owner/name' 또는 이름. 결과의 resolvedRepo에 그대로 실린다 */
  repo: string;
  dir: string;
}

export type PlaceholderReason = 'ownRepo' | 'unique' | 'ambiguous' | 'unmatched' | 'noPath';

export interface ResolvedPlaceholder extends Placeholder {
  /** 토큰 뒤에 적힌 경로들. 토큰 자체는 뗀 상대 경로다 */
  paths: string[];
  /** 경로가 실제로 있는 레포 전부 */
  matchedRepos: string[];
  reason: PlaceholderReason;
  /** multiple이나 none이라 값을 정하는 자리를 LLM이 읽어야 한다 */
  needsLlmJudgment: boolean;
}

export interface PlaceholderRef {
  token: string;
  path: string;
  line: number;
}

export interface ResolvePlaceholdersInput {
  /** 해석 대상 문서가 든 레포(플러그인 루트가 속한 레포) */
  ownRepo: PlaceholderRepo;
  /** 관련 레포. ownRepo가 섞여 있어도 무시한다 */
  otherRepos: PlaceholderRepo[];
  /** ownRepo.dir 기준 상대 경로. 없으면 md 파일을 훑어 토큰이 있는 것만 본다 */
  files?: string[];
}

/**
 * 어느 레포에나 있는 문서 이름. 자기 레포에 있다는 사실이 증거가 못 되므로 자기 레포 우선 규칙을 적용하지 않는다.
 * 여기에만 맞는 파일이면 다른 레포에 없을 때 단독으로 풀린다.
 */
export const GENERIC_DOC_NAMES: ReadonlySet<string> = new Set([
  'readme.md',
  'license',
  'license.md',
  'changelog.md',
  'contributing.md',
  'code_of_conduct.md',
  'security.md',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', '.gestalt', '.gestalt-test', 'dist']);

// {NAME_ROOT}, ${NAME_ROOT}, $NAME_ROOT 뒤에 `/경로`가 이어지는 꼴
const TOKEN_PATH =
  /(\{[A-Z][A-Z0-9_]*_ROOT\}|\$\{[A-Z][A-Z0-9_]*_ROOT\}|\$[A-Z][A-Z0-9_]*_ROOT)(\/[\w@.\-/]*)?/g;

function cleanPath(raw: string): string {
  return raw
    .replace(/^\/+/, '')
    .replace(/[.,;:)\]]+$/, '')
    .replace(/\/+$/, '');
}

export function extractPlaceholderRefs(text: string): PlaceholderRef[] {
  const refs: PlaceholderRef[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(TOKEN_PATH)) {
      refs.push({ token: m[1]!, path: cleanPath(m[2] ?? ''), line: i + 1 });
    }
  }
  return refs;
}

function isGenericDoc(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  return GENERIC_DOC_NAMES.has(base.toLowerCase());
}

function reposHaving(paths: string[], repos: PlaceholderRepo[]): string[] {
  return repos.filter((r) => paths.every((p) => existsSync(join(r.dir, p)))).map((r) => r.repo);
}

function resolveOne(
  token: string,
  definingFile: string,
  paths: string[],
  ownRepo: PlaceholderRepo,
  others: PlaceholderRepo[],
): ResolvedPlaceholder {
  const base = { token, definingFile, paths };
  if (paths.length === 0) {
    return {
      ...base,
      resolutionStatus: 'none',
      matchedRepos: [],
      reason: 'noPath',
      needsLlmJudgment: true,
    };
  }

  const ownHas = reposHaving(paths, [ownRepo]).length > 0;
  if (ownHas && !paths.every(isGenericDoc)) {
    return {
      ...base,
      resolutionStatus: 'single',
      resolvedRepo: ownRepo.repo,
      matchedRepos: [ownRepo.repo],
      reason: 'ownRepo',
      needsLlmJudgment: false,
    };
  }

  const matched = reposHaving(paths, [ownRepo, ...others]);
  if (matched.length === 1) {
    return {
      ...base,
      resolutionStatus: 'single',
      resolvedRepo: matched[0]!,
      matchedRepos: matched,
      reason: matched[0] === ownRepo.repo ? 'ownRepo' : 'unique',
      needsLlmJudgment: false,
    };
  }
  return {
    ...base,
    resolutionStatus: matched.length === 0 ? 'none' : 'multiple',
    matchedRepos: matched,
    reason: matched.length === 0 ? 'unmatched' : 'ambiguous',
    needsLlmJudgment: true,
  };
}

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const abs = join(e.parentPath, e.name);
    const rel = abs.slice(dir.length + 1);
    if (rel.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
    out.push(rel);
  }
  return out.sort();
}

/**
 * 파일마다, 그 파일에 나온 토큰마다 한 건씩 돌려준다. 같은 파일 안의 같은 토큰은 경로를 모아 한 번에 푼다.
 * 서로 다른 파일의 같은 토큰은 각자 풀리므로 다른 레포로 갈 수 있다.
 */
export function resolvePlaceholders(input: ResolvePlaceholdersInput): ResolvedPlaceholder[] {
  const { ownRepo } = input;
  const others = input.otherRepos.filter((r) => r.repo !== ownRepo.repo);
  const files = input.files ?? listMarkdown(ownRepo.dir);
  const results: ResolvedPlaceholder[] = [];

  for (const file of files) {
    const abs = join(ownRepo.dir, file);
    if (!existsSync(abs)) continue;
    const byToken = new Map<string, Set<string>>();
    for (const ref of extractPlaceholderRefs(readFileSync(abs, 'utf-8'))) {
      const set = byToken.get(ref.token) ?? new Set<string>();
      if (ref.path) set.add(ref.path);
      byToken.set(ref.token, set);
    }
    for (const [token, paths] of byToken) {
      results.push(resolveOne(token, file, [...paths].sort(), ownRepo, others));
    }
  }
  return results;
}

/** task-11 같은 호출부가 문서 안 `{REPO_ROOT}/x` 언급을 어느 레포로 볼지 찾을 때 쓴다 */
export function lookupPlaceholder(
  results: ResolvedPlaceholder[],
  definingFile: string,
  token: string,
): ResolvedPlaceholder | undefined {
  return results.find((r) => r.definingFile === definingFile && r.token === token);
}

export function placeholdersNeedingJudgment(results: ResolvedPlaceholder[]): ResolvedPlaceholder[] {
  return results.filter((r) => r.needsLlmJudgment);
}
