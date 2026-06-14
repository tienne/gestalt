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
