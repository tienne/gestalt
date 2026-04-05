import { log } from '../../core/log.js';
import { codeGraphEngine } from '../../code-graph/index.js';
import type { QueryPattern } from '../../code-graph/index.js';

export type CodeGraphInput = {
  action: 'build' | 'blast_radius' | 'diff_radius' | 'query' | 'stats' | 'db_exists';
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
  // query 전용
  pattern?: QueryPattern;
  target?: string;
};

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
        };
      }

      case 'blast_radius': {
        const result = codeGraphEngine.blastRadius(repoRoot, {
          changedFiles: input.changedFiles,
          base: input.base,
          maxDepth: input.maxDepth,
        });
        return result;
      }

      case 'diff_radius': {
        const result = codeGraphEngine.diffRadius(repoRoot, {
          mode: input.diffMode,
          maxDepth: input.maxDepth,
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
