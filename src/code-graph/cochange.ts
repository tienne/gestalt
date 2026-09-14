import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '../core/logger.js';
import type { CodeGraphStore } from './storage.js';
import type {
  BuildMode,
  CoChangeBuildSummary,
  CoChangeTuning,
  CoChangeLookup,
  CoChangeNeighbor,
  CoChangePair,
  CoChangeResult,
} from './types.js';

/**
 * 한 커밋이 이 개수를 넘게 건드리면 신호에서 뺀다.
 * 릴리즈 커밋이나 일괄 포맷팅이 모든 파일을 서로 연결해버리는 걸 막는다.
 */
export const MAX_FILES_PER_COMMIT = 20;
/** 파일이 하나뿐인 커밋은 페어를 만들 수 없다 */
export const MIN_FILES_PER_COMMIT = 2;
/** 동시 등장이 이 미만인 페어는 우연으로 본다 */
export const MIN_PAIR_COUNT = 3;
export const DEFAULT_MIN_CONFIDENCE = 0.3;
export const DEFAULT_NEIGHBOR_LIMIT = 30;
export const DEFAULT_PAIR_LIMIT = 50;

const SHA_RE = /^[0-9a-f]{40}$/;

export type GitRunner = (root: string, args: string[]) => string;

export interface CommitRecord {
  sha: string;
  files: string[];
}

export interface PairCounts {
  /** 키는 `${a}\t${b}`이고 a < b로 정규화돼 있다 */
  pairs: Map<string, number>;
  solos: Map<string, number>;
  commitsUsed: number;
  commitsScanned: number;
}

/**
 * maxBuffer를 반드시 명시한다. 기본 1MB를 넘으면 ENOBUFS로 출력이 잘린 채
 * 예외가 나는데, 그걸 삼키면 부분 수집이 성공으로 둔갑한다.
 */
