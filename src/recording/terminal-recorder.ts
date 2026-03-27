import { appendFileSync, existsSync } from 'node:fs';
import { ensureRecordingsDir, getFramesPath } from './recording-dir.js';
import type { TerminalFrame, RecordingSegment } from '../core/types.js';

/**
 * TerminalRecorder: process.stdout.write를 인터셉트하여
 * TerminalFrame을 .frames NDJSON 파일에 실시간 append한다.
 *
 * node-pty 없이도 동작하지만, PTY 기반 캡처가 필요한 경우
 * 향후 node-pty 통합으로 확장 가능하도록 설계한다.
 */
export class TerminalRecorder {
  private readonly framesPath: string;
  private segment: RecordingSegment | null = null;
  private isRecording = false;
  private frameBuffer: TerminalFrame[] = [];

  // 원본 stdout.write 저장
  private originalStdoutWrite!: typeof process.stdout.write;

  constructor(private readonly sessionId: string) {
    ensureRecordingsDir();
    this.framesPath = getFramesPath(sessionId);
  }

  /** 녹화 시작. 기존 .frames 파일이 있으면 이어서 append (resume) */
  start(): RecordingSegment {
    if (this.isRecording) return this.segment!;

    const isResuming = existsSync(this.framesPath);
    this.segment = {
      sessionId: this.sessionId,
      framesPath: this.framesPath,
      startedAt: Date.now(),
    };

    this.isRecording = true;
    this.interceptStdout();

    if (!isResuming) {
      // 새 녹화: 빈 파일로 시작
    }

    return this.segment;
  }

  /** 녹화 일시 중지 (세션 중단 시) */
  pause(): void {
    if (!this.isRecording) return;
    this.restoreStdout();
    this.flushBuffer();
    if (this.segment) {
      this.segment.endedAt = Date.now();
    }
    this.isRecording = false;
  }

  /** 녹화 완전 종료 */
  stop(): RecordingSegment | null {
    if (this.isRecording) {
      this.pause();
    }
    return this.segment;
  }

  get recording(): boolean {
    return this.isRecording;
  }

  get framesFilePath(): string {
    return this.framesPath;
  }

  /** stdout.write 인터셉트 */
  private interceptStdout(): void {
    const self = this;
    this.originalStdoutWrite = process.stdout.write.bind(process.stdout);

    // overwrite with interceptor
    const intercepted = function (
      this: typeof process.stdout,
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean {
      const data = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      self.captureFrame(data);

      // 원본 write 호출
      if (typeof encodingOrCallback === 'function') {
        return self.originalStdoutWrite(chunk, encodingOrCallback);
      }
      if (typeof encodingOrCallback === 'string') {
        return self.originalStdoutWrite(chunk, encodingOrCallback, callback);
      }
      return self.originalStdoutWrite(chunk);
    };

    process.stdout.write = intercepted as typeof process.stdout.write;
  }

  private restoreStdout(): void {
    if (this.originalStdoutWrite) {
      process.stdout.write = this.originalStdoutWrite;
    }
  }

  private captureFrame(data: string): void {
    if (!data || !this.isRecording) return;

    const frame: TerminalFrame = {
      timestamp: Date.now(),
      data,
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
    };

    this.frameBuffer.push(frame);

    // 버퍼가 10개 이상 쌓이면 즉시 flush
    if (this.frameBuffer.length >= 10) {
      this.flushBuffer();
    }
  }

  private flushBuffer(): void {
    if (this.frameBuffer.length === 0) return;
    const lines = this.frameBuffer.map((f) => JSON.stringify(f)).join('\n') + '\n';
    appendFileSync(this.framesPath, lines, 'utf8');
    this.frameBuffer = [];
  }
}
