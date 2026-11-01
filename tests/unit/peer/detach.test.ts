import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  answeringDaemonPid,
  assertDetachSupported,
  DAEMON_LOG_MAX_BYTES,
  DaemonDetachError,
  daemonCommand,
  daemonLogPath,
  detachDaemon,
  detachedEnv,
  type DetachResult,
  logTail,
  openDaemonLog,
  rotateDaemonLog,
  stopDaemon,
} from '../../../src/peer/detach.js';
import { lockPath, processAlive, readLockPid } from '../../../src/peer/lock.js';
import { socketPath } from '../../../src/peer/paths.js';

const require = createRequire(import.meta.url);
/** `pnpm tsx`가 거는 것과 같은 절대 경로 실행 인자. 자식이 cwd와 상관없이 tsx를 찾는다 */
const TSX_FLAGS = [
  '--require',
  require.resolve('tsx/preflight'),
  '--import',
  pathToFileURL(require.resolve('tsx')).href,
];
const BIN = resolve('bin/gestalt.ts');
/** tsx가 CLI 전체를 처음 옮기는 데 몇 초 걸린다. 테스트가 같이 돌면 더 걸려서 넉넉하게 둔다 */
const BOOT_WAIT_SECS = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitDead(pid: number, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await sleep(100);
  }
  return !processAlive(pid);
}

function killQuietly(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 이미 없다
  }
}

