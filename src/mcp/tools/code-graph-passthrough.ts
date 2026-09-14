import { log } from '../../core/log.js';
import { codeGraphEngine } from '../../code-graph/index.js';
import type { CoChangeTuning, QueryPattern } from '../../code-graph/index.js';

export type CodeGraphInput = {
  action: 'build' | 'blast_radius' | 'diff_radius' | 'query' | 'stats' | 'db_exists' | 'co_change';
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
};

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
        const result = codeGraphEngine.blastRadius(repoRoot, {
          changedFiles: input.changedFiles,
          base: input.base,
          maxDepth: input.maxDepth,
          coChange: coChangeTuning(input),
        });
        return result;
      }

      case 'diff_radius': {
        const result = codeGraphEngine.diffRadius(repoRoot, {
          mode: input.diffMode,
          maxDepth: input.maxDepth,
          coChange: coChangeTuning(input),
        });
        return result;
      }

      case 'query': {
        if (!input.pattern) {
          return { error: 'pattern is required for query action' };
        }
        if (!input.target) {
          return { error: 'target is required for query action' };
        }
        const result = codeGraphEngine.query(repoRoot, input.pattern, input.target);
        return { nodes: result.nodes, edges: result.edges };
      }

      case 'stats': {
        const result = codeGraphEngine.stats(repoRoot);
        return result;
      }

      case 'co_change': {
        const result = codeGraphEngine.coChange(repoRoot, {
          target: input.target,
          limit: input.limit,
          minPairCount: input.minPairCount,
          minConfidence: input.minConfidence,
        });
        return result;
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
