import Anthropic from '@anthropic-ai/sdk';
import { LLM_TEMPERATURE, LLM_MAX_TOKENS } from '../core/constants.js';
import { LLMError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import type { LLMAdapter, LLMRequest, LLMResponse } from './types.js';

export class AnthropicAdapter implements LLMAdapter {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const t0 = Date.now();
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens ?? LLM_MAX_TOKENS,
        temperature: request.temperature ?? LLM_TEMPERATURE,
        system: request.system,
        messages: request.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });

      // 잘린 응답을 성공으로 돌려주면 소비자가 그걸 완전한 답으로 읽는다.
      // JSON을 뽑는 쪽은 닫는 괄호가 없어 파싱에 실패하고 기본값으로 떨어지는데,
      // 그 기본값이 "점수 0점" 같은 그럴듯한 값이라 원인이 영영 안 드러난다.
      if (response.stop_reason === 'max_tokens') {
        throw new LLMError(
          `Response truncated at max_tokens (${request.maxTokens ?? LLM_MAX_TOKENS}). ` +
            `Raise maxTokens or shorten the prompt.`,
        );
      }

      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new LLMError('No text content in LLM response');
      }

      logger.info('llm.chat_completed', {
        module: 'llm/adapter',
        provider: 'anthropic',
        model: this.model,
        durationMs: Date.now() - t0,
      });

      return {
        content: textBlock.text,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (e) {
      logger.error('llm.chat_failed', {
        module: 'llm/adapter',
        provider: 'anthropic',
        model: this.model,
        durationMs: Date.now() - t0,
        error: e instanceof Error ? e.message : String(e),
      });
      if (e instanceof LLMError) throw e;
      throw new LLMError(`Anthropic API error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
