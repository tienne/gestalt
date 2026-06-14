import { pipeline, FeatureExtractionPipeline, Tensor } from '@xenova/transformers';
import type { EmbeddingProvider } from '../embedding-provider.js';

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly type = 'local' as const;
  readonly modelId = 'Xenova/all-MiniLM-L6-v2';
  readonly dimensions = 384;

  private extractor: FeatureExtractionPipeline | null = null;

  private async getExtractor(): Promise<FeatureExtractionPipeline> {
    if (!this.extractor) {
      this.extractor = await pipeline('feature-extraction', this.modelId);
    }
    return this.extractor;
  }

  async embed(texts: string[], batchSize = 32): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getExtractor();
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const chunk = texts.slice(i, i + batchSize);
      const output = (await extractor(chunk, { pooling: 'mean', normalize: true })) as Tensor;
      const flat = output.data as Float32Array;
      const dim = flat.length / chunk.length;
      for (let j = 0; j < chunk.length; j++) {
        results.push(Array.from(flat.slice(j * dim, (j + 1) * dim)));
      }
    }
    return results;
  }
}
