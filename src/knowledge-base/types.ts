export type KnowledgeEntryType = 'code-graph' | 'business-logic' | 'api-spec' | 'adr' | 'policy';

export interface KnowledgeEntry {
  id: string;
  type: KnowledgeEntryType;
  title: string;
  content: string;
  filePath: string; // .gestalt-kb/{type}/{id}.md 경로
  createdAt: string; // ISO 8601
  tags: string[];
}

export interface EmbeddingEntry {
  entryId: string;
  filePath: string;
  vector: number[]; // Float32Array → number[] (JSON 호환)
  createdAt: string;
}

export interface EmbeddingIndex {
  model: string;
  dimension: number;
  entries: EmbeddingEntry[];
  createdAt: string;
}

export interface SearchResult {
  entry: KnowledgeEntry;
  score: number;
  excerpt: string;
  rank: number;
}
