import Anthropic from '@anthropic-ai/sdk';
import type { SummaryProvider } from '../summary-provider.js';

const SYSTEM_PROMPT =
  'Generate a concise technical summary (1-2 sentences) of the following code file for semantic search indexing.';

const MAX_CODE_LENGTH = 2000;
const DEFAULT_MODEL = 'claude-haiku-4-20250514';

export class AnthropicSummaryProvider implements SummaryProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model ?? DEFAULT_MODEL;
  }

  async summarize(filePath: string, code: string): Promise<string | null> {
    try {
      const trimmedCode = code.slice(0, MAX_CODE_LENGTH);
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 256,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `File: ${filePath}\n\n${trimmedCode}`,
          },
        ],
      });

      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        return null;
      }

      return textBlock.text.trim() || null;
    } catch {
      return null;
    }
  }
}
