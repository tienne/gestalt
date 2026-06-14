import OpenAI from 'openai';
import { LLM_TEMPERATURE, LLM_MAX_TOKENS } from '../core/constants.js';
import { LLMError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import type { LLMAdapter, LLMRequest, LLMResponse } from './types.js';

export class OpenAIAdapter implements LLMAdapter {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.model = model;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const t0 = Date.now();
    try {
      const messages: OpenAI.ChatCompletionMessageParam[] = [];

      if (request.system) {
        messages.push({ role: 'system', content: request.system });
      }

      for (const m of request.messages) {
        messages.push({ role: m.role, content: m.content });
      }

      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: request.maxTokens ?? LLM_MAX_TOKENS,
        temperature: request.temperature ?? LLM_TEMPERATURE,
        messages,
      });

      const choice = response.choices[0];
      if (!choice?.message?.content) {
        throw new LLMError('No content in OpenAI response');
      }

      logger.info('llm.chat_completed', {
        module: 'llm/openai-adapter',
        provider: 'openai',
        model: this.model,
        durationMs: Date.now() - t0,
      });

      return {
        content: choice.message.content,
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
      };
    } catch (e) {
      logger.error('llm.chat_failed', {
        module: 'llm/openai-adapter',
        provider: 'openai',
        model: this.model,
        durationMs: Date.now() - t0,
        error: e instanceof Error ? e.message : String(e),
      });
      if (e instanceof LLMError) throw e;
      throw new LLMError(`OpenAI API error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
