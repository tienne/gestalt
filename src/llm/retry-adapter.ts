import { LLMError } from '../core/errors.js';
import type { LLMAdapter, LLMRequest, LLMResponse } from './types.js';

const RETRIABLE_KEYWORDS = [
  '429',
  'rate limit',
  '503',
  '502',
  '500',
  'timeout',
  'ECONNRESET',
  'ETIMEDOUT',
];

function isRetriable(err: unknown): boolean {
  if (!(err instanceof LLMError)) return false;
  const msg = err.message.toLowerCase();
  return RETRIABLE_KEYWORDS.some((k) => msg.includes(k.toLowerCase()));
}

export class RetryingAdapter implements LLMAdapter {
  constructor(
    private readonly inner: LLMAdapter,
    private readonly maxAttempts = 3,
    private readonly baseDelayMs = 1000,
  ) {}

  async chat(request: LLMRequest): Promise<LLMResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        return await this.inner.chat(request);
      } catch (e) {
        lastError = e;
        if (!isRetriable(e) || attempt === this.maxAttempts - 1) throw e;
        await new Promise((r) => setTimeout(r, this.baseDelayMs * Math.pow(2, attempt)));
      }
    }
    throw lastError;
  }
}
