import { existsSync } from 'node:fs';
import type { TerminalFrame } from '../core/types.js';
import { GifGenerator } from './gif-generator.js';

/**
 * SegmentMerger: 동일 sessionId의 여러 .frames 파일 세그먼트를
 * 시간순으로 병합해 GifGenerator에 전달한다.
 *
 * 현재 아키텍처에서는 sessionId당 .frames 파일이 1개이므로,
 * 단일 파일 읽기도 이 클래스를 경유해 일관된 인터페이스를 유지한다.
 */
export class SegmentMerger {
  private readonly gifGenerator: GifGenerator;

  constructor(gifGenerator?: GifGenerator) {
    this.gifGenerator = gifGenerator ?? new GifGenerator();
  }

  /**
   * 여러 .frames 파일을 읽어 타임스탬프 기준 오름차순으로 병합한다.
   * 각 세그먼트 사이의 긴 갭(5초 이상)은 3초로 압축한다.
   */
  async mergeFrameFiles(framesPaths: string[]): Promise<TerminalFrame[]> {
    const allFrames: TerminalFrame[] = [];

    for (const framesPath of framesPaths) {
      if (!existsSync(framesPath)) continue;
      const frames = await this.gifGenerator.readFrames(framesPath);
      allFrames.push(...frames);
    }

    return this.normalizeTimestamps(allFrames);
  }

  /**
   * 단일 .frames 파일 읽기 (공통 인터페이스 유지)
   */
  async readSingleFile(framesPath: string): Promise<TerminalFrame[]> {
    return this.mergeFrameFiles([framesPath]);
  }

  /**
   * 타임스탬프를 오름차순 정렬하고 큰 갭을 압축한다.
   */
  private normalizeTimestamps(frames: TerminalFrame[]): TerminalFrame[] {
    if (frames.length === 0) return [];

    // 타임스탬프 오름차순 정렬
    frames.sort((a, b) => a.timestamp - b.timestamp);

    // 세그먼트 갭 압축: 5초 이상 빈 구간은 3초로 압축
    const GAP_THRESHOLD_MS = 5000;
    const MAX_GAP_MS = 3000;

    const normalized: TerminalFrame[] = [frames[0]!];
    for (let i = 1; i < frames.length; i++) {
      const curr = frames[i]!;
      const prev_frame = frames[i - 1]!;
      const gap = curr.timestamp - prev_frame.timestamp;
      if (gap > GAP_THRESHOLD_MS) {
        const prev = normalized[normalized.length - 1]!;
        normalized.push({
          ...curr,
          timestamp: prev.timestamp + MAX_GAP_MS,
        });
      } else {
        normalized.push(curr);
      }
    }

    return normalized;
  }
}
