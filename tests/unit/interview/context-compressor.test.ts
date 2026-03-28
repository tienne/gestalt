import { describe, it, expect } from 'vitest';
import { ContextCompressor, COMPRESSION_THRESHOLD } from '../../../src/interview/context-compressor.js';
import type { InterviewRound } from '../../../src/core/types.js';

function makeRound(roundNumber: number, response: string | null = 'answer'): InterviewRound {
  return {
    roundNumber,
    question: `Question ${roundNumber}`,
    userResponse: response,
    gestaltFocus: 'closure',
    timestamp: new Date().toISOString(),
  };
}

describe('ContextCompressor', () => {
  const compressor = new ContextCompressor();

  describe('needsCompression', () => {
    it('returns false when rounds <= threshold', () => {
      const rounds = Array.from({ length: COMPRESSION_THRESHOLD }, (_, i) => makeRound(i + 1));
      expect(compressor.needsCompression(rounds)).toBe(false);
    });

    it('returns true when completed rounds exceed threshold', () => {
      const rounds = Array.from({ length: COMPRESSION_THRESHOLD + 1 }, (_, i) => makeRound(i + 1));
      expect(compressor.needsCompression(rounds)).toBe(true);
    });

    it('only counts rounds with non-null responses', () => {
      const rounds = [
        ...Array.from({ length: COMPRESSION_THRESHOLD }, (_, i) => makeRound(i + 1)),
        makeRound(COMPRESSION_THRESHOLD + 1, null), // unanswered
      ];
      expect(compressor.needsCompression(rounds)).toBe(false);
    });

    it('returns false for empty rounds', () => {
      expect(compressor.needsCompression([])).toBe(false);
    });
  });

  describe('buildCompressionContext', () => {
    it('returns systemPrompt and compressionPrompt', () => {
      const rounds = Array.from({ length: 6 }, (_, i) => makeRound(i + 1));
      const ctx = compressor.buildCompressionContext('Test Topic', rounds);
      expect(ctx.systemPrompt).toBeTruthy();
      expect(ctx.compressionPrompt).toBeTruthy();
    });

    it('includes topic in compressionPrompt', () => {
      const rounds = Array.from({ length: 6 }, (_, i) => makeRound(i + 1));
      const ctx = compressor.buildCompressionContext('My Project', rounds);
      expect(ctx.compressionPrompt).toContain('My Project');
    });

    it('includes Q&A content in compressionPrompt', () => {
      const rounds = Array.from({ length: 6 }, (_, i) => makeRound(i + 1));
      const ctx = compressor.buildCompressionContext('Topic', rounds);
      expect(ctx.compressionPrompt).toContain('Question 1');
      expect(ctx.compressionPrompt).toContain('answer');
    });

    it('excludes last 3 rounds from compression', () => {
      const rounds = Array.from({ length: 6 }, (_, i) => makeRound(i + 1));
      const ctx = compressor.buildCompressionContext('Topic', rounds);
      // Rounds 1-3 should be in the prompt (compressed), rounds 4-6 are kept recent
      expect(ctx.compressionPrompt).toContain('Question 1');
      expect(ctx.compressionPrompt).toContain('Question 3');
      // Round 4+ are kept as recent context, not compressed
      expect(ctx.compressionPrompt).not.toContain('Question 4');
    });

    it('incorporates existing summary when provided', () => {
      const rounds = Array.from({ length: 6 }, (_, i) => makeRound(i + 1));
      const existingSummary = 'Previous summary content';
      const ctx = compressor.buildCompressionContext('Topic', rounds, existingSummary);
      expect(ctx.compressionPrompt).toContain('Previous summary content');
    });
  });

  describe('buildCompressedContext', () => {
    it('returns CompressedContext with summary and metadata', () => {
      const result = compressor.buildCompressedContext('Compressed summary', 3);
      expect(result.summary).toBe('Compressed summary');
      expect(result.roundsCompressed).toBe(3);
      expect(result.compressedAt).toBeTruthy();
    });

    it('sets compressedAt to ISO date string', () => {
      const result = compressor.buildCompressedContext('Summary', 5);
      expect(() => new Date(result.compressedAt)).not.toThrow();
      const date = new Date(result.compressedAt);
      expect(date.getFullYear()).toBeGreaterThan(2000);
    });
  });
});
