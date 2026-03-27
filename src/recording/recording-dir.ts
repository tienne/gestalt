import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const RECORDINGS_BASE_DIR = '.gestalt/recordings';

/** sessionId에 대한 .frames 파일 경로를 반환하고, 부모 디렉토리가 없으면 생성한다 */
export function ensureRecordingsDir(): void {
  if (!existsSync(RECORDINGS_BASE_DIR)) {
    mkdirSync(RECORDINGS_BASE_DIR, { recursive: true });
  }
}

export function getFramesPath(sessionId: string): string {
  return join(RECORDINGS_BASE_DIR, `${sessionId}.frames`);
}
