import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RetryingAdapter } from '../../../src/llm/retry-adapter.js';
import { LLMError } from '../../../src/core/errors.js';
import type { LLMAdapter, LLMRequest, LLMResponse } from '../../../src/llm/types.js';

const req: LLMRequest = {
  system: 'test',
  messages: [{ role: 'user', content: 'hello' }],
};

const res: LLMResponse = {
  content: 'ok',
  usage: { inputTokens: 10, outputTokens: 5 },
};

function makeAdapter(impl: () => Promise<LLMResponse>): LLMAdapter {
  return { chat: vi.fn().mockImplementation(impl) };
}

function throwLLMError(msg: string): () => Promise<LLMResponse> {
  return async () => {
    throw new LLMError(msg);
  };
}

describe('RetryingAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('성공 시 inner adapter 결과를 그대로 반환', async () => {
    const inner = makeAdapter(() => Promise.resolve(res));
    const adapter = new RetryingAdapter(inner);
    await expect(adapter.chat(req)).resolves.toEqual(res);
    expect(inner.chat).toHaveBeenCalledTimes(1);
  });

  it('retriable 에러(rate limit) → 재시도 후 성공', async () => {
    let calls = 0;
    const inner = makeAdapter(async () => {
      calls++;
      if (calls < 3) throw new LLMError('429 rate limit exceeded');
      return res;
    });
    const adapter = new RetryingAdapter(inner, 3, 100);

    const promise = adapter.chat(req);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual(res);
    expect(inner.chat).toHaveBeenCalledTimes(3);
  });

  it('retriable 에러가 maxAttempts 초과하면 마지막 에러 throw', async () => {
    const inner = makeAdapter(throwLLMError('503 service unavailable'));
    const adapter = new RetryingAdapter(inner, 3, 100);

    await expect(Promise.all([adapter.chat(req), vi.runAllTimersAsync()])).rejects.toThrow(
      '503 service unavailable',
    );
    expect(inner.chat).toHaveBeenCalledTimes(3);
  });

  it('non-retriable LLMError → attempt 0에서 즉시 throw (루프 진입 없이)', async () => {
    const inner = makeAdapter(throwLLMError('No text content in LLM response'));
    const adapter = new RetryingAdapter(inner, 3, 100);

    await expect(adapter.chat(req)).rejects.toThrow('No text content in LLM response');
    expect(inner.chat).toHaveBeenCalledTimes(1);
  });

  it('non-LLMError → 즉시 rethrow', async () => {
    const inner = makeAdapter(async () => {
      throw new Error('unexpected');
    });
    const adapter = new RetryingAdapter(inner, 3, 100);

    await expect(adapter.chat(req)).rejects.toThrow('unexpected');
    expect(inner.chat).toHaveBeenCalledTimes(1);
  });

  it('timeout 키워드 → retriable로 인식하여 재시도', async () => {
    let calls = 0;
    const inner = makeAdapter(async () => {
      calls++;
      if (calls < 2) throw new LLMError('Connection timeout');
      return res;
    });
    const adapter = new RetryingAdapter(inner, 3, 100);

    const promise = adapter.chat(req);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual(res);
    expect(inner.chat).toHaveBeenCalledTimes(2);
  });

  it('ECONNRESET 키워드 → retriable로 인식하여 재시도', async () => {
    let calls = 0;
    const inner = makeAdapter(async () => {
      calls++;
      if (calls < 2) throw new LLMError('ECONNRESET socket hang up');
      return res;
    });
    const adapter = new RetryingAdapter(inner, 2, 100);

    const promise = adapter.chat(req);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual(res);
    expect(inner.chat).toHaveBeenCalledTimes(2);
  });

  it('maxAttempts=1이면 재시도 없이 즉시 throw', async () => {
    const inner = makeAdapter(throwLLMError('429 too many requests'));
    const adapter = new RetryingAdapter(inner, 1, 100);

    await expect(adapter.chat(req)).rejects.toThrow('429 too many requests');
    expect(inner.chat).toHaveBeenCalledTimes(1);
  });

  it('exponential backoff: 1차 지연 baseDelayMs, 2차 지연 baseDelayMs*2', async () => {
    const advanceSpy = vi.spyOn(global, 'setTimeout');
    let calls = 0;
    const inner = makeAdapter(async () => {
      calls++;
      if (calls < 3) throw new LLMError('503 retry');
      return res;
    });
    const adapter = new RetryingAdapter(inner, 3, 500);

    const promise = adapter.chat(req);
    await vi.runAllTimersAsync();
    await promise;

    const delays = advanceSpy.mock.calls.map((c) => c[1] as number).filter((d) => d > 0);
    expect(delays[0]).toBe(500);
    expect(delays[1]).toBe(1000);

    advanceSpy.mockRestore();
  });
});
