import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FilenameGenerator } from '../../../src/recording/filename-generator.js';
import type { LLMAdapter } from '../../../src/llm/types.js';

function makeMockLLM(responseContent: string): LLMAdapter {
  return {
    chat: vi.fn().mockResolvedValue({ content: responseContent }),
  } as unknown as LLMAdapter;
}

function makeFaiingLLM(): LLMAdapter {
  return {
    chat: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
  } as unknown as LLMAdapter;
}

describe('FilenameGenerator', () => {
  it('generates filename using LLM slug + date', async () => {
    const llm = makeMockLLM('auth-system-interview');
    const gen = new FilenameGenerator(llm);
    const sessionId = randomUUID();

    const result = await gen.generate('User authentication system', sessionId);

    // kebab-case slug + YYYYMMDD + .gif
    expect(result).toMatch(/^auth-system-interview-\d{8}\.gif$/);
  });

  it('sanitizes LLM response to kebab-case', async () => {
    const llm = makeMockLLM('  User Auth System!!!  ');
    const gen = new FilenameGenerator(llm);
    const sessionId = randomUUID();

    const result = await gen.generate('User Auth', sessionId);

    // 공백/특수문자 → 하이픈, 소문자 변환됨
    expect(result).not.toContain(' ');
    expect(result).not.toContain('!');
    expect(result).toMatch(/^[a-z0-9-]+-\d{8}\.gif$/);
  });

  it('falls back to topic-based slug when LLM fails', async () => {
    const llm = makeFaiingLLM();
    const gen = new FilenameGenerator(llm);
    const sessionId = randomUUID();

    const result = await gen.generate('Payment Processing', sessionId);

    // LLM 실패 → topic 기반 fallback slug
    expect(result).toContain('payment');
    expect(result.endsWith('.gif')).toBe(true);
  });

  it('falls back when LLM returns empty string', async () => {
    const llm = makeMockLLM('   ');
    const gen = new FilenameGenerator(llm);
    const sessionId = randomUUID();

    const result = await gen.generate('My Project', sessionId);

    // 빈 응답 → fallback
    expect(result.endsWith('.gif')).toBe(true);
    expect(result).toContain('my');
  });

  it('uses outputDir option when provided', async () => {
    const llm = makeMockLLM('my-recording');
    const gen = new FilenameGenerator(llm, { outputDir: '.gestalt/gifs' });
    const sessionId = randomUUID();

    const result = await gen.generate('Test topic', sessionId);

    expect(result.startsWith('.gestalt/gifs/')).toBe(true);
    expect(result.endsWith('.gif')).toBe(true);
  });

  it('does not include directory prefix when outputDir is default (".")', async () => {
    const llm = makeMockLLM('simple-slug');
    const gen = new FilenameGenerator(llm);
    const sessionId = randomUUID();

    const result = await gen.generate('Test', sessionId);

    // "." 디렉토리는 경로에 포함되지 않음
    expect(result.startsWith('.')).toBe(false);
    expect(result).toMatch(/^simple-slug-\d{8}\.gif$/);
  });

  it('includes YYYYMMDD date in filename', async () => {
    const llm = makeMockLLM('date-test');
    const gen = new FilenameGenerator(llm);
    const sessionId = randomUUID();

    const result = await gen.generate('Test', sessionId);

    // 날짜 패턴 확인 (YYYYMMDD)
    const datePattern = /\d{8}/;
    expect(result).toMatch(datePattern);
  });

  it('fallback slug for topic with special characters', async () => {
    const llm = makeFaiingLLM();
    const gen = new FilenameGenerator(llm);
    const sessionId = randomUUID();

    const result = await gen.generate('Test! @#$%^& Project', sessionId);

    // 특수문자 제거됨
    expect(result).not.toMatch(/[!@#$%^&]/);
    expect(result.endsWith('.gif')).toBe(true);
  });

  it('fallback slug uses "interview" for empty topic', async () => {
    const llm = makeFaiingLLM();
    const gen = new FilenameGenerator(llm);
    const sessionId = randomUUID();

    const result = await gen.generate('', sessionId);

    // 빈 topic → "interview" fallback
    expect(result).toContain('interview');
    expect(result.endsWith('.gif')).toBe(true);
  });
});
