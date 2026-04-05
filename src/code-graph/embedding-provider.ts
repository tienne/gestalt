// ─── Embedding Provider Interface ────────────────────────────────

export type EmbeddingProviderType = 'local' | 'anthropic' | 'openai' | 'gemini';

export interface EmbeddingProvider {
  readonly type: EmbeddingProviderType;
  readonly modelId: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

// ─── CodeNode Embedding ───────────────────────────────────────────

export interface CodeNodeEmbedding {
  nodeId: string;
  filePath: string;
  embedding: Buffer;    // float32 LE bytes
  modelId: string;
  createdAt: number;    // Unix timestamp ms
}
