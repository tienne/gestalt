import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { GifGenerator } from '../../../src/recording/gif-generator.js';
import type { TerminalFrame } from '../../../src/core/types.js';

const TEST_DIR = '.gestalt/recordings';

function makeFrame(timestamp: number, data = 'test line'): TerminalFrame {
  return { timestamp, data, cols: 80, rows: 24 };
}

describe('GifGenerator', () => {
  let tempFiles: string[];

  beforeEach(() => {
    tempFiles = [];
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    for (const f of tempFiles) {
      if (existsSync(f)) rmSync(f);
    }
  });

  describe('readFrames', () => {
    it('parses NDJSON .frames file', async () => {
      const frames = [
        makeFrame(1000, 'hello'),
        makeFrame(2000, 'world'),
      ];
      const path = join(TEST_DIR, `read-test-${randomUUID()}.frames`);
      const content = frames.map((f) => JSON.stringify(f)).join('\n') + '\n';
      writeFileSync(path, content, 'utf8');
      tempFiles.push(path);

      const gen = new GifGenerator();
      const result = await gen.readFrames(path);

      expect(result).toHaveLength(2);
      expect(result[0].data).toBe('hello');
      expect(result[0].timestamp).toBe(1000);
      expect(result[1].data).toBe('world');
    });

    it('skips invalid JSON lines', async () => {
      const path = join(TEST_DIR, `invalid-json-${randomUUID()}.frames`);
      const content = [
        JSON.stringify(makeFrame(1000, 'valid')),
        'this is not json',
        JSON.stringify(makeFrame(2000, 'also valid')),
        '',
      ].join('\n');
      writeFileSync(path, content, 'utf8');
      tempFiles.push(path);

      const gen = new GifGenerator();
      const result = await gen.readFrames(path);

      // 유효한 JSON 라인만 파싱됨
      expect(result).toHaveLength(2);
      expect(result[0].data).toBe('valid');
      expect(result[1].data).toBe('also valid');
    });

    it('returns empty array for empty file', async () => {
      const path = join(TEST_DIR, `empty-${randomUUID()}.frames`);
      writeFileSync(path, '', 'utf8');
      tempFiles.push(path);

      const gen = new GifGenerator();
      const result = await gen.readFrames(path);

      expect(result).toHaveLength(0);
    });

    it('handles whitespace-only lines gracefully', async () => {
      const path = join(TEST_DIR, `whitespace-${randomUUID()}.frames`);
      const content = `\n  \n${JSON.stringify(makeFrame(1000, 'only'))}\n\n`;
      writeFileSync(path, content, 'utf8');
      tempFiles.push(path);

      const gen = new GifGenerator();
      const result = await gen.readFrames(path);

      expect(result).toHaveLength(1);
    });
  });

  describe('generate', () => {
    it('throws when frames file does not exist', async () => {
      const gen = new GifGenerator();
      await expect(gen.generate('/nonexistent.frames', '/out.gif')).rejects.toThrow(
        'Frames file not found',
      );
    });

    it('throws when frames file is empty', async () => {
      const path = join(TEST_DIR, `empty-gen-${randomUUID()}.frames`);
      writeFileSync(path, '', 'utf8');
      tempFiles.push(path);

      const gen = new GifGenerator();
      await expect(gen.generate(path, '/out.gif')).rejects.toThrow('No frames found');
    });
  });

  describe('generateFromFrames', () => {
    it('throws when frames array is empty', async () => {
      const gen = new GifGenerator();
      await expect(gen.generateFromFrames([], '/out.gif')).rejects.toThrow('No frames to encode');
    });

    // GIF 실제 생성은 jimp + gifencoder 의존성 때문에 integration 테스트에서 커버
    // 여기서는 error path만 단위 테스트로 검증
  });

  describe('constructor options', () => {
    it('uses default options when none provided', () => {
      const gen = new GifGenerator();
      // 기본값으로 생성 시 에러 없이 인스턴스화 되어야 함
      expect(gen).toBeInstanceOf(GifGenerator);
    });

    it('accepts custom options', () => {
      const gen = new GifGenerator({ repeat: -1, quality: 5, frameDelay: 200 });
      expect(gen).toBeInstanceOf(GifGenerator);
    });
  });
});
