import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 주인이 안 잡히는 잠금을 부수기까지 */
const LOCK_STALE_MS = 5_000;

/**
 * 주인이 살아 있어도 이만큼 지나면 부순다.
 *
 * pid는 재활용된다. 잠금을 쥔 채 죽은 프로세스의 번호를 남이 물려받으면 살아 있다고
 * 읽혀서 아무도 파일을 못 고치게 된다. 그 자리를 여는 마지막 문이다.
 */
const LOCK_HARD_STALE_MS = 60_000;

const LOCK_WAIT_MS = 2_000;

/** 대기 간격. 바퀴마다 배로 늘리되 이 값에서 멈춘다 */
const LOCK_BACKOFF_START_MS = 5;
const LOCK_BACKOFF_MAX_MS = 100;

/** 동기 대기. 잠금을 쓰는 쓰기 경로가 전부 동기라 여기서만 잠깐 멈춘다 */
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

export interface FileLockOptions {
  /** 기다리다 포기할 때 던질 에러 메시지 */
  busyMessage?: string;
}

/**
 * 파일 하나를 읽고 고쳐 쓰는 동안 다른 프로세스를 막는다.
 *
 * 워크트리 여럿이 같은 파일에 동시에 손대는 게 이 레포의 기본 흐름이다. 잠금 없이
 * 읽고 고쳐 쓰면 나중에 쓴 쪽이 먼저 쓴 쪽의 항목을 덮는다.
 *
 * `mkdir`는 있으면 실패하니까 그 자체가 잠금이다. 쥔 채로 죽은 프로세스가 파일을 영영
 * 못 고치게 만들면 안 되므로 버려진 잠금은 부순다. 부수는 순간에 둘이 겹치면 둘 다
 * `mkdir`을 시도하고 한쪽만 성공한다 — 진 쪽은 다시 기다린다.
 *
 * **버려졌는지는 주인의 pid로 가른다.** 예전에는 잠금 디렉토리의 mtime만 봤는데,
 * 잠금은 잡을 때 한 번 만들어지고 쥔 동안 mtime이 안 올라간다. 그래서 `fn()`이
 * 5초를 넘기면 살아 있는 잠금이 버려진 것으로 보였다. 남이 부수고 들어와 둘이 나란히
 * 읽고 고쳐 써서 늦게 쓴 쪽이 상대 항목을 덮었다. 파일은 rename이라 안 깨지고 항목만
 * 조용히 사라진다.
 *
 * 쥔 동안 mtime을 주기적으로 올리는 방법은 여기서 안 통한다. `fn()`이 통째로 동기라
 * 타이머가 돌 틈이 없다 — 갱신이 필요한 바로 그 순간에 이벤트 루프가 막혀 있다.
 * 대신 주인이 살아 있는지를 직접 묻는다.
 *
 * `fn`에는 `stillMine`을 준다. 부수기와 다시 잡기가 겹치는 좁은 틈이 남아 있어,
 * 쓰기 직전에 잠금이 아직 내 것인지 다시 확인할 수 있어야 한다.
 *
 * @param lockPath 잠금으로 쓸 디렉토리 경로. 부모 디렉토리는 없으면 만든다
 */
export function withFileLock<T>(
  lockPath: string,
  fn: (ctx: { stillMine: () => boolean }) => T,
  options: FileLockOptions = {},
): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  // 잠금을 누가 쥐고 있는지 적어둔다. 버려진 잠금은 남이 부수고 자기 것을 새로 만드는데,
  // 그때 원래 주인이 끝나며 무조건 지우면 **남의** 잠금을 푼다. 토큰이 내 것일 때만 지운다
  const ownerPath = join(lockPath, 'owner');
  const token = randomUUID();
  const start = Date.now();
  let waitMs = LOCK_BACKOFF_START_MS;

  for (;;) {
    try {
      mkdirSync(lockPath);
      writeFileSync(ownerPath, JSON.stringify({ token, pid: process.pid }), 'utf-8');
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;

      let heldFor: number;
      try {
        heldFor = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        // 그 사이에 풀렸다. 다음 바퀴에서 잡는다
        heldFor = 0;
      }
      const owner = readOwner(ownerPath);
      const holderAlive = owner !== null && alivePid(owner.pid);
      const abandoned = heldFor > LOCK_HARD_STALE_MS || (!holderAlive && heldFor > LOCK_STALE_MS);
      if (abandoned) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > LOCK_WAIT_MS) {
        throw new Error(options.busyMessage ?? `잠겨 있어서 못 고쳤어요: ${lockPath}`, {
          cause: e,
        });
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
    if (stillMine()) rmSync(lockPath, { recursive: true, force: true });
  }
}
