import { resolve } from 'node:path';
import { gestaltPath } from '../core/home.js';

/**
 * 상태 저장소 위치. 플래그, 환경 변수, 설정, 기본값 순서로 정한다.
 * 저장소를 쓰는 명령과 읽기만 하는 뷰어가 같은 자리를 보도록 한 곳에 둔다.
 */
export function resolveStateDir(
  flag: string | undefined,
  config: { stateDir?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(
    flag ?? env['GESTALT_CONDUCTOR_STATE_DIR'] ?? config.stateDir ?? gestaltPath('conductor'),
  );
}
