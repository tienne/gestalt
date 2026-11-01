import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  fchmodSync,
  lstatSync,
  openSync,
  readSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { request } from './client.js';
import type { DaemonStatus } from './protocol.js';
import { lockPath, processAlive, readLockPid } from './lock.js';
import { ensurePrivateDir, socketPath } from './paths.js';

/**
 * 떨어져 뜬 데몬의 로그 상한. 데몬은 실패만 stderr에 적어서 평소에는 거의 안 는다. 넘으면 지금 로그를
 * `daemon.log.1`로 복사하고 비운다. 그래서 디스크에 남는 건 상한의 두 배 남짓이다
 */
export const DAEMON_LOG_MAX_BYTES = 1024 * 1024;

/** 떨어져 뜬 데몬이 로그 크기를 보는 간격 */
export const DAEMON_LOG_CHECK_MS = 60_000;

/** `--detach`가 소켓 답을 기다리는 시간과 `--stop`이 프로세스가 끝나길 기다리는 시간의 기본값 */
export const DEFAULT_DAEMON_WAIT_MS = 10_000;

/**
 * `--detach`가 자식에 거는 환경 변수. 자식은 이걸 보고 로그를 돌리고 안내 문구를 바꾼 뒤 지운다.
 * 멈추는 길이나 잠금 규칙은 이 값과 상관없이 같다
 */
export const DETACHED_ENV = 'GESTALT_PEER_DETACHED';

/** 이번 기동부터 로그 꼬리를 자르는 표시 줄의 앞머리 */
const MARKER = '=== gestalt peer daemon --detach';

const POLL_MS = 100;

export function daemonLogPath(root: string): string {
  return join(root, 'daemon.log');
}

/**
 * 로그가 상한을 넘었으면 `.1`로 복사하고 비운다. 이름을 옮기지 않는 건 떠 있는 데몬이 열어 둔 파일을
 * 계속 쓰기 때문이다. 옮기면 데몬은 `.1`에 쓰고 원래 이름의 파일은 다시 안 큰다. 열 때 `O_APPEND`라서
 * 비운 뒤에 쓰는 줄은 파일 앞에서부터 다시 쌓인다. 복사와 비우기 사이에 쓰인 줄은 잃을 수 있다.
 */
export function rotateDaemonLog(path: string, max = DAEMON_LOG_MAX_BYTES): boolean {
  let size: number;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return false;
    size = st.size;
  } catch {
    return false;
  }
  if (size <= max) return false;
  const old = `${path}.1`;
  copyFileSync(path, old);
  chmodSync(old, 0o600);
  truncateSync(path, 0);
  return true;
}

/**
 * 로그를 덧붙이기로 연다. 없으면 0600으로 만들고 있으면 권한을 다시 0600으로 좁힌다. 심링크면 따라가지
 * 않고 실패한다. 디렉토리가 0700이라 남이 링크를 걸 수는 없지만 내가 실수로 둔 링크로 남의 파일을 쓰지
 * 않게 한다
 */
export function openDaemonLog(path: string): number {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`peer 로그 자리에 다른 파일이 있어요: ${path}`);
    fchmodSync(fd, 0o600);
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  return fd;
}

/** 이번 기동의 표시 줄 뒤에서 마지막 몇 줄. 표시 줄이 없으면 끝에서 센다 */
export function logTail(path: string, lines = 20): string[] {
  let text: string;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const at = text.lastIndexOf(MARKER);
  if (at !== -1) text = text.slice(text.indexOf('\n', at) + 1);
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-lines);
}

/**
 * 자식으로 띄울 명령. 지금 프로세스와 같은 Node와 실행 인자에 같은 스크립트를 주고 `peer daemon`만
 * 붙인다. `pnpm tsx bin/gestalt.ts`로 불렀으면 tsx가 건 `--require`, `--import`가 실행 인자에 들어 있어서
 * 그대로 따라간다. 설치본이면 실행 인자는 비고 스크립트가 `dist/bin/gestalt.js`다. 디버거와 감시 옵션은
 * 데몬에 넘기지 않는다. 포트가 겹치거나 파일이 바뀔 때 데몬이 다시 뜬다
 */
