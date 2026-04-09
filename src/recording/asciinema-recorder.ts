import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * AsciinemaRecorder: self-respawn 패턴으로 asciinema 녹화를 구현한다.
 *
 * --record 플래그가 있고 GESTALT_RECORDING 환경변수가 없으면,
 * 현재 프로세스를 asciinema rec으로 감싸서 재실행한다.
 * 재실행된 프로세스는 GESTALT_RECORDING=1로 실행되므로 일반 인터뷰 로직을 수행한다.
 */
export class AsciinemaRecorder {
  /** 이미 asciinema로 감싸진 상태인지 확인 */
  static isInsideRecording(): boolean {
    return process.env['GESTALT_RECORDING'] === '1';
  }

  /** 현재 녹화 중인 cast 파일 경로 (GESTALT_CAST_PATH 환경변수) */
  static getCurrentCastPath(): string | undefined {
    return process.env['GESTALT_CAST_PATH'];
  }

  /**
   * 임시 cast 파일 경로를 생성한다.
   * 실제 파일명은 인터뷰 완료 후 topic 기반으로 rename된다.
   */
  static createTempCastPath(recordingsDir = '.gestalt/recordings'): string {
    mkdirSync(recordingsDir, { recursive: true });
    return `${recordingsDir}/tmp-${randomUUID()}.cast`;
  }

  /**
   * asciinema rec으로 현재 프로세스를 재실행한다.
   * 이 함수는 return하지 않는다 (spawnSync가 블로킹).
   *
   * @param castPath - 녹화 결과를 저장할 .cast 파일 경로
   */
  static respawnWithAsciinema(castPath: string): void {
    // 현재 process.argv에서 node 실행파일을 제외한 스크립트 + 인자
    const [, ...scriptAndArgs] = process.argv;
    // --record, -r 플래그 제거 (재실행 시 무한루프 방지)
    const filteredArgs = (scriptAndArgs ?? []).filter((a) => a !== '--record' && a !== '-r');

    mkdirSync(dirname(castPath), { recursive: true });

    const result = spawnSync(
      'asciinema',
      ['rec', '--overwrite', castPath, '--', 'node', ...filteredArgs],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          GESTALT_RECORDING: '1',
          GESTALT_CAST_PATH: castPath,
        },
      },
    );

    process.exit(result.status ?? 0);
  }
}
