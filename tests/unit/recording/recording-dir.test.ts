import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

// We'll test the utility functions by importing them
// Note: RECORDINGS_BASE_DIR is hardcoded, so we test behavior indirectly
import { getFramesPath } from '../../../src/recording/recording-dir.js';

describe('getFramesPath', () => {
  it('returns correct path for sessionId', () => {
    const sessionId = 'abc-123';
    const result = getFramesPath(sessionId);
    expect(result).toContain('abc-123.frames');
    expect(result).toContain('.gestalt/recordings');
  });

  it('includes .frames extension', () => {
    const sessionId = randomUUID();
    const result = getFramesPath(sessionId);
    expect(result.endsWith('.frames')).toBe(true);
  });

  it('uses the sessionId in the filename', () => {
    const sessionId = 'my-session-id';
    const result = getFramesPath(sessionId);
    expect(result).toContain('my-session-id');
  });
});
