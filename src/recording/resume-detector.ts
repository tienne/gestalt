import { existsSync } from 'node:fs';
import { getFramesPath } from './recording-dir.js';

export interface ResumeInfo {
  isResuming: boolean;
  framesPath: string;
}

/**
 * sessionId에 해당하는 .frames 임시 파일이 존재하는지 확인한다.
 * 존재하면 이전 녹화를 이어붙일 수 있음을 의미한다.
 */
export function detectResume(sessionId: string): ResumeInfo {
  const framesPath = getFramesPath(sessionId);
  return {
    isResuming: existsSync(framesPath),
    framesPath,
  };
}
