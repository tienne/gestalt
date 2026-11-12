import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_RE } from './intake.js';

/**
 * 여러 주문에 걸쳐 쓰는 레포 공통 맥락 파일.
 *
 * 상태 저장소 아래 `context/<owner>/<name>.md`에 둔다. 워커 지시서가 이미 `--state-dir`로
 * 저장소 경로를 넘기니 따로 경로 설정이 없어도 워커가 같은 파일을 찾는다. 설정에서 경로를
 * 받게 하면 레포 gestalt.json이 남의 경로로 바꾸지 못하게 또 막아야 해서 그 칸은 두지 않는다.
 */
export const CONTEXT_DIR = 'context';

export function repoContextPath(stateDir: string, repo: string): string {
  if (!REPO_RE.test(repo)) throw new Error(`레포는 owner/name 꼴로 적어 주세요: ${repo}`);
  const [owner, name] = repo.split('/') as [string, string];
  if (owner === '.' || owner === '..' || name === '.' || name === '..')
    throw new Error(`레포 이름으로 쓸 수 없어요: ${repo}`);
  return join(stateDir, CONTEXT_DIR, owner, `${name}.md`);
}

/** 파일이 있을 때만 경로를 돌려준다. 없는 파일을 워커에 읽으라고 하지 않는다 */
export function existingRepoContext(stateDir: string, repo: string): string | undefined {
  const path = repoContextPath(stateDir, repo);
  return existsSync(path) ? path : undefined;
}
