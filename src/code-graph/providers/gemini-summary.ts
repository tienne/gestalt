import OpenAI from 'openai';
import type { SummaryProvider } from '../summary-provider.js';

const SYSTEM_PROMPT =
  'Generate a concise technical summary (1-2 sentences) of the following code file for semantic search indexing.';

const MAX_CODE_LENGTH = 2000;
const DEFAULT_MODEL = 'gemini-2.0-flash';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

export class GeminiSummaryProvider implements SummaryProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: GEMINI_BASE_URL,
    });
    this.model = model ?? DEFAULT_MODEL;
  }

  async summarize(filePath: string, code: string): Promise<string | null> {
    try {
      const trimmedCode = code.slice(0, MAX_CODE_LENGTH);
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 256,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `File: ${filePath}\n\n${trimmedCode}`,
          },
        ],
      });

      const choice = response.choices[0];
      const content = choice?.message?.content;
      if (!content) {
        return null;
      }

      return content.trim() || null;
    } catch {
      return null;
    }
  }
}
