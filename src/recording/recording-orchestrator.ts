import { AsciinemaInstaller } from './asciinema-installer.js';
import { AsciinemaRecorder } from './asciinema-recorder.js';
import { AggInstaller } from './agg-installer.js';
import { AggConverter } from './agg-converter.js';
import { FilenameGenerator } from './filename-generator.js';
import type { LLMAdapter } from '../llm/types.js';

export interface RecordingOptions {
  /** --record 또는 -r 플래그 */
  record?: boolean;
  /** --mp4 플래그 — GIF와 함께 mp4도 생성 */
  mp4?: boolean;
  /** 출력 디렉토리 (기본값: 현재 디렉토리) */
  outputDir?: string;
}

/**
 * RecordingOrchestrator: asciinema 기반 녹화의 전체 생명주기를 조율한다.
 *
 * 사용 패턴 (interview CLI):
 *
 * 1. startIfNeeded() — interview 시작 전 호출. --record 플래그가 있고
 *    아직 asciinema로 감싸지지 않았으면 self-respawn으로 재실행.
 *
 * 2. stopAndConvert() — interview 완료 후 호출. 백그라운드 비동기로
 *    .cast → GIF (→ mp4) 변환을 트리거한다.
 */
export class RecordingOrchestrator {
  private readonly asciinemaInstaller = new AsciinemaInstaller();
  private readonly aggInstaller = new AggInstaller();
  private readonly converter = new AggConverter();

  constructor(private readonly llm: LLMAdapter) {}

  /**
   * 필요하면 asciinema 녹화를 시작한다.
   * - GESTALT_RECORDING=1이면 이미 asciinema 안에 있으므로 아무것도 하지 않음.
   * - --record 플래그가 있으면 asciinema를 설치하고 self-respawn.
   * - 재실행 후에는 process.exit()이 호출되므로 이 함수는 return하지 않을 수 있음.
   */
  async startIfNeeded(options: RecordingOptions): Promise<void> {
    if (!options.record) return;
    if (AsciinemaRecorder.isInsideRecording()) return;

    await this.asciinemaInstaller.ensureInstalled();

    const castPath = AsciinemaRecorder.createTempCastPath();
    console.log('📹 Starting asciinema recording...\n');
    AsciinemaRecorder.respawnWithAsciinema(castPath);
    // respawnWithAsciinema calls process.exit() — 이 줄은 실행되지 않음
  }

  /**
   * 현재 프로세스가 asciinema로 녹화 중인지 확인.
   * GESTALT_CAST_PATH 환경변수가 있으면 true.
   */
  isRecording(): boolean {
    return AsciinemaRecorder.isInsideRecording() && !!AsciinemaRecorder.getCurrentCastPath();
  }

  /**
   * 녹화를 종료하고 GIF (+ mp4) 변환을 백그라운드로 트리거한다.
   * asciinema는 부모 프로세스(respawned)에서 자동 종료되므로
   * 여기서는 cast 파일 경로를 읽어 변환만 시작한다.
   *
   * @param topic - 인터뷰 주제 (파일명 생성용)
   * @param sessionId - 세션 ID (파일명 생성용)
   * @param options - 녹화 옵션
   */
  async stopAndConvert(topic: string, sessionId: string, options: RecordingOptions = {}): Promise<void> {
    const castPath = AsciinemaRecorder.getCurrentCastPath();
    if (!castPath) return;

    try {
      await this.aggInstaller.ensureInstalled();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`⚠️  agg installation failed: ${msg}`);
      console.error('  GIF conversion skipped. The .cast file is preserved at:', castPath);
      return;
    }

    const filenameGen = new FilenameGenerator(this.llm, { outputDir: options.outputDir });
    const gifPath = await filenameGen.generate(topic, sessionId);

    console.log('\n🎬 Converting recording to GIF in background...');

    // 백그라운드 비동기 — await하지 않음
    void this.converter
      .convertAsync(castPath, gifPath, {
        deleteCastAfter: true,
        onComplete: (outputPath) => {
          console.log(`✅ GIF saved: ${outputPath}\n`);
          if (options.mp4) {
            const mp4Path = outputPath.replace(/\.gif$/, '.mp4');
            void this.converter.convertGifToMp4Async(outputPath, mp4Path, {
              onComplete: (p) => console.log(`✅ MP4 saved: ${p}\n`),
              onError: (e) => console.error(`⚠️  MP4 conversion failed: ${e.message}`),
            });
          }
        },
        onError: (err) => {
          console.error(`⚠️  GIF conversion failed: ${err.message}`);
          console.error('  The .cast file may be preserved at:', castPath);
        },
      })
      .catch(() => {
        // onError에서 처리됨
      });
  }
}