export function daemonCommand(
  argv: readonly string[] = process.argv,
  execArgv: readonly string[] = process.execArgv,
  execPath: string = process.execPath,
): string[] {
  const script = argv[1];
  if (!script) throw new Error('gestalt 실행 경로를 못 찾았어요');
  const flags = execArgv.filter((a) => !/^--(inspect|debug|watch)/.test(a));
  return [execPath, ...flags, script, 'peer', 'daemon'];
}

/** 소켓에 답한 데몬 pid. 안 떠 있거나 1초 안에 안 답하면 undefined다 */
export async function answeringDaemonPid(sock: string): Promise<number | undefined> {
  try {
    const res = await request<DaemonStatus>(sock, { op: 'status' }, 1_000);
    return res.ok ? res.result.pid : undefined;
  } catch {
    return undefined;
  }
}

/** 떨어진 데몬이 시한 안에 안 떴을 때. 로그 꼬리를 같이 들고 간다 */
export class DaemonDetachError extends Error {
  constructor(
    message: string,
    readonly log: string,
    readonly tail: string[],
    /** 띄운 자식 pid. 시한이 지났으면 SIGTERM을 보냈다 */
    readonly child?: number,
  ) {
    super(message);
    this.name = 'DaemonDetachError';
  }
}

export interface DetachResult {
  pid: number;
  log: string;
  /** 이미 떠 있던 데몬이면 true. 동시에 띄운 다른 데몬이 잠금을 먼저 잡은 경우도 true다 */
  already: boolean;
  /** 이번에 띄운 자식 pid. 이미 떠 있어서 안 띄웠으면 없다. 동시에 띄워 졌으면 `pid`와 다르다 */
  spawned?: number;
}

export interface DetachOptions {
  root: string;
  waitMs?: number;
  /** 테스트가 바꾼다. 기본은 `daemonCommand()` */
  command?: string[];
  env?: NodeJS.ProcessEnv;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 자식에 넘길 환경. 루트는 부모가 쓴 값으로 고정한다. 부른 Claude Code 세션 표시(`CLAUDE_PID`,
 * `CLAUDE_CODE_SESSION_ID`)는 뺀다. 데몬은 그 세션보다 오래 살아서 그 값이 곧 틀린 값이 된다
 */
export function detachedEnv(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GESTALT_PEER_HOME: root, [DETACHED_ENV]: '1' };
  delete out['CLAUDE_PID'];
  delete out['CLAUDE_CODE_SESSION_ID'];
  return out;
}

export function assertDetachSupported(platform: NodeJS.Platform = process.platform): void {
  // 데몬이 유닉스 소켓과 0700 디렉토리 권한에 기대고 훅도 bash다. Windows에서는 데몬 자체가 안 돈다
  if (platform === 'win32') {
    throw new Error('peer 데몬은 macOS와 Linux에서만 떠요. Windows는 지원하지 않아요');
  }
}

/**
 * 데몬을 이 프로세스와 떨어진 새 프로세스 세션으로 띄우고 소켓이 답할 때까지 기다린다.
 *
 * 이미 떠 있는지는 소켓 답으로 본다. 둘이 동시에 불러 둘 다 자식을 띄워도 잠금(`peer.lock`)을 하나만
 * 잡으므로 데몬은 하나다. 진 자식은 "이미 떠 있어요"로 끝나고 그 부모는 이긴 데몬의 pid를 `already`로
 * 받는다. 시한이 지나면 아직 살아 있는 내 자식에 SIGTERM을 보내고 로그 꼬리와 함께 던진다. 늦게라도
 * 뜬 데몬이 실패 보고 뒤에 남지 않게 하려는 것이다.
 */