describe('데몬 로그', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pdlog-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('새로 만들면 0600이고 있던 파일의 권한도 0600으로 좁힌다', () => {
    const log = daemonLogPath(dir);
    closeSync(openDaemonLog(log));
    expect(statSync(log).mode & 0o777).toBe(0o600);
    chmodSync(log, 0o644);
    closeSync(openDaemonLog(log));
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  it('심링크면 따라가지 않고 실패한다', () => {
    const target = join(dir, 'elsewhere');
    writeFileSync(target, 'keep');
    const log = daemonLogPath(dir);
    symlinkSync(target, log);
    expect(() => openDaemonLog(log)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });

  it('상한을 넘으면 .1로 복사하고 비우고 넘지 않으면 그대로 둔다', () => {
    const log = daemonLogPath(dir);
    writeFileSync(log, 'x'.repeat(100), { mode: 0o600 });
    expect(rotateDaemonLog(log, 100)).toBe(false);
    expect(statSync(log).size).toBe(100);
    writeFileSync(log, 'y'.repeat(101), { mode: 0o600 });
    expect(rotateDaemonLog(log, 100)).toBe(true);
    expect(statSync(log).size).toBe(0);
    expect(readFileSync(`${log}.1`, 'utf8')).toBe('y'.repeat(101));
    expect(statSync(`${log}.1`).mode & 0o777).toBe(0o600);
    expect(DAEMON_LOG_MAX_BYTES).toBe(1024 * 1024);
  });

  it('비운 뒤에도 열어 둔 덧붙이기 fd가 파일 앞에서부터 다시 쓴다', () => {
    const log = daemonLogPath(dir);
    const fd = openDaemonLog(log);
    try {
      writeSync(fd, 'z'.repeat(200));
      expect(rotateDaemonLog(log, 100)).toBe(true);
      writeSync(fd, 'after\n');
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(log, 'utf8')).toBe('after\n');
  });

  it('.1이 심링크면 따라가지 않고 던지고 원본과 링크 대상을 건드리지 않는다', () => {
    const log = daemonLogPath(dir);
    writeFileSync(log, 'y'.repeat(101), { mode: 0o600 });
    const target = join(dir, 'elsewhere');
    writeFileSync(target, 'keep', { mode: 0o644 });
    symlinkSync(target, `${log}.1`);
    expect(() => rotateDaemonLog(log, 100)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('keep');
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(statSync(log).size).toBe(101);
  });

  it('원본이 심링크면 돌리지 않는다', () => {
    const target = join(dir, 'elsewhere');
    writeFileSync(target, 'z'.repeat(200));
    const log = daemonLogPath(dir);
    symlinkSync(target, log);
    expect(rotateDaemonLog(log, 100)).toBe(false);
    expect(statSync(target).size).toBe(200);
  });

  it('꼬리는 줄마다 제어 문자를 지운다', () => {
    const log = daemonLogPath(dir);
    writeFileSync(log, 'ok \u001b[31mred\u001b[0m\n\u0007\n');
    expect(logTail(log)).toEqual(['ok [31mred[0m']);
  });

  it('꼬리는 이번 기동 표시 줄 뒤에서만 센다', () => {
    const log = daemonLogPath(dir);
    writeFileSync(
      log,
      [
        '=== gestalt peer daemon --detach 2026-01-01 ===',
        'old failure',
        '=== gestalt peer daemon --detach 2026-01-02 ===',
        'line 1',
        '',
        'line 2',
        '',
      ].join('\n'),
    );
    expect(logTail(log)).toEqual(['line 1', 'line 2']);
    expect(logTail(log, 1)).toEqual(['line 2']);
    expect(logTail(join(dir, 'missing'))).toEqual([]);
  });
});

describe('daemonCommand', () => {
  it('같은 Node와 실행 인자, 스크립트에 peer daemon만 붙이고 디버거와 감시 옵션은 뺀다', () => {
    expect(
      daemonCommand(
        ['/node', '/repo/bin/gestalt.ts', 'peer', '--json', 'daemon', '--detach', '--wait', '5'],
        ['--require', '/tsx/preflight.cjs', '--inspect=9229', '--watch', '--import', 'file:///l'],
        '/node',
      ),
    ).toEqual([
      '/node',
      '--require',
      '/tsx/preflight.cjs',
      '--import',
      'file:///l',
      '/repo/bin/gestalt.ts',
      'peer',
      'daemon',
    ]);
    expect(daemonCommand(['/node', '/usr/lib/gestalt/dist/bin/gestalt.js'], [], '/node')).toEqual([
      '/node',
      '/usr/lib/gestalt/dist/bin/gestalt.js',
      'peer',
      'daemon',
    ]);
  });

  it('자식 환경은 루트를 고정하고 부른 세션 표시를 뺀다', () => {
    const env = detachedEnv(
      { PATH: '/bin', GESTALT_PEER_HOME: '/other', CLAUDE_PID: '1', CLAUDE_CODE_SESSION_ID: 's' },
      '/root',
    );
    expect(env).toEqual({ PATH: '/bin', GESTALT_PEER_HOME: '/root', GESTALT_PEER_DETACHED: '1' });
  });

  it('NODE_OPTIONS에서 디버거와 감시 옵션만 빼고 다 빠지면 키를 지운다', () => {
    expect(
      detachedEnv(
        { NODE_OPTIONS: '--require /x  --inspect=9229 --watch --max-old-space-size=512' },
        '/r',
      )['NODE_OPTIONS'],
    ).toBe('--require /x --max-old-space-size=512');
    expect('NODE_OPTIONS' in detachedEnv({ NODE_OPTIONS: '--inspect-brk' }, '/r')).toBe(false);
  });

  it('Windows는 지원하지 않는다고 실패한다', () => {
    expect(() => assertDetachSupported('win32')).toThrow('Windows는 지원하지 않아요');
    expect(() => assertDetachSupported('darwin')).not.toThrow();
    expect(() => assertDetachSupported('linux')).not.toThrow();
  });
});

describe('detachDaemon 실패', () => {
  let root: string;
  const pids: number[] = [];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pdf-'));
  });
  afterEach(() => {
    for (const pid of pids.splice(0)) killQuietly(pid);
    rmSync(root, { recursive: true, force: true });
  });

  it('시한 안에 소켓이 안 답하면 로그 꼬리와 함께 실패하고 띄운 자식을 끈다', async () => {
    const err = await detachDaemon({
      root,
      waitMs: 1_500,
      command: [process.execPath, '-e', "console.error('booting'); setInterval(() => {}, 1000)"],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonDetachError);
    const e = err as DaemonDetachError;
    if (e.child) pids.push(e.child);
    expect(e.message).toContain('1.5초 안에 안 떴어요');
    expect(e.tail).toEqual(['booting']);
    expect(e.log).toBe(daemonLogPath(root));
    expect(e.child).toBeDefined();
    expect(await waitDead(e.child!)).toBe(true);
    expect(statSync(e.log).mode & 0o777).toBe(0o600);
  });

  it('로그 돌리기가 실패해도 띄우고 이유를 돌려준다', async () => {
    const log = daemonLogPath(root);
    writeFileSync(log, 'x'.repeat(2 * 1024 * 1024), { mode: 0o600 });
    symlinkSync(join(root, 'nowhere'), `${log}.1`);
    // 소켓에 답하는 가짜 데몬. 자식 pid를 답해 already가 false로 나와야 한다
    const script =
      "const net=require('node:net');" +
      'net.createServer((c)=>c.once("data",()=>c.end(JSON.stringify({ok:true,result:{pid:process.pid}})+"\\n")))' +
      `.listen(${JSON.stringify(socketPath(root))});`;
    const r = await detachDaemon({
      root,
      waitMs: 10_000,
      command: [process.execPath, '-e', script],
    });
    pids.push(r.pid);
    expect(r.already).toBe(false);
    expect(r.rotateError).toBeDefined();
  });

  it('자식이 뜨다가 끝나면 시한을 기다리지 않고 실패한다', async () => {
    const started = Date.now();
    const err = await detachDaemon({
      root,
      waitMs: 20_000,
      command: [process.execPath, '-e', "console.error('boom'); process.exit(1)"],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonDetachError);
    expect((err as DaemonDetachError).message).toContain('뜨다가 끝났어요');
    expect((err as DaemonDetachError).tail).toEqual(['boom']);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('stopDaemon이 신호를 안 보내는 경우', () => {
  let root: string;
  let sleeper: ChildProcess;
  let server: Server | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pds-'));
    sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  });
  afterEach(async () => {
    killQuietly(sleeper.pid);
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('안 떠 있으면 0으로 알리고 잠금의 산 pid에는 신호를 안 보낸다', async () => {
    writeFileSync(lockPath(root), `${sleeper.pid}\n${Date.now() - 60_000}\nabc\n`);
    const r = await stopDaemon({ root, waitMs: 500 });
    expect(r).toEqual({ pid: null, stopped: false, lockPid: sleeper.pid });
    await sleep(200);
    expect(processAlive(sleeper.pid!)).toBe(true);
    rmSync(lockPath(root));
    expect(await stopDaemon({ root, waitMs: 500 })).toEqual({ pid: null, stopped: false });
  });

  it('소켓에 답한 pid와 잠금 pid가 다르면 신호를 안 보내고 실패한다', async () => {
    // 소켓 자리에 데몬이 아닌 무언가가 답하는 경우다. 남의 pid를 대며 끄라고 할 수 있다
    server = createServer((c) => {
      c.once('data', () =>
        c.end(JSON.stringify({ ok: true, result: { pid: sleeper.pid } }) + '\n'),
      );
    });
    await new Promise<void>((r) => server!.listen(socketPath(root), () => r()));
    await expect(stopDaemon({ root, waitMs: 500 })).rejects.toThrow('신호를 안 보냈어요');
    writeFileSync(lockPath(root), `${process.pid}\n${Date.now()}\nabc\n`);
    await expect(stopDaemon({ root, waitMs: 500 })).rejects.toThrow('신호를 안 보냈어요');
    await sleep(200);
    expect(processAlive(sleeper.pid!)).toBe(true);
  });
});

describe('stopDaemon 시한 초과', () => {
  let root: string;
  let stubborn: ChildProcess | undefined;
  let server: Server | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pdt-'));
  });
  afterEach(async () => {
    killQuietly(stubborn?.pid);
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('SIGTERM에 안 끝나면 pid와 kill 안내로 실패하고 프로세스는 그대로다', async () => {
    // 핸들러를 건 뒤에 신호를 보내야 해서 ready를 받을 때까지 기다린다
    stubborn = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await new Promise<void>((r) => stubborn!.stdout!.once('data', () => r()));
    const pid = stubborn.pid!;
    writeFileSync(lockPath(root), `${pid}\n${Date.now()}\nabc\n`);
    server = createServer((c) => {
      c.once('data', () => c.end(JSON.stringify({ ok: true, result: { pid } }) + '\n'));
    });
    await new Promise<void>((r) => server!.listen(socketPath(root), () => r()));
    await expect(stopDaemon({ root, waitMs: 500 })).rejects.toThrow(`안 멈췄어요. \`kill ${pid}\``);
    expect(processAlive(pid)).toBe(true);
  });
});

/**
 * 진짜 CLI를 자식 프로세스로 띄운다. `GESTALT_PEER_HOME`을 임시 디렉토리로 두고 끝에 남은 데몬을 꼭 끈다
 */
describe('peer daemon --detach와 --stop', () => {
  let root: string;
  const pids = new Set<number>();

  function cli(
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string; parent: number }> {
    return new Promise((done) => {
      const p = execFile(
        process.execPath,
        [...TSX_FLAGS, BIN, 'peer', ...args],
        { env: { ...process.env, GESTALT_PEER_HOME: root }, timeout: 90_000 },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          done({ code, stdout, stderr, parent: p.pid ?? -1 });
        },
      );
    });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pdd-'));
  });
  afterEach(async () => {
    // 단언이 pid를 모으기 전에 실패해도 잠금에 적힌 데몬은 끈다. root는 이 테스트가 만든 임시 디렉토리다
    const holder = readLockPid(root);
    if (holder !== undefined) pids.add(holder);
    for (const pid of pids) killQuietly(pid);
    for (const pid of pids) await waitDead(pid, 5_000);
    pids.clear();
    rmSync(root, { recursive: true, force: true });
  });

  it('부른 프로세스가 끝난 뒤에도 살아서 소켓에 답하고 --stop이 잠금과 소켓을 치운다', async () => {
    const first = await cli(['--json', 'daemon', '--detach', '--wait', String(BOOT_WAIT_SECS)]);
    const r = JSON.parse(first.stdout || '{}') as { pid: number; log: string; already: boolean };
    if (r.pid) pids.add(r.pid);
    expect(first.stderr).toBe('');
    expect(first.code).toBe(0);
    expect(r).toEqual({ pid: r.pid, log: daemonLogPath(root), already: false });
    expect(r.pid).not.toBe(first.parent);
    // 부모는 끝났고 데몬은 그 뒤에도 답한다
    expect(processAlive(first.parent)).toBe(false);
    await sleep(300);
    expect(await answeringDaemonPid(socketPath(root))).toBe(r.pid);
    expect(statSync(r.log).mode & 0o777).toBe(0o600);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(readFileSync(r.log, 'utf8')).toContain('`gestalt peer daemon --stop`으로 멈춰요');

    const again = await cli(['daemon', '--detach']);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(`이미 떠 있어요 (pid ${r.pid})`);

    const stop = await cli(['--json', 'daemon', '--stop']);
    expect(stop.code).toBe(0);
    expect(JSON.parse(stop.stdout)).toEqual({ pid: r.pid, stopped: true });
    expect(processAlive(r.pid)).toBe(false);
    expect(existsSync(lockPath(root))).toBe(false);
    expect(existsSync(socketPath(root))).toBe(false);

    const none = await cli(['daemon', '--stop']);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain('안 떠 있어요');
  }, 180_000);

  it('동시에 두 번 띄워도 데몬은 하나다', async () => {
    const command = [process.execPath, ...TSX_FLAGS, BIN, 'peer', 'daemon'];
    const waitMs = BOOT_WAIT_SECS * 1000;
    const settled = await Promise.allSettled([
      detachDaemon({ root, waitMs, command }),
      detachDaemon({ root, waitMs, command }),
    ]);
    // 한쪽이 실패해도 띄운 것은 다 모아 afterEach가 끄게 한다
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        pids.add(s.value.pid);
        if (s.value.spawned) pids.add(s.value.spawned);
      } else if (s.reason instanceof DaemonDetachError && s.reason.child) {
        pids.add(s.reason.child);
      }
    }
    const [a, b] = settled.map((s) => {
      if (s.status === 'rejected') throw s.reason;
      return s.value;
    }) as [DetachResult, DetachResult];
    expect(a.pid).toBe(b.pid);
    expect([a.already, b.already].sort()).toEqual([false, true]);
    // 진 자식은 잠금을 못 잡고 끝난다
    for (const x of [a, b]) {
      if (x.spawned !== undefined && x.spawned !== x.pid) {
        expect(await waitDead(x.spawned, 30_000)).toBe(true);
      }
    }
    expect(processAlive(a.pid)).toBe(true);
    const stop = await stopDaemon({ root });
    expect(stop).toEqual({ pid: a.pid, stopped: true });
    expect(existsSync(lockPath(root))).toBe(false);
  }, 180_000);
});
