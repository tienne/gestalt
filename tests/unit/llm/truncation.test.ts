/**
 * 잘린 LLM 응답을 성공으로 돌려주지 않는지 검증한다.
 *
 * 이걸 놓치면 소비자가 잘린 텍스트를 완전한 답으로 읽는다. resolution.ts는
 * JSON을 정규식으로 뽑는데 닫는 괄호가 없어 파싱에 실패하고 전 항목 0점으로
 * 떨어진다. 사용자는 "해상도 0.00"을 보고 자기 답변이 불명확한 탓이라 여긴다.
 */
import { describe, it, expect, vi } from 'vitest';
import { AnthropicAdapter } from '../../../src/llm/adapter.js';
import { OpenAIAdapter } from '../../../src/llm/openai-adapter.js';
import { LLMError } from '../../../src/core/errors.js';
import type { LLMRequest } from '../../../src/llm/types.js';

const req: LLMRequest = {
  system: 'test',
  messages: [{ role: 'user', content: 'hello' }],
};

/** 잘린 JSON — 닫는 중괄호가 없다 */
const TRUNCATED = '{"goalClarity": 0.9, "constraintClarity": 0.8';

function anthropicWith(stopReason: string | null, text = TRUNCATED): AnthropicAdapter {
  const adapter = new AnthropicAdapter('test-key', 'claude-sonnet-5');
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 4096 },
  });
  // @ts-expect-error — 테스트에서 SDK 클라이언트를 갈아끼운다
  adapter.client = { messages: { create } };
  return adapter;
}

function openaiWith(finishReason: string, content = TRUNCATED): OpenAIAdapter {
  const adapter = new OpenAIAdapter('test-key', 'gpt-4o');
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 4096 },
  });
  // @ts-expect-error — 테스트에서 SDK 클라이언트를 갈아끼운다
  adapter.client = { chat: { completions: { create } } };
  return adapter;
}

describe('LLM 응답 절단 감지', () => {
  describe('AnthropicAdapter', () => {
    it('stop_reason이 max_tokens면 던진다', async () => {
      await expect(anthropicWith('max_tokens').chat(req)).rejects.toThrow(LLMError);
    });

    it('에러 메시지가 원인과 대처를 말한다', async () => {
      await expect(anthropicWith('max_tokens').chat(req)).rejects.toThrow(
        /truncated at max_tokens/,
      );
      await expect(anthropicWith('max_tokens').chat(req)).rejects.toThrow(/Raise maxTokens/);
    });

    it('정상 종료면 내용을 그대로 돌려준다', async () => {
      const res = await anthropicWith('end_turn', '{"ok": true}').chat(req);
      expect(res.content).toBe('{"ok": true}');
    });
  });

  describe('OpenAIAdapter', () => {
    it('finish_reason이 length면 던진다', async () => {
      await expect(openaiWith('length').chat(req)).rejects.toThrow(LLMError);
      await expect(openaiWith('length').chat(req)).rejects.toThrow(/truncated at max_tokens/);
    });

    it('정상 종료면 내용을 그대로 돌려준다', async () => {
      const res = await openaiWith('stop', '{"ok": true}').chat(req);
      expect(res.content).toBe('{"ok": true}');
    });
  });

  it('절단 에러는 재시도 대상이 아니다 — 다시 불러도 같은 데서 잘린다', async () => {
    const { RetryingAdapter } = await import('../../../src/llm/retry-adapter.js');
    const inner = anthropicWith('max_tokens');
    const spy = vi.spyOn(inner, 'chat');

    await expect(new RetryingAdapter(inner).chat(req)).rejects.toThrow(LLMError);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
