import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 렌즈 전용 가상환경. 시스템 파이썬의 pip가 오래돼 새 휠을 못 받는 머신에서 여기에 설치한다 */
export const LENS_VENV = join(homedir(), '.local', 'share', 'gestalt', 'lens-venv');

export const LENS_PY_INSTALL =
  `python3 -m venv ${LENS_VENV} && ${join(LENS_VENV, 'bin', 'python')} -m pip install --upgrade pip && ` +
  `${join(LENS_VENV, 'bin', 'python')} -m pip install pdfplumber trafilatura faster-whisper`;

/**
 * 렌즈 추출에 쓸 파이썬. GESTALT_LENS_PYTHON이 있으면 그 값을, 없으면 렌즈 가상환경을, 그것도 없으면 python3를 쓴다.
 * 환경 변수는 절대 경로만 받는다. 상대 경로면 남의 레포 안 같은 이름 파일이 대신 돌 수 있다
 */
export function lensPython(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.GESTALT_LENS_PYTHON?.trim();
  if (fromEnv) {
    if (!fromEnv.startsWith('/')) {
      throw new Error(`GESTALT_LENS_PYTHON은 절대 경로여야 해요: ${fromEnv}`);
    }
    return fromEnv;
  }
  const venv = join(LENS_VENV, 'bin', 'python');
  return existsSync(venv) ? venv : 'python3';
}

/** 모듈이 없을 때 설치 안내. 어떤 모듈이 빠졌는지 stderr에서 읽는다 */
export function missingModuleHint(stderr: string): string | null {
  const m = /No module named ['"]([A-Za-z0-9_.]+)/.exec(stderr);
  if (!m) return null;
  return `파이썬 모듈 ${m[1]!}이 없어요. 아래 명령으로 렌즈 가상환경을 만든 뒤 다시 돌려 주세요.\n${LENS_PY_INSTALL}`;
}
