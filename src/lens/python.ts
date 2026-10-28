import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 렌즈 전용 가상환경. 시스템 파이썬의 pip가 오래돼 새 휠을 못 받는 머신에서 여기에 설치한다 */
export const LENS_VENV = join(homedir(), '.local', 'share', 'gestalt', 'lens-venv');

export const LENS_PY_INSTALL =
  `python3 -m venv ${LENS_VENV} && ${join(LENS_VENV, 'bin', 'python')} -m pip install --upgrade pip && ` +
  `${join(LENS_VENV, 'bin', 'python')} -m pip install pdfplumber trafilatura faster-whisper sherpa-onnx`;

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

/** 화자 구분 모델 자리. GESTALT_LENS_MODELS가 있으면 그 절대 경로를 쓴다 */
export function lensModelsDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.GESTALT_LENS_MODELS?.trim();
  if (fromEnv) {
    if (!fromEnv.startsWith('/')) {
      throw new Error(`GESTALT_LENS_MODELS는 절대 경로여야 해요: ${fromEnv}`);
    }
    return fromEnv;
  }
  return join(homedir(), '.local', 'share', 'gestalt', 'lens-models');
}

/**
 * 화자 구분에 쓰는 두 모델. sherpa-onnx가 GitHub 릴리스로 내준 파일이라 토큰 없이 받는다.
 * 구간 분할은 pyannote segmentation 3.0을 ONNX로 옮긴 것이고 화자 임베딩은 wespeaker ResNet34(VoxCeleb)다.
 * 릴리스 태그가 버전으로 고정돼 있지 않아 받은 파일의 sha256을 여기 박아 둔 값과 맞춰 본다
 */
export const DIARIZE_MODELS = {
  segmentation: {
    archive:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
    /** 압축 파일의 해시다. 풀린 model.onnx가 아니다 */
    sha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488',
    bytes: 6_958_444,
    file: join('sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx'),
  },
  embedding: {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx',
    sha256: '5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94',
    bytes: 26_534_365,
    file: 'wespeaker_en_voxceleb_resnet34.onnx',
  },
} as const;
