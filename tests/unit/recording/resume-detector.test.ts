import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { detectResume } from '../../../src/recording/resume-detector.js';
import { getFramesPath } from '../../../src/recording/recording-dir.js';

const TEST_DIR = '.gestalt/recordings';

describe('detectResume', () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    // 테스트 후 남은 .frames 파일 정리
  });

  it('returns isResuming=false when no .frames file exists', () => {
    const sessionId = `no-frames-${randomUUID()}`;
    const result = detectResume(sessionId);

    expect(result.isResuming).toBe(false);
    expect(result.framesPath).toContain(sessionId);
    expect(result.framesPath.endsWith('.frames')).toBe(true);
  });

  it('returns isResuming=true when .frames file exists', () => {
    const sessionId = `has-frames-${randomUUID()}`;
    const framesPath = getFramesPath(sessionId);

    // .frames 파일 생성
    writeFileSync(framesPath, '{"timestamp":1,"data":"test","cols":80,"rows":24}\n', 'utf8');

    try {
      const result = detectResume(sessionId);
      expect(result.isResuming).toBe(true);
      expect(result.framesPath).toBe(framesPath);
    } finally {
      if (existsSync(framesPath)) rmSync(framesPath);
    }
  });

  it('returns the correct framesPath', () => {
    const sessionId = `path-check-${randomUUID()}`;
    const expectedPath = getFramesPath(sessionId);
    const result = detectResume(sessionId);

    expect(result.framesPath).toBe(expectedPath);
  });
});
