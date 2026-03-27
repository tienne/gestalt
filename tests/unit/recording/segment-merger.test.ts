import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SegmentMerger } from '../../../src/recording/segment-merger.js';
import type { TerminalFrame } from '../../../src/core/types.js';

const TEST_DIR = '.gestalt/recordings';

function makeFrame(timestamp: number, data = 'test'): TerminalFrame {
  return { timestamp, data, cols: 80, rows: 24 };
}

function writeFramesFile(path: string, frames: TerminalFrame[]): void {
  const lines = frames.map((f) => JSON.stringify(f)).join('\n') + '\n';
  writeFileSync(path, lines, 'utf8');
}

describe('SegmentMerger', () => {
  let merger: SegmentMerger;
  const tempFiles: string[] = [];

  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
    merger = new SegmentMerger();
  });

  afterEach(() => {
    for (const f of tempFiles) {
      if (existsSync(f)) rmSync(f);
    }
    tempFiles.length = 0;
  });

  function makeTempFile(frames: TerminalFrame[]): string {
    const path = join(TEST_DIR, `test-merger-${randomUUID()}.frames`);
    writeFramesFile(path, frames);
    tempFiles.push(path);
    return path;
  }

  it('readSingleFile reads frames from a .frames file', async () => {
    const frames = [
      makeFrame(1000, 'line 1'),
      makeFrame(2000, 'line 2'),
      makeFrame(3000, 'line 3'),
    ];
    const path = makeTempFile(frames);

    const result = await merger.readSingleFile(path);
    expect(result).toHaveLength(3);
    expect(result[0].data).toBe('line 1');
    expect(result[1].data).toBe('line 2');
    expect(result[2].data).toBe('line 3');
  });

  it('readSingleFile returns empty array for non-existent file', async () => {
    const result = await merger.readSingleFile('/nonexistent/path.frames');
    expect(result).toHaveLength(0);
  });

  it('mergeFrameFiles merges multiple files in timestamp order', async () => {
    const frames1 = [makeFrame(3000, 'c'), makeFrame(1000, 'a')];
    const frames2 = [makeFrame(2000, 'b'), makeFrame(4000, 'd')];

    const path1 = makeTempFile(frames1);
    const path2 = makeTempFile(frames2);

    const result = await merger.mergeFrameFiles([path1, path2]);
    expect(result).toHaveLength(4);
    // 타임스탬프 오름차순 정렬 확인
    expect(result[0].timestamp).toBeLessThanOrEqual(result[1].timestamp);
    expect(result[1].timestamp).toBeLessThanOrEqual(result[2].timestamp);
    expect(result[2].timestamp).toBeLessThanOrEqual(result[3].timestamp);
  });

  it('mergeFrameFiles skips non-existent files', async () => {
    const frames = [makeFrame(1000, 'real')];
    const path = makeTempFile(frames);

    const result = await merger.mergeFrameFiles([path, '/nonexistent.frames']);
    expect(result).toHaveLength(1);
  });

  it('mergeFrameFiles returns empty array when all files are missing', async () => {
    const result = await merger.mergeFrameFiles(['/a.frames', '/b.frames']);
    expect(result).toHaveLength(0);
  });

  it('compresses gaps larger than 5 seconds to 3 seconds', async () => {
    const frames = [
      makeFrame(1000, 'before-gap'),
      makeFrame(10000, 'after-gap'), // 9초 갭
    ];
    const path = makeTempFile(frames);

    const result = await merger.readSingleFile(path);
    expect(result).toHaveLength(2);

    // 갭이 5초 이상이면 3초(3000ms)로 압축
    const gap = result[1].timestamp - result[0].timestamp;
    expect(gap).toBe(3000);
  });

  it('does not compress gaps smaller than 5 seconds', async () => {
    const frames = [
      makeFrame(1000, 'frame1'),
      makeFrame(3000, 'frame2'), // 2초 갭 (5초 미만)
    ];
    const path = makeTempFile(frames);

    const result = await merger.readSingleFile(path);
    expect(result).toHaveLength(2);

    // 5초 미만 갭은 유지
    const gap = result[1].timestamp - result[0].timestamp;
    expect(gap).toBe(2000);
  });

  it('handles single frame without error', async () => {
    const frames = [makeFrame(1000, 'only one')];
    const path = makeTempFile(frames);

    const result = await merger.readSingleFile(path);
    expect(result).toHaveLength(1);
    expect(result[0].data).toBe('only one');
  });

  it('normalizes unsorted frames to ascending timestamp order', async () => {
    const frames = [
      makeFrame(5000, 'e'),
      makeFrame(2000, 'b'),
      makeFrame(4000, 'd'),
      makeFrame(1000, 'a'),
      makeFrame(3000, 'c'),
    ];
    const path = makeTempFile(frames);

    const result = await merger.readSingleFile(path);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].timestamp).toBeGreaterThanOrEqual(result[i - 1].timestamp);
    }
  });
});
