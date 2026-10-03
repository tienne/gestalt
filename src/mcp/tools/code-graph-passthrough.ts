import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../../core/log.js';
import { codeGraphEngine, MAX_INLINE_PARSE } from '../../code-graph/index.js';
import type { CoChangeTuning, FreshnessReport, QueryPattern } from '../../code-graph/index.js';
import {
  detachedRefreshSpawner,
  requestRefresh,
  type RefreshSpawner,
} from '../../code-graph/hooks/background.js';

export type CodeGraphInput = {
  action:
    | 'build'
    | 'blast_radius'
    | 'diff_radius'
    | 'query'
    | 'stats'
    | 'db_exists'
    | 'co_change'
    | 'skeleton';
  repoRoot: string;
  // build 전용
  include?: string[];
  exclude?: string[];
  mode?: 'full' | 'incremental';
  // blast_radius 전용
  changedFiles?: string[];
  base?: string;
  maxDepth?: number;
  // diff_radius 전용
  diffMode?: 'staged' | 'unstaged' | 'all';
  // query 전용 (target은 co_change와 공유한다)
  pattern?: QueryPattern;
  target?: string;
  // 이력 신호 임계. co_change, blast_radius, diff_radius가 함께 쓴다
  limit?: number;
  minPairCount?: number;
  minConfidence?: number;
  // skeleton 전용
  filePath?: string;
  // 질의 액션 공통. false면 질의 전 최신화를 건너뛴다
  refresh?: boolean;
};

/** 같은 레포에 재색인 프로세스를 연달아 띄우지 않는 간격. 띄운 쪽이 락을 잡기 전 틈을 메운다 */
const REINDEX_REQUEST_INTERVAL_MS = 30_000;

/**
 * 재색인을 맡길 프로세스. 훅이 백그라운드 갱신에 쓰는 엔트리를 `reindex`로 띄운다.
 * dist에서는 dist/bin/gestalt-hook.js, tsx로 띄운 개발 서버에서는 bin/gestalt-hook.ts다.
 */
function defaultReindexSpawner(): RefreshSpawner | undefined {
  const self = fileURLToPath(import.meta.url);
  const entry = fileURLToPath(
    new URL(`../../../bin/gestalt-hook${extname(self)}`, import.meta.url),
  );
  if (!existsSync(entry)) return undefined;
  return detachedRefreshSpawner(entry, 'reindex', process.execArgv);
}

let reindexSpawner: RefreshSpawner | undefined | null = null;

/** 테스트가 재색인 프로세스 대신 끼워 넣는 자리. undefined를 주면 기본으로 돌아간다 */
export function setReindexSpawner(spawner: RefreshSpawner | undefined): void {
  reindexSpawner = spawner ?? null;
}

/**
 * 질의 전에 그래프를 디스크에 맞춘다. 입력 refresh:false나 GESTALT_NO_REFRESH=1이면 끈다.
 * 실패해도 질의는 막지 않는다. 이전 그래프로라도 답하는 게 아예 못 답하는 것보다 낫다.
 *
 * 다시 파싱할 파일이 MAX_INLINE_PARSE를 넘으면(업그레이드 직후 옛 DB, 큰 브랜치 전환)
 * 이전 그래프로 바로 답하고 재색인은 다른 프로세스에 넘긴다. 큰 레포에서는 콜드 빌드만큼
 * 걸려서 그 자리에서 돌리면 질의가 그만큼 멈춘다.
 */
async function refreshBeforeQuery(input: CodeGraphInput): Promise<FreshnessReport> {
  if (input.refresh === false || process.env['GESTALT_NO_REFRESH'] === '1') {
    return { status: 'skipped', reason: 'disabled', durationMs: 0 };
  }
  try {
    const freshness = await codeGraphEngine.refresh(input.repoRoot, {
      maxInlineParse: MAX_INLINE_PARSE,
    });
    if (freshness.status === 'stale' && freshness.reason === 'reindex_pending') {
      requestReindex(input.repoRoot);
    }
    return freshness;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log('code-graph refresh failed:', message);
    return {
      status: 'stale',
      reason: 'refresh_failed',
      message: `최신화 실패로 이전 그래프 기준 (${message})`,
      durationMs: 0,
    };
  }
}

function requestReindex(repoRoot: string): void {
  try {
    if (reindexSpawner === null) reindexSpawner = defaultReindexSpawner();
    if (!reindexSpawner) {
      log('code-graph reindex skipped: gestalt-hook entry not found');
      return;
    }
    requestRefresh(repoRoot, reindexSpawner, REINDEX_REQUEST_INTERVAL_MS);
  } catch (e) {
    log('code-graph reindex request failed:', e instanceof Error ? e.message : String(e));
  }
}