function defaultRunGit(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.fsmonitor=', '-c', 'core.quotepath=false', ...args], {
    cwd: root,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\t${b}` : `${b}\t${a}`;
}

/** `git log --format=%H --name-only --no-merges` 출력을 커밋 단위로 쪼갠다 */
export function parseGitLog(raw: string): CommitRecord[] {
  const commits: CommitRecord[] = [];
  let current: CommitRecord | null = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (SHA_RE.test(trimmed)) {
      current = { sha: trimmed, files: [] };
      commits.push(current);
      continue;
    }
    if (current) current.files.push(trimmed);
  }

  return commits;
}

export function countPairs(commits: CommitRecord[]): PairCounts {
  const pairs = new Map<string, number>();
  const solos = new Map<string, number>();
  let commitsUsed = 0;

  for (const commit of commits) {
    const uniq = [...new Set(commit.files)];
    if (uniq.length < MIN_FILES_PER_COMMIT || uniq.length > MAX_FILES_PER_COMMIT) continue;
    commitsUsed++;

    for (const file of uniq) {
      solos.set(file, (solos.get(file) ?? 0) + 1);
    }
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const key = pairKey(uniq[i]!, uniq[j]!);
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }

  return { pairs, solos, commitsUsed, commitsScanned: commits.length };
}

/** 보고 정밀도. 원시 카운트만 저장하므로 언제든 다시 계산할 수 있다 */
export const CONFIDENCE_DECIMALS = 2;
export const LIFT_DECIMALS = 1;

function round(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

/**
 * confidence는 방향별로 다르므로 큰 쪽을 쓴다.
 * lift 분모는 이긴 방향의 상대 파일이 전체 커밋에서 등장하는 비율이다 —
 * 어디에나 끼는 파일일수록 분모가 커져 점수가 눌린다.
 *
 * 반환 직전에 반올림한다. 이 함수가 두 소비 경로(cochange 응답과 blast-radius
 * rankedFiles)가 만나는 유일한 지점이라 여기서 자르면 양쪽이 같은 값을 본다.
 * 랭킹도 보고된 값 그대로 매겨져 "같아 보이는데 순서가 다른" 자리가 없어진다.
 */
export function scoreNeighbor(
  pairCount: number,
  soloSelf: number,
  soloOther: number,
  commitsUsed: number,
): { confidence: number; lift: number } {
  const confSelf = soloSelf > 0 ? pairCount / soloSelf : 0;
  const confOther = soloOther > 0 ? pairCount / soloOther : 0;
  const confidence = Math.max(confSelf, confOther);

  const counterpartSolo = confSelf >= confOther ? soloOther : soloSelf;
  const expected = commitsUsed > 0 ? counterpartSolo / commitsUsed : 0;
  const lift = expected > 0 ? confidence / expected : 0;

  return {
    confidence: round(confidence, CONFIDENCE_DECIMALS),
    lift: round(lift, LIFT_DECIMALS),
  };
}

/** 랭킹 키. 프로토타입이 검증한 정렬이다 */
export function neighborScore(n: { confidence: number; lift: number }): number {
  return n.confidence * n.lift;
}

/**
 * 점수와 동시등장 다음에 경로를 마지막 열쇠로 둔다. 앞의 둘이 같은 행은 흔한데
 * (카운트가 같으면 점수도 같기 쉽다) 거기서 멈추면 순서가 DB가 돌려준 행
 * 순서에 걸린다. 질의에 `ORDER BY`가 없으므로 그건 보장이 없다.
 */
export function compareNeighbors(
  a: { confidence: number; lift: number; pairCount: number; filePath: string },
  b: { confidence: number; lift: number; pairCount: number; filePath: string },
): number {
  return (
    neighborScore(b) - neighborScore(a) ||
    b.pairCount - a.pairCount ||
    a.filePath.localeCompare(b.filePath)
  );
}

// ─── 수집 ────────────────────────────────────────────────────────

export interface CoChangeSyncOptions {
  mode?: BuildMode;
  runGit?: GitRunner;
}

function isAncestor(
  runGit: GitRunner,
  root: string,
  ancestor: string,
  descendant: string,
): boolean {
  try {
    runGit(root, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * git 이력에서 co-change 카운트를 수집해 DB에 병합한다.
 *
 * repoRoot가 레포 최상위가 아니면 아무것도 하지 않는다. 하위 디렉토리를
 * repoRoot로 넘기면 `git log`가 부모 레포의 전체 이력을 돌려주기 때문이다 —
 * 테스트가 `.gestalt-test/<uuid>`를 repoRoot로 쓰는 자리가 정확히 그 경우다.
 *
 * 수집 불가는 예외가 아니라 undefined로 알린다. 호출부는 그래프 빌드를
 * 계속해야 한다. 0건과 미수집도 구분돼야 한다.
 */
export function syncCoChange(
  store: CodeGraphStore,
  repoRoot: string,
  opts: CoChangeSyncOptions = {},
): CoChangeBuildSummary | undefined {
  const root = resolve(repoRoot);
  const runGit = opts.runGit ?? defaultRunGit;
  const mode = opts.mode ?? 'full';

  let toplevel: string;
  try {
    toplevel = runGit(root, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return undefined;
  }
  if (toplevel.length === 0 || resolve(toplevel) !== root) {
    logger.warn('code_graph.cochange_skipped_not_repo_root', {
      module: 'code-graph/cochange',
      repoRoot: root,
      toplevel,
    });
    return undefined;
  }

  let headSha: string;
  try {
    headSha = runGit(root, ['rev-parse', 'HEAD']).trim();
  } catch {
    return undefined;
  }
  if (!SHA_RE.test(headSha)) return undefined;

  const meta = store.getCoChangeMeta();
  let range: string | null = null;

  if (mode === 'incremental' && meta && SHA_RE.test(meta.headSha)) {
    if (meta.headSha === headSha) {
      return {
        pairs: store.countCoChangePairs(),
        commitsUsed: meta.commitsUsed,
        commitsScanned: meta.commitsScanned,
        mode: 'incremental',
      };
    }
    if (isAncestor(runGit, root, meta.headSha, headSha)) {
      range = `${meta.headSha}..HEAD`;
    } else {
      // rebase나 amend, shallow clone이면 이전 기준점에 도달할 수 없다.
      // 조용히 넘어가면 카운트가 영영 어긋난 채 남으므로 전량 재수집으로 내린다.
      logger.warn('code_graph.cochange_full_rescan', {
        module: 'code-graph/cochange',
        repoRoot: root,
        reason: 'previous head is unreachable from HEAD',
        previousHead: meta.headSha,
      });
    }
  }

  const args = ['log', '--format=%H', '--name-only', '--no-merges'];
  if (range) args.push(range);

  let raw: string;
  try {
    raw = runGit(root, args);
  } catch (e) {
    logger.warn('code_graph.cochange_log_failed', {
      module: 'code-graph/cochange',
      repoRoot: root,
      reason: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }

  const counts = countPairs(parseGitLog(raw));

  // git은 repo 상대경로를 내고 cg_nodes는 절대경로를 쓴다. 경계에서 한 번에
  // 절대화하지 않으면 조인이 조용히 0건이 된다.
  const pairs = [...counts.pairs.entries()].map(([key, count]) => {
    const tab = key.indexOf('\t');
    const a = resolve(root, key.slice(0, tab));
    const b = resolve(root, key.slice(tab + 1));
    return a < b ? { fileA: a, fileB: b, count } : { fileA: b, fileB: a, count };
  });
  const solos = [...counts.solos.entries()].map(([rel, count]) => ({
    filePath: resolve(root, rel),
    count,
  }));

  store.mergeCoChange({
    pairs,
    solos,
    meta: {
      headSha,
      commitsUsed: counts.commitsUsed,
      commitsScanned: counts.commitsScanned,
      maxFilesPerCommit: MAX_FILES_PER_COMMIT,
      defaultMinPairCount: MIN_PAIR_COUNT,
    },
    reset: range === null,
  });

  const merged = store.getCoChangeMeta();
  return {
    pairs: store.countCoChangePairs(),
    commitsUsed: merged?.commitsUsed ?? counts.commitsUsed,
    commitsScanned: merged?.commitsScanned ?? counts.commitsScanned,
    mode: range ? 'incremental' : 'full',
  };
}

// ─── 조회 ────────────────────────────────────────────────────────

export interface CoChangeQueryOptions extends CoChangeTuning {
  target?: string;
  /** 워킹트리 존재 확인. 테스트에서 주입한다 */
  exists?: (filePath: string) => boolean;
}

function absolutize(root: string, filePath: string): string {
  return filePath.startsWith('/') ? resolve(filePath) : resolve(root, filePath);
}

const NOT_COLLECTED =
  'co-change history has not been collected for this repository — run a code graph build at the repo root';

/**
 * 임계를 통과한 이웃을 전부 점수순으로 세운다. 개수를 여기서 자르지 않는
 * 게 요점이다 — 자른 뒤 다시 세우면 무엇이 잘렸는지 셀 수 없다. 목록이
 * 전체 상위의 접두사라는 말도 못 한다.
 */
function neighborsFor(
  store: CodeGraphStore,
  absTarget: string,
  commitsUsed: number,
  minPairCount: number,
  minConfidence: number,
  exists: (filePath: string) => boolean,
): CoChangeNeighbor[] {
  const soloSelf = store.getCoChangeSolo(absTarget);
  const out: CoChangeNeighbor[] = [];

  // 두 임계는 질의가 건다. 여기서 한 번 더 거르면 같은 규칙이 두 곳에 살아
  // 어긋날 자리가 생긴다.
  const rows = store.getCoChangeNeighbors(absTarget, minPairCount, minConfidence, soloSelf);
  for (const row of rows) {
    // 삭제되거나 이름이 바뀐 파일은 이력에만 남는다. 수집이 아니라 조회에서
    // 거른다 — 수집에서 빼면 그 시절 solo 카운트가 깎여 confidence가 부푼다.
    if (!exists(row.other)) continue;
    const { confidence, lift } = scoreNeighbor(row.pairCount, soloSelf, row.soloOther, commitsUsed);
    out.push({ filePath: row.other, pairCount: row.pairCount, confidence, lift });
  }

  out.sort(compareNeighbors);
  return out;
}

/**
 * 같은 파일이 여러 seed의 이웃으로 거듭 나온다. 감싸지 않으면 그때마다
 * 동기 stat이 한 번씩 더 돈다.
 */
function memoizeExists(exists: (filePath: string) => boolean): (filePath: string) => boolean {
  const cache = new Map<string, boolean>();
  return (filePath) => {
    const hit = cache.get(filePath);
    if (hit !== undefined) return hit;
    const value = exists(filePath);
    cache.set(filePath, value);
    return value;
  };
}

export function queryCoChange(
  store: CodeGraphStore,
  repoRoot: string,
  opts: CoChangeQueryOptions = {},
): CoChangeResult {
  const root = resolve(repoRoot);
  const exists = memoizeExists(opts.exists ?? existsSync);
  const minPairCount = opts.minPairCount ?? MIN_PAIR_COUNT;
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  const meta = store.getCoChangeMeta();
  const pairsInDb = store.countCoChangePairs();

  if (!meta) {
    return {
      target: opts.target,
      neighbors: [],
      pairs: [],
      commitsUsed: 0,
      commitsScanned: 0,
      pairsInDb,
      totalMatched: 0,
      truncated: false,
      available: false,
      reason: NOT_COLLECTED,
    };
  }

  if (opts.target) {
    const absTarget = absolutize(root, opts.target);
    const neighborLimit = opts.limit ?? DEFAULT_NEIGHBOR_LIMIT;
    const matched = neighborsFor(
      store,
      absTarget,
      meta.commitsUsed,
      minPairCount,
      minConfidence,
      exists,
    );
    const neighbors = matched.slice(0, neighborLimit);

    let reason: string | undefined;
    if (neighbors.length === 0 && pairsInDb > 0) {
      // 이력은 있는데 이 파일만 안 걸린 것과 경로 표기가 어긋난 것은 다르다.
      // 둘 다 여기로 오므로 진단 단서를 남긴다.
      reason =
        `no co-change neighbors for ${absTarget} (${pairsInDb} pair(s) in db). ` +
        `The file may have no shared history, or the path may not match the stored absolute paths.`;
      logger.warn('code_graph.cochange_no_neighbors', {
        module: 'code-graph/cochange',
        repoRoot: root,
        target: absTarget,
        pairsInDb,
      });
    }

    return {
      target: absTarget,
      neighbors,
      pairs: [],
      commitsUsed: meta.commitsUsed,
      commitsScanned: meta.commitsScanned,
      pairsInDb,
      totalMatched: matched.length,
      truncated: matched.length > neighbors.length,
      available: true,
      reason,
    };
  }

  const limit = opts.limit ?? DEFAULT_PAIR_LIMIT;
  const scored: CoChangePair[] = [];
  const rows = store.getCoChangePairs(minPairCount, minConfidence);
  for (const row of rows) {
    if (!exists(row.fileA) || !exists(row.fileB)) continue;
    const { confidence, lift } = scoreNeighbor(
      row.pairCount,
      row.soloA,
      row.soloB,
      meta.commitsUsed,
    );
    scored.push({
      fileA: row.fileA,
      fileB: row.fileB,
      pairCount: row.pairCount,
      confidence,
      lift,
    });
  }
  scored.sort((a, b) =>
    compareNeighbors(
      { ...a, filePath: `${a.fileA}\t${a.fileB}` },
      { ...b, filePath: `${b.fileA}\t${b.fileB}` },
    ),
  );

  const pairs = scored.slice(0, limit);

  return {
    neighbors: [],
    pairs,
    commitsUsed: meta.commitsUsed,
    commitsScanned: meta.commitsScanned,
    pairsInDb,
    totalMatched: scored.length,
    truncated: scored.length > pairs.length,
    available: true,
    reason:
      scored.length === 0 && pairsInDb > 0
        ? `no pair passed the thresholds (minPairCount=${minPairCount}, minConfidence=${minConfidence}) out of ${pairsInDb} pair(s) in db`
        : undefined,
  };
}

/**
 * 여러 seed 파일의 이웃을 하나로 합친다. blast-radius가 쓰는 진입점이다.
 * 같은 파일이 여러 seed에 걸리면 점수가 높은 쪽을 남긴다. 합친 목록은
 * `opts.limit`(기본 `DEFAULT_NEIGHBOR_LIMIT`)까지만 돌려준다. 잘렸으면
 * `truncated`로 알린다 — 목록만 보면 그게 전부인 줄 안다.
 *
 * 자르는 자리가 여기 하나뿐이라 돌려준 목록은 임계를 통과한 전체의 상위
 * 접두사다. `totalMatched`도 하한이 아니라 정확한 수다.
 */
export function buildCoChangeLookup(
  store: CodeGraphStore,
  repoRoot: string,
  seeds: string[],
  opts: CoChangeQueryOptions = {},
): CoChangeLookup {
  const root = resolve(repoRoot);
  // seed 하나가 아니라 seed 전부에 걸쳐 메모이즈한다. 같은 파일이 여러 seed의
  // 이웃으로 거듭 나오는 게 흔한 경우라 seed 안에서만 캐시하면 거의 못 줄인다.
  const exists = memoizeExists(opts.exists ?? existsSync);
  const minPairCount = opts.minPairCount ?? MIN_PAIR_COUNT;
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const limit = opts.limit ?? DEFAULT_NEIGHBOR_LIMIT;

  const meta = store.getCoChangeMeta();
  const pairsInDb = store.countCoChangePairs();

  if (!meta) {
    return {
      available: false,
      reason: NOT_COLLECTED,
      pairsInDb,
      neighbors: [],
      totalMatched: 0,
      truncated: false,
    };
  }

  const seedSet = new Set(seeds.map((s) => absolutize(root, s)));
  const best = new Map<string, CoChangeNeighbor>();

  for (const seed of seedSet) {
    for (const n of neighborsFor(
      store,
      seed,
      meta.commitsUsed,
      minPairCount,
      minConfidence,
      exists,
    )) {
      if (seedSet.has(n.filePath)) continue;
      const prev = best.get(n.filePath);
      if (!prev || neighborScore(n) > neighborScore(prev)) best.set(n.filePath, n);
    }
  }

  // seed마다 임계를 통과한 이웃이 전부 들어오므로 여기서 자르지 않으면
  // seed 개수만큼 부풀어 rankedFiles가 import 신호를 밀어낸다.
  const ranked = [...best.values()].sort(compareNeighbors);
  const neighbors = ranked.slice(0, limit);

  let reason: string | undefined;
  if (neighbors.length === 0 && pairsInDb > 0) {
    reason =
      `no co-change neighbors for the ${seedSet.size} seed file(s) (${pairsInDb} pair(s) in db). ` +
      `Either they share no history, or their paths do not match the stored absolute paths.`;
    logger.warn('code_graph.cochange_no_neighbors', {
      module: 'code-graph/cochange',
      repoRoot: root,
      seeds: seedSet.size,
      pairsInDb,
    });
  }

  return {
    available: true,
    reason,
    pairsInDb,
    neighbors,
    totalMatched: ranked.length,
    truncated: ranked.length > neighbors.length,
  };
}
