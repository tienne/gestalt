import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Jimp, loadFont } from 'jimp';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import GIFEncoder from 'gifencoder';
import type { TerminalFrame, GifOutput } from '../core/types.js';

// ANSI escape code 제거 정규식
const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]|\x1B\][^\x07]*\x07|\x1B[()][A-Z0-9]|\r/g;

// 터미널 렌더링 설정
const CHAR_WIDTH = 9;
const CHAR_HEIGHT = 18;
const PADDING = 10;
const BG_COLOR = 0x1e1e2eff; // dark background

export interface GifGeneratorOptions {
  repeat?: number; // -1: no repeat, 0: forever
  quality?: number; // 1-20, lower = better quality
  frameDelay?: number; // default delay between frames (ms)
}

export class GifGenerator {
  private readonly repeat: number;
  private readonly quality: number;
  private readonly frameDelay: number;

  constructor(options: GifGeneratorOptions = {}) {
    this.repeat = options.repeat ?? 0;
    this.quality = options.quality ?? 10;
    this.frameDelay = options.frameDelay ?? 100;
  }

  /** .frames NDJSON 파일을 읽어 GIF 파일로 변환 */
  async generate(framesPath: string, outputPath: string): Promise<GifOutput> {
    if (!existsSync(framesPath)) {
      throw new Error(`Frames file not found: ${framesPath}`);
    }

    const frames = await this.readFrames(framesPath);
    if (frames.length === 0) {
      throw new Error('No frames found in recording');
    }

    return this.encodeGif(frames, outputPath);
  }

  /** TerminalFrame 배열을 직접 받아 GIF 생성 (SegmentMerger에서 병합된 결과 사용) */
  async generateFromFrames(frames: TerminalFrame[], outputPath: string): Promise<GifOutput> {
    if (frames.length === 0) {
      throw new Error('No frames to encode');
    }
    return this.encodeGif(frames, outputPath);
  }

  async readFrames(framesPath: string): Promise<TerminalFrame[]> {
    const frames: TerminalFrame[] = [];
    const rl = createInterface({
      input: createReadStream(framesPath),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const frame = JSON.parse(trimmed) as TerminalFrame;
        frames.push(frame);
      } catch {
        // 파싱 실패한 라인 무시
      }
    }

    return frames;
  }

  private async encodeGif(frames: TerminalFrame[], outputPath: string): Promise<GifOutput> {
    const font = await this.loadTerminalFont();

    const firstFrame = frames[0]!;
    const width = firstFrame.cols * CHAR_WIDTH + PADDING * 2;
    const height = firstFrame.rows * CHAR_HEIGHT + PADDING * 2;

    const encoder = new GIFEncoder(width, height);
    const outputStream = createWriteStream(outputPath);
    encoder.createReadStream().pipe(outputStream);

    encoder.start();
    encoder.setRepeat(this.repeat);
    encoder.setDelay(this.frameDelay);
    encoder.setQuality(this.quality);

    let prevTimestamp = frames[0]!.timestamp;

    for (const frame of frames) {
      const delay = Math.min(Math.max(frame.timestamp - prevTimestamp, 50), 3000);
      encoder.setDelay(delay || this.frameDelay);
      prevTimestamp = frame.timestamp;

      const imageData = await this.renderFrame(frame, font, width, height);
      encoder.addFrame(imageData);
    }

    encoder.finish();

    await new Promise<void>((resolve, reject) => {
      outputStream.on('finish', resolve);
      outputStream.on('error', reject);
    });

    const { statSync } = await import('node:fs');
    const stat = statSync(outputPath);

    return {
      filePath: outputPath,
      sizeBytes: stat.size,
      frameCount: frames.length,
      durationMs: frames[frames.length - 1]!.timestamp - frames[0]!.timestamp,
    };
  }

  private async renderFrame(
    frame: TerminalFrame,
    font: Awaited<ReturnType<typeof loadFont>>,
    width: number,
    height: number,
  ): Promise<Buffer> {
    const image = new Jimp({ width, height, color: BG_COLOR });

    const text = stripAnsi(frame.data);
    const lines = text.split('\n');

    let y = PADDING;
    for (const line of lines) {
      if (y >= height - PADDING) break;
      if (line.length > 0) {
        image.print({ font, x: PADDING, y, text: line });
      }
      y += CHAR_HEIGHT;
    }

    return image.bitmap.data as Buffer;
  }

  private async loadTerminalFont(): Promise<Awaited<ReturnType<typeof loadFont>>> {
    const req = createRequire(import.meta.url);
    const jimpPath = req.resolve('jimp');
    const fontPath = join(
      dirname(jimpPath),
      '../../../@jimp/plugin-print/fonts/open-sans/open-sans-16-white/open-sans-16-white.fnt',
    );
    return loadFont(fontPath);
  }
}

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}