/**
 * 임계 파라미터는 co_change 액션만의 것이 아니다. blast_radius와 diff_radius도
 * 같은 신호를 쓰므로 여기서 갈라놓으면 튜닝이 조회에만 먹는다.
 */
function coChangeTuning(input: CodeGraphInput): CoChangeTuning {
  return {
    limit: input.limit,
    minPairCount: input.minPairCount,
    minConfidence: input.minConfidence,
  };
}

export async function handleCodeGraphPassthrough(input: CodeGraphInput): Promise<object> {
  const { action, repoRoot } = input;

  log(`code-graph action: ${action}, repoRoot: ${repoRoot}`);

  try {
    switch (action) {
      case 'build': {
        const result = codeGraphEngine.build(repoRoot, {
          include: input.include,
          exclude: input.exclude,
          mode: input.mode,
        });
        // Generate embeddings after graph build (graceful — non-fatal on failure)
        let embeddingsBuilt = 0;
        try {
          const embResult = await codeGraphEngine.buildEmbeddings(repoRoot, {
            mode: input.mode,
          });
          embeddingsBuilt = embResult.embeddingsBuilt;
        } catch {
          // embedding generation is best-effort
        }
        return {
          nodesBuilt: result.nodesBuilt,
          edgesBuilt: result.edgesBuilt,
          timeTakenMs: result.timeTakenMs,
          installedHook: false,
          embeddingsBuilt,
          // 건너뛴 파일은 그래프에 없어서 이후 blast-radius가 영영 누락한다.
          // 개수는 늘 싣고 목록은 진단용으로 앞 20개만 — 전량은 응답만 키운다.
          skippedCount: result.skippedFiles.length,
          skippedFiles: result.skippedFiles.slice(0, 20),
          // undefined면 수집을 건너뛴 것이다 (git 레포가 아니거나 repoRoot가
          // 레포 최상위가 아님). 0과 구분돼야 한다.
          coChange: result.coChange,
        };
      }

      case 'blast_radius': {
        const freshness = await refreshBeforeQuery(input);
        const result = codeGraphEngine.blastRadius(repoRoot, {
          changedFiles: input.changedFiles,
          base: input.base,
          maxDepth: input.maxDepth,
          coChange: coChangeTuning(input),
        });
        return { ...result, freshness };
      }

      case 'diff_radius': {
        const freshness = await refreshBeforeQuery(input);
        const result = codeGraphEngine.diffRadius(repoRoot, {
          mode: input.diffMode,
          maxDepth: input.maxDepth,
          coChange: coChangeTuning(input),
        });
        return { ...result, freshness };
      }

      case 'query': {
        if (!input.pattern) {
          return { error: 'pattern is required for query action' };
        }
        if (!input.target) {
          return { error: 'target is required for query action' };
        }
        const freshness = await refreshBeforeQuery(input);
        const result = codeGraphEngine.query(repoRoot, input.pattern, input.target);
        return { nodes: result.nodes, edges: result.edges, freshness };
      }

      case 'stats': {
        const freshness = await refreshBeforeQuery(input);
        const result = codeGraphEngine.stats(repoRoot);
        return { ...result, freshness };
      }

      case 'co_change': {
        const freshness = await refreshBeforeQuery(input);
        const result = codeGraphEngine.coChange(repoRoot, {
          target: input.target,
          ...coChangeTuning(input),
        });
        return { ...result, freshness };
      }

      case 'skeleton': {
        if (!input.filePath) {
          return { error: 'filePath is required for skeleton action' };
        }
        const freshness = await refreshBeforeQuery(input);
        const result = codeGraphEngine.skeleton(repoRoot, input.filePath);
        // 서버가 text를 그대로 응답 본문으로 쓴다. 첫 줄이 줄인 크기여야 해서다
        const stale = freshness.status === 'stale' ? `\n(${freshness.message})` : '';
        return {
          text: result.text.replace('\n', `${stale}\n`),
          source: result.source,
          originalChars: result.originalChars,
          skeletonChars: result.skeletonChars,
          freshness,
        };
      }

      case 'db_exists': {
        const exists = codeGraphEngine.dbExists(repoRoot);
        return { exists };
      }

      default: {
        return { error: `Unknown action: ${action}` };
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`code-graph error [${action}]:`, message);
    return { error: message };
  }
}
