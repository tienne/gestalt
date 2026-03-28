import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export interface ConvertOptions {
  /** 변환 완료 후 .cast 파일을 삭제할지 여부 (기본값: true) */
  deleteCastAfter?: boolean;
  /** 변환 완료 콜백 (파일 경로 출력 등) */
  onComplete?: (outputPath: string) => void;
  /** 변환 실패 콜백 */
  onError?: (err: Error) => void;
}

/**
 * AggConverter: agg 바이너리를 사용해 .cast → GIF 변환을 비동기 백그라운드로 수행한다.
 * convert()는 즉시 return하며, 변환은 백그라운드에서 진행된다.
 */
export class AggConverter {
  /**
   * .cast 파일을 GIF로 변환한다 (백그라운드 비동기).
   * 반환값은 변환 완료를 기다리는 Promise이지만, 호출 측에서 await하지 않아도 된다.
   */
  convertAsync(castPath: string, outputPath: string, options: ConvertOptions = {}): Promise<string> {
    const { deleteCastAfter = true, onComplete, onError } = options;

    mkdirSync(dirname(outputPath), { recursive: true });

    return new Promise((resolve, reject) => {
      const child = spawn('agg', [castPath, outputPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      child.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) process.stderr.write(`[agg] ${msg}\n`);
      });

      child.on('close', async (code) => {
        if (code !== 0) {
          const err = new Error(`agg exited with code ${code}. GIF conversion failed for: ${castPath}`);
          onError?.(err);
          reject(err);
          return;
        }

        if (deleteCastAfter) {
          try {
            await unlink(castPath);
          } catch {
            // 삭제 실패는 무시
          }
        }

        onComplete?.(outputPath);
        resolve(outputPath);
      });

      child.on('error', (err) => {
        onError?.(err);
        reject(err);
      });
    });
  }

  /**
   * GIF → MP4 변환 (ffmpeg 사용).
   * agg는 gif만 지원하므로 gifPath → mp4Path 변환은 ffmpeg에 위임한다.
   */
  convertGifToMp4Async(gifPath: string, mp4Path: string, options: ConvertOptions = {}): Promise<string> {
    const { onComplete, onError } = options;

    mkdirSync(dirname(mp4Path), { recursive: true });

    return new Promise((resolve, reject) => {
      const child = spawn(
        'ffmpeg',
        ['-y', '-i', gifPath, '-movflags', 'faststart', '-pix_fmt', 'yuv420p', mp4Path],
        { stdio: ['ignore', 'pipe', 'pipe'], detached: false },
      );

      child.stderr?.on('data', () => {
        // ffmpeg는 stderr에 진행상황 출력 — 무시
      });

      child.on('close', (code) => {
        if (code !== 0) {
          const err = new Error(`ffmpeg exited with code ${code}. MP4 conversion failed.`);
          onError?.(err);
          reject(err);
          return;
        }
        onComplete?.(mp4Path);
        resolve(mp4Path);
      });

      child.on('error', (err) => {
        onError?.(err);
        reject(err);
      });
    });
  }
}
