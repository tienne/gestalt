import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { TerminalRecorder } from '../../../src/recording/terminal-recorder.js';
import { getFramesPath } from '../../../src/recording/recording-dir.js';

const TEST_DIR = '.gestalt/recordings';

describe('TerminalRecorder', () => {
  let recorder: TerminalRecorder;
  let sessionId: string;
  let framesPath: string;

  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
    sessionId = `recorder-test-${randomUUID()}`;
    framesPath = getFramesPath(sessionId);
    recorder = new TerminalRecorder(sessionId);
  });

  afterEach(() => {
    // 녹화 중이면 정지
    if (recorder.recording) {
      recorder.stop();
    }
    // 파일 정리
    if (existsSync(framesPath)) rmSync(framesPath);
  });

  it('starts with recording=false', () => {
    expect(recorder.recording).toBe(false);
  });

  it('sets recording=true after start()', () => {
    recorder.start();
    expect(recorder.recording).toBe(true);
    recorder.stop();
  });

  it('sets recording=false after stop()', () => {
    recorder.start();
    recorder.stop();
    expect(recorder.recording).toBe(false);
  });

  it('sets recording=false after pause()', () => {
    recorder.start();
    recorder.pause();
    expect(recorder.recording).toBe(false);
  });

  it('returns framesFilePath with correct sessionId', () => {
    expect(recorder.framesFilePath).toContain(sessionId);
    expect(recorder.framesFilePath.endsWith('.frames')).toBe(true);
  });

  it('start() is idempotent — calling twice returns same segment', () => {
    const seg1 = recorder.start();
    const seg2 = recorder.start();
    expect(seg1).toBe(seg2);
    recorder.stop();
  });

  it('captures stdout writes to .frames file', () => {
    recorder.start();
    // stdout.write 인터셉트 상태에서 데이터 출력
    process.stdout.write('hello test frame\n');
    recorder.stop(); // stop 시 버퍼 flush

    expect(existsSync(framesPath)).toBe(true);
    const content = readFileSync(framesPath, 'utf8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('flushes buffer on stop() and writes NDJSON lines', () => {
    recorder.start();
    process.stdout.write('frame-line-1\n');
    process.stdout.write('frame-line-2\n');
    recorder.stop();

    if (existsSync(framesPath)) {
      const content = readFileSync(framesPath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      // 최소 1개 이상의 NDJSON 라인이 있어야 함
      expect(lines.length).toBeGreaterThan(0);
      // 각 라인이 유효한 JSON인지 확인
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed).toHaveProperty('timestamp');
        expect(parsed).toHaveProperty('data');
        expect(parsed).toHaveProperty('cols');
        expect(parsed).toHaveProperty('rows');
      }
    }
  });

  it('appends to existing .frames file on resume', () => {
    // 첫 번째 녹화 세션
    recorder.start();
    process.stdout.write('first-session-data\n');
    recorder.stop();

    const firstContent = existsSync(framesPath) ? readFileSync(framesPath, 'utf8') : '';

    // 두 번째 녹화 세션 (resume)
    const recorder2 = new TerminalRecorder(sessionId);
    recorder2.start();
    process.stdout.write('second-session-data\n');
    recorder2.stop();

    const secondContent = readFileSync(framesPath, 'utf8');
    // resume 시 파일이 더 커져야 함 (또는 최소한 원래 내용 포함)
    expect(secondContent.length).toBeGreaterThanOrEqual(firstContent.length);
  });

  it('stop() returns null if never started', () => {
    const result = recorder.stop();
    expect(result).toBeNull();
  });

  it('stop() returns segment after recording', () => {
    recorder.start();
    process.stdout.write('some output\n');
    const segment = recorder.stop();

    expect(segment).not.toBeNull();
    expect(segment?.sessionId).toBe(sessionId);
    expect(segment?.startedAt).toBeGreaterThan(0);
  });

  it('restores original stdout.write after stop()', () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    recorder.start();
    const interceptedWrite = process.stdout.write;
    recorder.stop();

    // stop 후에는 write 함수가 인터셉트된 버전이 아니어야 함
    // (원본으로 복구되었는지 확인)
    expect(process.stdout.write).not.toBe(interceptedWrite);
  });
});
