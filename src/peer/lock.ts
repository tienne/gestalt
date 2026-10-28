import {
  closeSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

export interface DaemonLock {
  path: string;
  dev: number;
  ino: number;
}

/**
 * 잠금 파일이 막 생긴 뒤 소켓이 아직 안 열렸어도 살아 있는 데몬으로 치는 시간. 이보다
 * 오래됐는데 소켓이 답하지 않으면 pid가 다른 프로세스에 다시 쓰인 걸로 보고 치운다.
 */
export const LOCK_GRACE_MS = 10_000;

export function lockPath(root: string): string {
  return join(root, 'peer.lock');
}

/**
 * 데몬 잠금. 이걸 쥔 데몬만 소켓 자리를 확인하고 치우고 만든다.
 *
 * 남은 잠금 파일을 치우는 규칙:
 * 1. 적힌 pid가 없는 프로세스면 남은 것이다.
 * 2. pid가 살아 있어도 잠금이 `LOCK_GRACE_MS`보다 오래됐고 소켓이 답하지 않으면 남은 것이다
 *    (데몬이 죽고 그 pid를 다른 프로세스가 받은 경우).
 * 3. 남은 잠금은 지우지 않고 내 이름으로 옮긴 뒤 옮긴 파일이 내가 읽은 그 파일인지 본다.
 *    그 사이 다른 데몬이 남은 잠금을 치우고 새로 잡았으면 옮긴 게 그 데몬의 잠금이라 같은
 *    이름으로 되돌리고 물러난다. 옮기기는 한쪽만 성공하므로 둘이 같은 남은 잠금을 동시에
 *    치워도 둘 다 잠금을 쥐었다고 믿지 않는다.
 *
 * 되돌리는 사이에 세 번째 데몬이 빈 자리에 잠금을 만들면 그 데몬과 원래 데몬이 함께 쥔다.
 * 남은 잠금 하나를 데몬 셋이 같은 순간에 치울 때만 생기는 틈이다.
 */
export async function acquireDaemonLock(root: string, sock: string): Promise<DaemonLock> {
  const path = lockPath(root);
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      await clearStaleLock(path, sock);
      continue;
    }
    try {
      writeSync(fd, `${process.pid}\n${Date.now()}\n`);
    } finally {
      closeSync(fd);
    }
    const st = lstatSync(path);
    return { path, dev: st.dev, ino: st.ino };
  }
  throw new Error(`데몬 잠금을 못 잡았어요: ${path}`);
}

/** 내 잠금일 때만 지운다. 이미 다른 데몬이 그 자리를 잡았으면 안 건드린다 */
export function releaseDaemonLock(lock: DaemonLock): void {
  try {
    const st = lstatSync(lock.path);
    if (st.dev === lock.dev && st.ino === lock.ino) unlinkSync(lock.path);
  } catch {
    // 이미 없으면 그만이다
  }
}

async function clearStaleLock(path: string, sock: string): Promise<void> {
  let st;
  let text: string;
  try {
    st = lstatSync(path);
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!st.isFile()) throw new Error(`잠금 파일 자리에 다른 파일이 있어요: ${path}`);
  const [pidLine, atLine] = text.split('\n');
  const pid = Number(pidLine);
  const at = Number(atLine);
  if (Number.isSafeInteger(pid) && pid > 0 && processAlive(pid)) {
    const young = Number.isFinite(at) && Date.now() - at < LOCK_GRACE_MS;
    if (young || (await socketAnswers(sock))) {
      throw new Error(`데몬이 이미 떠 있어요 (pid ${pid}): ${sock}`);
    }
  }

  const aside = `${path}.${process.pid}.stale`;
  try {
    renameSync(path, aside);
  } catch (err) {
    // 다른 데몬이 먼저 옮겼다. 처음부터 다시 본다
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const moved = lstatSync(aside);
  if (moved.dev !== st.dev || moved.ino !== st.ino) {
    try {
      linkSync(aside, path);
    } catch {
      // 그새 또 다른 데몬이 잡았다. 그쪽 잠금이 남는다
    }
    unlinkSync(aside);
    throw new Error(`다른 데몬이 같이 뜨는 중이에요: ${sock}`);
  }
  unlinkSync(aside);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // 남의 프로세스면 EPERM이다. 살아 있다
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function socketAnswers(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = createConnection(sock);
    const timer = setTimeout(() => {
      c.destroy();
      resolve(false);
    }, 1_000);
    c.once('connect', () => {
      clearTimeout(timer);
      c.destroy();
      resolve(true);
    });
    c.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
