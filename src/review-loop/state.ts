import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * 라운드 사이에 남겨야 하는 값만 파일로 둔다.
 *
 * 스레드 스냅샷은 여기 없다. 조회와 집계가 한 프로세스 안에서 끝나므로 중간 파일이
 * 생기지 않는다. 그 파일이 이번 조회의 것인지 가리던 표식과 신선도 검사도 함께 사라졌다.
 */
export const LOGIN_FILE = 'my-login';
export const ROUND_FILE = 'round';
export const VERDICTS_FILE = 'verdicts';
export const REVIEWED_HEAD_FILE = 'reviewed-head';
export const ROUND_START_HEAD_FILE = 'round-start-head';

/**
 * 라운드 상태를 두는 자리.
 *
 * git 디렉토리 아래다 — git 이 절대 추적하지 않는 자리이고 절대 경로라 cwd 가 어디든 같은 곳을
 * 가리킨다. 워킹트리 안에 두면 이 스킬이 플러그인으로 배포돼 도는 남의 레포에서
 * 무시되지 않아 리뷰 대상 diff 에 상태 파일이 섞인다.
 *
 * `--git-common-dir` 이라 워크트리 여럿이 같은 자리를 공유하지만 PR 번호가 하위
 * 디렉토리로 갈라 안 겹친다.
 */
export function stateDir(prNumber: number, cwd = process.cwd()): string {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`PR 번호가 양의 정수가 아니다: ${prNumber}`);
  }
  // 레포 루트에서 부르면 `.git` 이라는 상대 경로가 온다. cwd 가 바뀐 단계에서 다른
  // 자리를 가리키므로 여기서 절대 경로로 굳힌다 (--path-format=absolute 는 git 2.31+).
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf-8',
  }).trim();
  return resolve(cwd, common, 'gestalt-review-loop', `pr-${prNumber}`);
}
