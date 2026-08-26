import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod';
import { ensureGestaltHome, gestaltPath } from '../core/home.js';
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
 * 목록에 넣는 쪽도 같은 이유로 좁다. `registerRepo`를 부르는 자리는 `gestalt pr serve`
 * 하나다 — 사람이 그 레포에서 웹 UI를 직접 띄운 순간이다. `--repo-root`로 다른 레포를
 * 가리켜 그 전제를 비껴가는 길은 CLI가 막는다. 그리고 한 번 들어간 줄을 사람이
 * `repos.json`을 손으로 고쳐야만 뺄 수 있으면 안 되므로 `unregisterRepo`를 함께 둔다. 예전에는 `pr create`가
 * 불렀는데, 그 경로는 MCP `ges_pr`의 `repoRoot`로 이어져 있어서 에이전트가 도구 호출
 * 한 번으로 아무 레포나 목록에 영구히 넣을 수 있었다. 한 번 들어가면 사용자가 전혀
 * 다른 레포에서 `pr serve`를 쳐도 그 레포의 diff와 코멘트가 인증 없는 엔드포인트로
 * 계속 나간다.
 *
 * 이 선택으로 못 하게 되는 것: PR을 만들기만 하고 한 번도 serve를 안 돌린 레포는 다른
 * 레포의 목록에 안 뜬다. 그 레포에서 `pr serve`를 한 번 돌려야 들어온다. 워크트리는
 * 저장소를 공유하므로 본체에서 한 번 돌리면 워크트리에서 만든 PR도 함께 보인다.
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
 * 목록 항목의 모양.
 *
 * 읽을 때 강제한다. 이 `path`는 `new LocalPrEngine(repo.path)`의 cwd가 되고 상세 페이지가
 * 거기서 git을 돌린다. 파일이 손으로 고쳐졌거나 다른 버전이 쓴 모양이면 그 값이 그대로
 * 명령의 작업 디렉토리가 되므로, 파싱만 하고 믿을 자리가 아니다.
 *
 * `path`는 정규화된 절대경로만 받는다 — `..`가 섞인 값은 `normalize`를 거치면 자기 자신과
 * 달라져서 걸린다. 다만 이 검사는 모양만 본다. 그 경로가 열어도 되는 레포인지는 못 가른다.
 */
const registeredRepoSchema = z.object({
  key: z.string().regex(/^[0-9a-f]{8}$/),
  path: z
    .string()
    .min(1)
    .refine((p) => !p.includes('\0'), { message: 'NUL 포함' })
    .refine((p) => isAbsolute(p) && normalize(p) === p, { message: '정규화된 절대경로가 아님' }),
  name: z.string().min(1),
  addedAt: z.string(),
});

/** 목록 파일 자리. 홈 해석은 `core/home.ts`가 한다 */
function registryPath(): string {
  return gestaltPath('repos.json');
}

/** 지금도 디스크에 있는가. 지워진 레포는 목록에 둘 이유가 없다 */
function alive(repo: RegisteredRepo): boolean {
  return existsSync(join(repo.path, '.git'));
}

/** 레포를 가리키는 키. 워크트리 어디서 구해도 같은 값이 나온다 */
export function repoKey(repoRoot: string): string {
  return createHash('sha1').update(gitCommonDir(repoRoot)).digest('hex').slice(0, 8);
}

/**
 * 목록을 읽는다. 모양이 안 맞는 항목은 버린다.
 *
 * 항목 하나가 이상하다고 전체를 버리지는 않는다. 손상된 목록 때문에 서버가 아예 안 뜨는
 * 게 더 나쁘다.
 */
function read(): RegisteredRepo[] {
  const path = registryPath();
  if (!existsSync(path)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const kept: RegisteredRepo[] = [];
  for (const item of parsed) {
    const result = registeredRepoSchema.safeParse(item);
    if (result.success) kept.push(result.data);
  }
  return kept;
}

/** 주인이 안 잡히는 잠금을 부수기까지 */
const LOCK_STALE_MS = 5_000;

/**
 * 주인이 살아 있어도 이만큼 지나면 부순다.
 *
 * pid는 재활용된다. 잠금을 쥔 채 죽은 프로세스의 번호를 남이 물려받으면 살아 있다고
 * 읽혀서 아무도 목록을 못 고치게 된다. 그 자리를 여는 마지막 문이다.
 */
const LOCK_HARD_STALE_MS = 60_000;

const LOCK_WAIT_MS = 2_000;

/** 대기 간격. 바퀴마다 배로 늘리되 이 값에서 멈춘다 */
const LOCK_BACKOFF_START_MS = 5;
const LOCK_BACKOFF_MAX_MS = 100;

/** 동기 대기. 이 파일의 쓰기 경로는 전부 동기라 여기서만 잠깐 멈춘다 */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 잠금 디렉토리 안에 남기는 주인 표식 */
interface LockOwner {
  token: string;
  pid: number;
}

function readOwner(ownerPath: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ownerPath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { token, pid } = parsed as { token?: unknown; pid?: unknown };
    if (typeof token !== 'string' || typeof pid !== 'number') return null;
    return { token, pid };
  } catch {
    // 아직 안 쓰였거나(mkdir 직후) 옛 버전이 쓴 모양이다. 주인을 모르는 것으로 친다
    return null;
  }
}

