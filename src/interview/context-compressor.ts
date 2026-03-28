import type { InterviewRound, CompressedContext } from '../core/types.js';

export const COMPRESSION_THRESHOLD = 5;

export interface CompressionContext {
  systemPrompt: string;
  compressionPrompt: string;
}

/**
 * Passthrough ContextCompressor.
 * 인터뷰 라운드가 COMPRESSION_THRESHOLD(5)를 초과하면 이전 라운드를 요약한다.
 * caller가 compressionPrompt를 사용해 요약 후 결과를 제출한다.
 */
export class ContextCompressor {
  needsCompression(rounds: InterviewRound[]): boolean {
    // Compress rounds completed before the last COMPRESSION_THRESHOLD rounds
    const completedRounds = rounds.filter((r) => r.userResponse !== null);
    return completedRounds.length > COMPRESSION_THRESHOLD;
  }

  buildCompressionContext(
    topic: string,
    rounds: InterviewRound[],
    existingSummary?: string,
  ): CompressionContext {
    const completedRounds = rounds.filter((r) => r.userResponse !== null);
    // Keep the last 3 rounds uncompressed for recency, compress the rest
    const toCompress = completedRounds.slice(0, -3);

    const qaText = toCompress
      .map((r) => `Q${r.roundNumber}: ${r.question}\nA${r.roundNumber}: ${r.userResponse}`)
      .join('\n\n');

    const systemPrompt = `You are a requirements analyst. Summarize interview Q&A into a concise context block that preserves all key requirements, constraints, and decisions. Be specific and complete — nothing important should be lost.`;

    const compressionPrompt = `Summarize the following interview Q&A for topic "${topic}" into a concise context block.
${existingSummary ? `\nExisting summary (incorporate and expand):\n${existingSummary}\n` : ''}
## Q&A to Compress
${qaText}

Respond with ONLY a JSON object:
{
  "summary": "Comprehensive summary preserving all key requirements, constraints, and decisions discussed"
}`;

    return { systemPrompt, compressionPrompt };
  }

  buildCompressedContext(summary: string, roundsCompressed: number): CompressedContext {
    return {
      summary,
      compressedAt: new Date().toISOString(),
      roundsCompressed,
    };
  }
}
