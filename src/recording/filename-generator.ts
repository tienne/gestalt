import type { LLMAdapter } from '../llm/types.js';

export interface FilenameGeneratorOptions {
  outputDir?: string;
}

export class FilenameGenerator {
  constructor(
    private readonly llm: LLMAdapter,
    private readonly options: FilenameGeneratorOptions = {},
  ) {}

  /**
   * 인터뷰 topic 기반으로 kebab-case 이름을 LLM에게 요청하고
   * YYYYMMDD 날짜 접미사를 붙여 GIF 파일명을 생성한다.
   */
  async generate(topic: string, sessionId: string): Promise<string> {
    const slug = await this.requestSlugFromLLM(topic, sessionId);
    const date = this.getDateString();
    const filename = `${slug}-${date}.gif`;
    const dir = this.options.outputDir ?? '.';
    return dir === '.' ? filename : `${dir}/${filename}`;
  }

  private async requestSlugFromLLM(topic: string, sessionId: string): Promise<string> {
    try {
      const response = await this.llm.chat({
        system: 'You are a file naming assistant. Respond with ONLY a kebab-case slug (2-5 words, lowercase, hyphens only, no spaces, no special chars, no extension).',
        messages: [
          {
            role: 'user',
            content: `Generate a descriptive kebab-case filename for a terminal recording of an interview about: "${topic}"\n\nSession: ${sessionId}\n\nRespond with ONLY the kebab-case slug, nothing else.`,
          },
        ],
        maxTokens: 50,
        temperature: 0.3,
      });

      const slug = response.content
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

      return slug || this.fallbackSlug(topic);
    } catch {
      return this.fallbackSlug(topic);
    }
  }

  private fallbackSlug(topic: string): string {
    return topic
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40) || 'interview';
  }

  private getDateString(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }
}