/** 그 프로세스가 아직 도는가. 신호 0은 아무것도 안 보내고 존재만 묻는다 */
function alivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM은 남의 것이라 못 건드리는 것뿐이다. 그래도 살아는 있다
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 목록을 고치는 동안 다른 프로세스를 막는다.
 *
 * 워크트리 여럿이 같은 목록에 동시에 손대는 게 이 레포의 기본 흐름이다. 잠금 없이
 * 읽고 고쳐 쓰면 나중에 쓴 쪽이 먼저 쓴 쪽의 항목을 덮는다.
 *
 * `mkdir`는 있으면 실패하니까 그 자체가 잠금이다. 쥔 채로 죽은 프로세스가 목록을 영영
 * 못 고치게 만들면 안 되므로 버려진 잠금은 부순다. 부수는 순간에 둘이 겹치면 둘 다
 * `mkdir`을 시도하고 한쪽만 성공한다 — 진 쪽은 다시 기다린다.
 *
 * **버려졌는지는 주인의 pid로 가른다.** 예전에는 잠금 디렉토리의 mtime만 봤는데,
 * 잠금은 잡을 때 한 번 만들어지고 쥔 동안 mtime이 안 올라간다. 그래서 `fn()`이
 * 5초를 넘기면 살아 있는 잠금이 버려진 것으로 보였다. 남이 부수고 들어와 둘이 나란히
 * 읽고 고쳐 써서 늦게 쓴 쪽이 상대 항목을 덮었다. 파일은 rename이라 안 깨지고 등록만
 * 조용히 사라진다.
 *
 * 쥔 동안 mtime을 주기적으로 올리는 방법은 여기서 안 통한다. `fn()`이 통째로 동기라
 * 타이머가 돌 틈이 없다 — 갱신이 필요한 바로 그 순간에 이벤트 루프가 막혀 있다.
 * 대신 주인이 살아 있는지를 직접 묻는다.
 *
 * `fn`에는 `stillMine`을 준다. 부수기와 다시 잡기가 겹치는 좁은 틈이 남아 있어,
 * 쓰기 직전에 잠금이 아직 내 것인지 다시 확인할 수 있어야 한다.
 *
 * 잠금 소유권을 테스트에서 확인할 수 있게 내보낸다. 그 갈래는 잠금을 오래 쥔 쪽과
 * 부순 쪽이 겹쳐야 열리는데, `registerRepo`로는 그 상황을 만들 수 없다.
 */
