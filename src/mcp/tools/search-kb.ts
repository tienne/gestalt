import * as path from 'node:path';
import { SemanticSearchEngine } from '../../knowledge-base/search.js';
import { log } from '../../core/log.js';
import type { KnowledgeEntryType } from '../../knowledge-base/types.js';

export interface SearchKbInput {
  query: string;
  k?: number;
  kbPath?: string;
  types?: KnowledgeEntryType[];
}

export async function handleSearchKb(input: SearchKbInput, cwd: string): Promise<string> {
  const kbPath = input.kbPath ?? path.join(cwd, '.gestalt-kb');
  const k = input.k ?? 5;

  log(`search-kb: query="${input.query}", kbPath=${kbPath}, k=${k}`);

  try {
    const engine = new SemanticSearchEngine();
    const results = await engine.search(input.query, kbPath, {
      k,
      types: input.types,
    });

    return JSON.stringify(
      {
        results,
        query: input.query,
        total: results.length,
      },
      null,
      2,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`search-kb error: ${message}`);
    return JSON.stringify({ error: message }, null, 2);
  }
}
