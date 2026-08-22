import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitCommonDir } from './git.js';

/**
 * 로컬 PR을 가진 레포 목록.
 *
 * 웹 UI 하나가 여러 레포를 보여주려면 어떤 레포가 있는지 알아야 한다. 그런데 그
 * 목록을 요청이 정하게 두면 안 된다. 이 서버는 인증이 없다 — 요청이 레포 경로를
 * 지정할 수 있으면 "이 머신의 아무 git 레포나 HTTP로 읽는" 도구가 된다.
 *
 * 그래서 목록은 서버가 시작할 때 아는 닫힌 집합이다. URL에는 경로가 아니라 키만
 * 실리므로 요청으로 새 자리를 가리킬 방법이 없다.
 *
 * `~/.gestalt/`에 두는 건 이미 있는 관행이다 — events.db와 사용자 프로필이 거기 있다.
 */

export interface RegisteredRepo {
  /** 공용 git 디렉토리의 해시. URL에 실리는 값이라 경로가 안 드러난다 */
  key: string;
  path: string;
  name: string;
  addedAt: string;
}

/**
 * 목록 파일 자리.
 *
 * `GESTALT_HOME`을 보는 이유는 테스트 때문이다. `pr create`가 이 목록에 자기 레포를
 * 넣는데, 테스트는 임시 레포에서 PR을 만든다 — 그대로 두면 테스트를 돌릴 때마다
 * 사용자의 진짜 홈에 곧 사라질 경로가 쌓인다.
 */
function registryPath(): string {
  return join(process.env['GESTALT_HOME'] ?? homedir(), '.gestalt', 'repos.json');
}

/** 지금도 디스크에 있는가. 지워진 레포는 목록에 둘 이유가 없다 */
function alive(repo: RegisteredRepo): boolean {
  return existsSync(join(repo.path, '.git'));
}

/** 레포를 가리키는 키. 워크트리 어디서 구해도 같은 값이 나온다 */
export function repoKey(repoRoot: string): string {
  return createHash('sha1').update(gitCommonDir(repoRoot)).digest('hex').slice(0, 8);
}

function read(): RegisteredRepo[] {
  const path = registryPath();
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as RegisteredRepo[]) : [];
  } catch {
    // 손상된 목록 때문에 서버가 안 뜨는 게 더 나쁘다. 빈 목록으로 시작한다
    return [];
  }
}

/**
 * 레포를 목록에 넣는다. 이미 있으면 경로만 갱신한다.
 *
 * 읽고 고쳐 쓰는 방식이라 두 프로세스가 동시에 부르면 한쪽이 밀릴 수 있다. 그때는
 * 다음 `pr create`가 다시 넣는다 — 목록이 늦게 채워질 뿐 잘못된 값이 남지는 않는다.
 */
export function registerRepo(repoRoot: string): RegisteredRepo {
  const key = repoKey(repoRoot);
  const main = dirname(gitCommonDir(repoRoot));
  const entry: RegisteredRepo = {
    key,
    path: main,
    name: main.split('/').filter(Boolean).at(-1) ?? main,
    addedAt: new Date().toISOString(),
  };

  // 쓸 때마다 죽은 항목을 걷어낸다. 안 그러면 사라진 레포가 파일에 영영 쌓인다
  const kept = read().filter((r) => r.key !== key && alive(r));
  const next = [...kept, entry].sort((a, b) => a.name.localeCompare(b.name));

  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');

  return entry;
}

/** 지금도 디스크에 있는 레포만 돌려준다. 지워진 자리는 목록에서 뺀다 */
export function listRepos(): RegisteredRepo[] {
  return read().filter(alive);
}