export function withLock<T>(fn: (ctx: { stillMine: () => boolean }) => T): T {
  const lock = join(ensureGestaltHome(), 'repos.json.lock');
  // 잠금을 누가 쥐고 있는지 적어둔다. 버려진 잠금은 남이 부수고 자기 것을 새로 만드는데,
  // 그때 원래 주인이 끝나며 무조건 지우면 **남의** 잠금을 푼다. 토큰이 내 것일 때만 지운다
  const ownerPath = join(lock, 'owner');
  const token = randomUUID();
  const start = Date.now();
  let waitMs = LOCK_BACKOFF_START_MS;

  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(ownerPath, JSON.stringify({ token, pid: process.pid }), 'utf-8');
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;

      let heldFor: number;
      try {
        heldFor = Date.now() - statSync(lock).mtimeMs;
      } catch {
        // 그 사이에 풀렸다. 다음 바퀴에서 잡는다
        heldFor = 0;
      }
      const owner = readOwner(ownerPath);
      const holderAlive = owner !== null && alivePid(owner.pid);
      const abandoned = heldFor > LOCK_HARD_STALE_MS || (!holderAlive && heldFor > LOCK_STALE_MS);
      if (abandoned) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > LOCK_WAIT_MS) {
        throw new Error('레포 목록이 잠겨 있어서 못 고쳤어요', { cause: e });
      }
      // 바퀴마다 mkdir 실패와 stat이 붙는다. 간격을 배로 늘려 바퀴 수를 줄인다
      sleep(waitMs);
      waitMs = Math.min(waitMs * 2, LOCK_BACKOFF_MAX_MS);
    }
  }

  const stillMine = (): boolean => readOwner(ownerPath)?.token === token;

  try {
    return fn({ stillMine });
  } finally {
    if (stillMine()) rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * 목록을 통째로 바꿔 쓴다.
 *
 * 옆에 다 쓴 뒤 `rename`으로 갈아 끼운다. `writeFileSync`는 자르고 나서 쓰기 때문에 그
 * 사이에 읽는 쪽이 반쯤 쓰인 JSON을 본다. `read()`는 그 예외를 삼키고 빈 목록을 주므로
 * 등록된 레포가 통째로 사라진 것처럼 보인다. `rename`은 원자적이라 읽는 쪽은 항상 이전
 * 목록이나 새 목록 중 하나를 온전히 본다.
 *
 * 0600인 이유는 이 파일에 사용자가 작업하는 비공개 레포의 절대 경로가 모이기 때문이다.
 */
function writeList(repos: RegisteredRepo[]): void {
  const path = registryPath();
  const dir = ensureTmpDir();
  sweepStaleTmp(dir);
  const tmp = join(dir, `repos.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(repos, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 이미 없으면 됐다
    }
    throw e;
  }
}

/**
 * 옆에 쓸 임시 파일을 두는 자리.
 *
 * `~/.gestalt` 바로 아래가 아니라 전용 칸이다. 그 자리에는 이벤트 DB랑 사용자
 * 프로필, 업데이트 캐시가 함께 모이는데 쓸 때마다 그 전부를 훑을 이유가 없다.
 * 항목이 늘수록 스캔도 같이 늘던 자리다.
 *
 * 같은 파일시스템이라 `rename`은 그대로 원자적이다.
 */
function ensureTmpDir(): string {
  const dir = gestaltPath('tmp');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * 쓰다 만 임시 파일을 치운다.
 *
 * pid를 붙여 쓰므로 쓰는 도중 죽으면 그 이름이 영영 남는다. 목록에는 영향이 없지만
 * 디스크에 쌓인다. 잠금 안에서 도니까 지금 쓰는 중인 남의 tmp를 뺏을 일은 없다.
 */
function sweepStaleTmp(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith('repos.json.') || !name.endsWith('.tmp')) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      // 남이 방금 갈아 끼웠다. 없어졌으면 된 것이다
    }
  }
}

/**
 * 레포를 목록에 넣는다. 이미 있으면 경로만 갱신한다.
 *
 * `pr serve`가 부른다. 여기 말고 목록을 늘리는 자리는 없다 — 위 머리말 참고.
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

  return withLock(({ stillMine }) => {
    // 쓸 때 죽은 항목을 걷어내는 건 파일이 무한정 길어지는 걸 막으려는 것뿐이다.
    // 지워진 레포를 안 보여주는 보장은 `listRepos`의 읽기 시점 필터가 진다
    const kept = read().filter((r) => r.key !== key && alive(r));
    assertHeld(stillMine);
    writeList([...kept, entry].sort((a, b) => a.name.localeCompare(b.name)));
    return entry;
  });
}

/**
 * 읽고 고친 값을 쓰기 직전에 잠금이 아직 내 것인지 다시 묻는다.
 *
 * 남이 내 잠금을 부수고 자기 것을 만든 사이라면, 지금 손에 든 목록은 그 사이에 남이
 * 쓴 항목을 안 담고 있다. 그대로 쓰면 상대 등록이 조용히 사라진다. 덮느니 실패한다.
 */
function assertHeld(stillMine: () => boolean): void {
  if (!stillMine()) {
    throw new Error('레포 목록 잠금을 뺏겨서 안 썼어요. 다시 불러주세요');
  }
}

/**
 * 레포를 목록에서 뺀다. 없던 키면 false다.
 *
 * 넣는 문은 좁게 뒀는데 빼는 문이 없으면, 한 번 들어간 레포는 사용자가 손으로
 * `~/.gestalt/repos.json`을 고치기 전까지 인증 없는 뷰어 목록에 남는다.
 */
export function unregisterRepo(key: string): boolean {
  return withLock(({ stillMine }) => {
    const before = read();
    const kept = before.filter((r) => r.key !== key);
    if (kept.length === before.length) return false;
    assertHeld(stillMine);
    writeList(kept);
    return true;
  });
}

/** 지금도 디스크에 있는 레포만 돌려준다. 지워진 자리는 목록에서 뺀다 */
export function listRepos(): RegisteredRepo[] {
  return read().filter(alive);
}
