import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { gestaltHome } from '../core/home.js';

const PEER_HOME_ENV = 'GESTALT_PEER_HOME';

/**
 * 데몬이 소켓과 상태 DB를 두는 자리. 기본은 `~/.gestalt/peer`이고 테스트는
 * `GESTALT_PEER_HOME`으로 옮긴다.
 *
 * 상대경로는 받지 않고 던진다. `GESTALT_HOME`처럼 진짜 홈으로 돌아가면 테스트가
 * 실수로 사용자의 데몬 소켓에 붙거나 사용자 DB에 쓴다.
 */
export function peerRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[PEER_HOME_ENV];
  if (raw === undefined || raw === '') return join(gestaltHome(), 'peer');
  if (!isAbsolute(raw)) throw new Error(`${PEER_HOME_ENV}는 절대경로여야 해요: ${raw}`);
  return normalize(raw);
}

export function socketPath(root: string): string {
  return join(root, 'peer.sock');
}

export function statePath(root: string): string {
  return join(root, 'state.db');
}

/**
 * 같은 OS 사용자만 들어오게 디렉토리를 0700으로 만든다. 이미 있으면 권한을 다시
 * 좁힌다 — 소켓은 listen과 chmod 사이에 잠깐 기본 권한으로 열려 있어서 그 틈을
 * 막는 건 디렉토리다.
 *
 * 루트가 심링크거나 남의 것이면 거부한다. mkdir과 chmod는 심링크를 따라가서 남이 걸어
 * 둔 링크 끝의 디렉토리에 소켓과 DB를 만들고 권한까지 바꾼다. realpath로 비교하지 않는
 * 건 macOS 임시 디렉토리가 `/var` → `/private/var` 링크 아래라 정상 경로도 걸리기 때문이다.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) throw new Error(`peer 디렉토리가 심링크예요: ${dir}`);
  if (!st.isDirectory()) throw new Error(`peer 디렉토리 자리에 다른 파일이 있어요: ${dir}`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`peer 디렉토리의 주인이 내가 아니에요: ${dir}`);
  }
  chmodSync(dir, 0o700);
}

/** macOS 유닉스 소켓 경로 한도(sun_path 104바이트) */
export const MAX_SOCKET_PATH_BYTES = 103;
