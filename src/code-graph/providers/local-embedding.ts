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

  async embed(texts: string[]): Promise<number[][]> {
    const extractor = await this.getExtractor();
    const results: number[][] = [];
    for (const text of texts) {
      const output = (await extractor(text, { pooling: 'mean', normalize: true })) as Tensor;
      // output.data is Float32Array or similar DataArray
      results.push(Array.from(output.data as Float32Array));
    }
    return results;
  }
}
