import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import matter from 'gray-matter';
import { EmbeddingService } from './embedding.js';
import { loadEmbeddingIndex } from './embedding-index.js';
import { log } from '../core/log.js';
import type { KnowledgeEntry, SearchResult } from './types.js';

export class SemanticSearchEngine {
  private embeddingService: EmbeddingService;

  constructor() {
    this.embeddingService = new EmbeddingService();
  }

  async search(
    query: string,
    kbPath: string,
    options?: { k?: number; types?: string[] },
  ): Promise<SearchResult[]> {
    const k = options?.k ?? 5;
    const types = options?.types;

    log(`search: loading embedding index from ${kbPath}`);
    const index = await loadEmbeddingIndex(kbPath);
    if (!index || index.entries.length === 0) {
      log('search: no embedding index found, returning empty results');
      return [];
    }

    log(`search: computing query embedding for "${query}"`);
    const queryVector = await this.embeddingService.embed(query);

    // 각 EmbeddingEntry에 대해 코사인 유사도 계산
    const scored: Array<{ entryId: string; filePath: string; score: number }> = [];
    for (const embEntry of index.entries) {
      // types 필터: filePath에서 타입 디렉토리 추출
      if (types && types.length > 0) {
        // .gestalt-kb/{type}/{id}.md 패턴에서 type 추출
        const parts = embEntry.filePath.replace(/\\/g, '/').split('/');
        // parts 예: ['.gestalt-kb', 'code-graph', 'uuid.md'] 또는 절대경로
        // kbPath 기준 상대 경로를 구성해서 두 번째 세그먼트를 type으로 간주
        const rel = embEntry.filePath.startsWith(kbPath)
          ? embEntry.filePath.slice(kbPath.length).replace(/^[/\\]/, '')
          : parts.slice(-2).join('/');
        const typeSegment = rel.split('/')[0] ?? '';
        if (!types.includes(typeSegment)) {
          continue;
        }
      }

      const score = this.cosineSimilarity(queryVector, embEntry.vector);
      scored.push({ entryId: embEntry.entryId, filePath: embEntry.filePath, score });
    }

    // 내림차순 정렬 후 상위 k개 선택
    scored.sort((a, b) => b.score - a.score);
    const topK = scored.slice(0, k);

    log(`search: top ${topK.length} results (from ${scored.length} candidates)`);

    // KnowledgeEntry 로드 및 SearchResult 조합
    const results: SearchResult[] = [];
    for (let i = 0; i < topK.length; i++) {
      const item = topK[i]!;
      // filePath가 절대경로면 그대로, 상대경로면 kbPath 기준으로 resolve
      const resolvedPath = path.isAbsolute(item.filePath)
        ? item.filePath
        : path.join(kbPath, item.filePath.replace(/^\.gestalt-kb[/\\]/, ''));

      const entry = await this.loadEntry(resolvedPath);
      if (!entry) continue;

      results.push({
        entry,
        score: item.score,
        excerpt: entry.content.slice(0, 200),
        rank: i + 1,
      });
    }

    return results;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      const ai = a[i]!;
      const bi = b[i]!;
      dot += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    return dot / denom;
  }

  private async loadEntry(filePath: string): Promise<KnowledgeEntry | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = matter(raw);
      const data = parsed.data as Record<string, unknown>;

      return {
        id: String(data['id'] ?? ''),
        type: (data['type'] as KnowledgeEntry['type']) ?? 'code-graph',
        title: String(data['title'] ?? ''),
        content: parsed.content,
        filePath: String(data['filePath'] ?? filePath),
        createdAt: String(data['createdAt'] ?? new Date().toISOString()),
        tags: Array.isArray(data['tags']) ? (data['tags'] as string[]) : [],
      };
    } catch (err) {
      log(`search: failed to load entry at ${filePath}: ${String(err)}`);
      return null;
    }
  }
}