export async function detachDaemon(options: DetachOptions): Promise<DetachResult> {
  assertDetachSupported();
  const { root } = options;
  const waitMs = options.waitMs ?? DEFAULT_DAEMON_WAIT_MS;
  ensurePrivateDir(root);
  const sock = socketPath(root);
  const log = daemonLogPath(root);

  const running = await answeringDaemonPid(sock);
  if (running !== undefined) return { pid: running, log, already: true };

  rotateDaemonLog(log);
  const [cmd, ...args] = options.command ?? daemonCommand();
  if (!cmd) throw new Error('띄울 명령이 비었어요');
  const fd = openDaemonLog(log);
  let child: ChildProcess;
  try {
    writeSync(fd, `${MARKER} ${new Date().toISOString()} ===\n`);
    child = spawn(cmd, args, {
      detached: true,
      stdio: ['ignore', fd, fd],
      // 데몬은 부른 워크트리보다 오래 산다. 그 디렉토리를 붙잡지 않게 데몬 루트에서 띄운다
      cwd: root,
      env: detachedEnv(options.env ?? process.env, root),
    });
  } finally {
    // 자식이 제 사본을 들고 있다. 부모 것은 닫아야 부모가 끝날 때 붙잡는 게 없다
    closeSync(fd);
  }
  child.unref();
  let exited = false;
  let spawnError: Error | undefined;
  child.once('exit', () => {
    exited = true;
  });
  child.once('error', (err) => {
    spawnError = err;
    exited = true;
  });

  const fail = (message: string): never => {
    throw new DaemonDetachError(message, log, logTail(log), child.pid);
  };
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const pid = await answeringDaemonPid(sock);
    if (pid !== undefined) {
      return { pid, log, already: pid !== child.pid, ...(child.pid ? { spawned: child.pid } : {}) };
    }
    if (spawnError) fail(`peer 데몬을 못 띄웠어요: ${spawnError.message}`);
    if (exited) {
      // 다른 데몬이 잠금을 쥐고 뜨는 중이면 그 소켓을 마저 기다린다
      const holder = readLockPid(root);
      if (holder === undefined || holder === child.pid || !processAlive(holder)) {
        fail('peer 데몬이 뜨다가 끝났어요');
      }
    }
    await sleep(POLL_MS);
  }
  if (!exited && child.pid !== undefined) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      // 그새 끝났다
    }
  }
  const holder = readLockPid(root);
  const secs = Math.round(waitMs / 100) / 10;
  if (exited && holder !== undefined && holder !== child.pid && processAlive(holder)) {
    fail(
      `peer 데몬이 ${secs}초 안에 안 떴어요. 잠금(${lockPath(root)})을 쥔 pid ${holder}가 소켓에 답하지 않아요`,
    );
  }
  return fail(`peer 데몬이 ${secs}초 안에 안 떴어요`);
}

export interface StopResult {
  /** 멈춘 데몬 pid. 안 떠 있었으면 null */
  pid: number | null;
  stopped: boolean;
  /** 안 떠 있었는데 잠금 파일에 산 프로세스 pid가 적혀 있으면 그 값. 신호는 안 보냈다 */
  lockPid?: number;
}

/**
 * 데몬에 SIGTERM을 보내고 끝나길 기다린다. 신호를 보내기 전에 소켓에 답한 데몬 pid와 잠금 파일의 pid가
 * 같은지 본다. 잠금 pid만 믿으면 데몬이 죽고 그 pid를 받은 다른 프로세스를 끌 수 있다. 소켓 답만 믿지
 * 않는 건 잠금을 안 쥔 프로세스가 소켓 자리에 답하는 경우를 막으려는 것이다.
 *
 * 데몬의 SIGTERM 처리는 `peer daemon` 전경 실행과 같다. 정리 중에 신호를 한 번 더 받으면 기다리지 않고
 * 끝난다. 시한 안에 안 끝나면 그 pid를 알려 주고 실패한다. `--stop`을 다시 불러도 소켓은 이미 닫혀 있어서
 * 신호를 안 보낸다.
 */
export async function stopDaemon(options: { root: string; waitMs?: number }): Promise<StopResult> {
  const { root } = options;
  const waitMs = options.waitMs ?? DEFAULT_DAEMON_WAIT_MS;
  const pid = await answeringDaemonPid(socketPath(root));
  if (pid === undefined) {
    const holder = readLockPid(root);
    return holder !== undefined && processAlive(holder)
      ? { pid: null, stopped: false, lockPid: holder }
      : { pid: null, stopped: false };
  }
  const holder = readLockPid(root);
  if (holder !== pid) {
    throw new Error(
      `소켓에 답한 데몬(pid ${pid})과 잠금 파일(${lockPath(root)})의 pid(${holder ?? '없음'})가 달라서 신호를 안 보냈어요`,
    );
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return { pid, stopped: true };
    await sleep(POLL_MS);
  }
  const secs = Math.round(waitMs / 100) / 10;
  throw new Error(
    `peer 데몬(pid ${pid})이 ${secs}초 안에 안 멈췄어요. \`kill ${pid}\`로 신호를 한 번 더 보내면 정리를 기다리지 않고 끝나요`,
  );
}
