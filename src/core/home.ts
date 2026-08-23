import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

/**
 * 게슈탈트가 사용자 홈에 두는 자리(`~/.gestalt`)를 한 군데서 정한다.
 *
 * 이벤트 DB랑 사용자 프로필, 업데이트 캐시, 레포 목록이 각자 `homedir()`를 부르면
 * 테스트가 홈을 임시 자리로 돌려놔도 실제로 옮겨지는 건 그중 하나뿐이다. 나머지는
 * 사용자의 진짜 홈에 그대로 쌓인다.
 */

const HOME_ENV = 'GESTALT_HOME';
const DIR_NAME = '.gestalt';

/** 같은 값으로 매번 경고하지 않게 마지막으로 알린 값을 기억한다 */
let warnedValue: string | null = null;

/**
 * `~/.gestalt` 자리. `GESTALT_HOME`이 있으면 그 아래를 쓴다.
 *
 * 절대경로만 받는다. 상대경로는 프로세스가 어디서 떴는지에 따라 다른 자리를 가리키는데,
 * 이 아래에는 인증 없는 웹 UI가 열어 줄 레포 목록이 있다. 어느 레포를 열지가 cwd에 따라
 * 달라지면 안 된다. 절대경로가 아니면 무시하고 진짜 홈으로 돌아간다.
 */
export function gestaltHome(): string {
  const raw = process.env[HOME_ENV];
  if (raw === undefined || raw === '') return join(homedir(), DIR_NAME);

  if (!isAbsolute(raw)) {
    if (warnedValue !== raw) {
      warnedValue = raw;
      process.stderr.write(`[gestalt] ${HOME_ENV}가 절대경로가 아니라 무시해요: ${raw}\n`);
    }
    return join(homedir(), DIR_NAME);
  }

  return join(normalize(raw), DIR_NAME);
}

/** `~/.gestalt` 아래 자리 하나 */
export function gestaltPath(...segments: string[]): string {
  return join(gestaltHome(), ...segments);
}

/**
 * `~/.gestalt`를 만들고 그 경로를 돌려준다.
 *
 * 0700으로 만드는 건 이 아래에 사용자가 작업하는 비공개 레포의 절대 경로랑 프로필이
 * 모이기 때문이다. 공용 호스트라면 다른 로컬 사용자가 그걸 그대로 읽는다. mode는 새로
 * 만드는 디렉토리에만 걸리므로 이미 있던 자리의 권한은 그대로 둔다 — 사용자가 일부러
 * 넓혀 둔 걸 되돌리지 않는다.
 */
export function ensureGestaltHome(): string {
  const dir = gestaltHome();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
