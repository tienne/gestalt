import { LLMError } from '../core/errors.js';
import type { LLMAdapter, LLMRequest, LLMResponse } from './types.js';

export class FallbackAdapter implements LLMAdapter {
  constructor(private readonly adapters: LLMAdapter[]) {
    if (adapters.length === 0) {
      throw new LLMError('FallbackAdapter: no adapters available');
    }
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    let lastError: unknown;
    for (const adapter of this.adapters) {
      try {
        return await adapter.chat(request);
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError ?? new LLMError('FallbackAdapter: no adapters available');
  }
}
