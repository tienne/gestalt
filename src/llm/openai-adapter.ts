import OpenAI from 'openai';
import { LLM_TEMPERATURE, LLM_MAX_TOKENS } from '../core/constants.js';
import { LLMError } from '../core/errors.js';
import type { LLMAdapter, LLMRequest, LLMResponse } from './types.js';

export class OpenAIAdapter implements LLMAdapter {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.model = model;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
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

      return {
        content: choice.message.content,
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
      };
    } catch (e) {
      if (e instanceof LLMError) throw e;
      throw new LLMError(`OpenAI API error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
