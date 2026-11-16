import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const acquisitionUrl = pathToFileURL(resolve('plugin/scripts/acquisition.mjs')).href;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function runAcquisition(source: string, timeoutMs: number) {
  const dir = mkdtempSync(join(tmpdir(), 'gestalt-acquisition-'));
  dirs.push(dir);
  const childFile = join(dir, 'child.mjs');
  const runnerFile = join(dir, 'runner.mjs');
  const marker = join(dir, 'marker');
  writeFileSync(childFile, source.replaceAll('__MARKER__', JSON.stringify(marker)));
  writeFileSync(
    runnerFile,
    `import { createAcquisition } from ${JSON.stringify(acquisitionUrl)};
const scope = createAcquisition({cwd:${JSON.stringify(dir)},env:process.env});
try {
  const result = await scope.run(process.execPath,[${JSON.stringify(childFile)}],${timeoutMs});
  console.log(JSON.stringify({...result, signal:scope.signal ?? null}));
} finally {scope.dispose();}`,
  );
  // Each probe owns a group so inherited pipes and surviving descendants are
  // cleaned up even when the assertion or the implementation under test fails.
  const startedAt = performance.now();
  const child = spawn(process.execPath, [runnerFile], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => done({ code, signal }));
    },
  );
  let expired = false;
  const killGroup = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* The probe already exited. */
    }
  };
  const watchdog = setTimeout(() => {
    expired = true;
    killGroup();
  }, 12000);
  try {
    const result = await closed;
    expect(expired, `Probe exceeded its deadline: ${stderr}`).toBe(false);
    expect(result, stderr).toEqual({ code: 0, signal: null });
    return {
      result: JSON.parse(stdout) as { status: number | null; stdout: string; signal: null },
      marker,
      elapsedMs: performance.now() - startedAt,
    };
  } finally {
    clearTimeout(watchdog);
    killGroup();
    await closed;
  }
}

// 핸들러를 process.emit으로 직접 불러 신호 도착 순서를 고정한다.
function cancelInOrder(signals: NodeJS.Signals[], withChild = false) {
  const dir = mkdtempSync(join(tmpdir(), 'gestalt-acquisition-'));
  dirs.push(dir);
  const marker = join(dir, 'marker');
  const childFile = join(dir, 'child.mjs');
  const runnerFile = join(dir, 'runner.mjs');
  writeFileSync(
    childFile,
    `import fs from 'node:fs';
for (const s of ['SIGTERM','SIGHUP','SIGINT']) process.on(s,()=>{fs.appendFileSync(${JSON.stringify(marker)},s+' ');process.exit(0);});
fs.writeFileSync(${JSON.stringify(marker)},'');setTimeout(()=>process.exit(1),8000);`,
  );
  writeFileSync(
    runnerFile,
    `import fs from 'node:fs';
import { createAcquisition } from ${JSON.stringify(acquisitionUrl)};
const scope = createAcquisition({cwd:${JSON.stringify(dir)},env:process.env});
const order = ${JSON.stringify(signals)};
try {
  if (process.argv[2] === 'with-child') {
    const run = scope.run(process.execPath,[${JSON.stringify(childFile)}],10000);
    const until = Date.now() + 5000;
    while (!fs.existsSync(${JSON.stringify(marker)})) {
      if (Date.now() > until) throw new Error('npm child did not start');
      await new Promise((r)=>setTimeout(r,20));
    }
    for (const s of order) process.emit(s, s);
    await run;
  } else for (const s of order) process.emit(s, s);
  console.log(JSON.stringify({signal:scope.signal ?? null}));
} finally {scope.dispose();}`,
  );
  // 러너는 획득 핸들러가 SIGTERM을 받아 버려서 timeout에는 KILL을 써야 끝난다.
  const stdout = execFileSync(process.execPath, [runnerFile, withChild ? 'with-child' : ''], {
    encoding: 'utf8',
    timeout: 10000,
    killSignal: 'SIGKILL',
  });
  return {
    signal: (JSON.parse(stdout) as { signal: NodeJS.Signals | null }).signal,
    childReceived: withChild ? readFileSync(marker, 'utf8').trim() : undefined,
  };
}

describe('CLI acquisition cancellation order', { timeout: 15000 }, () => {
  it.each([
    [['SIGINT'], 'SIGINT'],
    [['SIGINT', 'SIGTERM'], 'SIGTERM'],
    [['SIGTERM', 'SIGINT'], 'SIGTERM'],
    [['SIGHUP', 'SIGINT'], 'SIGHUP'],
    [['SIGTERM', 'SIGHUP'], 'SIGHUP'],
  ] as const)('keeps %j as %s', (order, expected) => {
    expect(cancelInOrder([...order]).signal).toBe(expected);
  });

  it.each([
    [['SIGTERM', 'SIGINT'], 'SIGTERM'],
    [['SIGHUP', 'SIGINT'], 'SIGHUP'],
  ] as const)('forwards %j to npm as %s and ignores the late INT', (order, expected) => {
    const { signal, childReceived } = cancelInOrder([...order], true);
    expect(signal).toBe(expected);
    expect(childReceived).toBe(expected);
  });
});

describe('CLI acquisition subprocess lifetime', { timeout: 15000 }, () => {
  it('reports a timed-out attempt as failure without marking user cancellation', async () => {
    const { result } = await runAcquisition('setInterval(()=>{},1000);', 200);
    expect(result).toEqual({ status: null, stdout: '', signal: null });
  });

  it('keeps a timed-out attempt failed when its child handles TERM with exit zero', async () => {
    const { result } = await runAcquisition(
      `process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`,
      1000,
    );
    expect(result).toEqual({ status: null, stdout: '', signal: null });
  });

  it('keeps excess stdout failed when its child handles TERM with exit zero', async () => {
    const { result } = await runAcquisition(
      `process.on('SIGTERM',()=>process.exit(0));process.stdout.write('x'.repeat(128*1024));setInterval(()=>{},1000);`,
      2000,
    );
    expect(result.status).toBeNull();
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64 * 1024);
    expect(result.signal).toBeNull();
  });

  it('bounds waiting when a descendant keeps both inherited pipes open', async () => {
    const { result } = await runAcquisition(
      `
import { spawn } from 'node:child_process';
spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
process.exit(1);`,
      2000,
    );
    expect(result).toEqual({ status: 1, stdout: '', signal: null });
  });

  it('caps collected stdout and treats excess output as failure', async () => {
    const { result } = await runAcquisition(
      `process.stdout.write('x'.repeat(128*1024));setInterval(()=>{},1000);`,
      2000,
    );
    expect(result.status).toBeNull();
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64 * 1024);
    expect(result.signal).toBeNull();
  });

  it('drains stderr while preserving the successful resolver output', async () => {
    const { result } = await runAcquisition(
      `process.stderr.write('x'.repeat(2*1024*1024));process.stdout.write('resolver-result');`,
      3000,
    );
    expect(result).toEqual({ status: 0, stdout: 'resolver-result', signal: null });
  });

  it('escalates a timed-out child that ignores SIGTERM', async () => {
    const { result, marker, elapsedMs } = await runAcquisition(
      `
import fs from 'node:fs';
process.on('SIGTERM',()=>fs.appendFileSync(__MARKER__,'TERM'));
fs.writeFileSync(__MARKER__,'ready');setInterval(()=>{},1000);`,
      2000,
    );
    expect(readFileSync(marker, 'utf8')).toBe('readyTERM');
    expect(elapsedMs).toBeGreaterThanOrEqual(6500);
    expect(result).toEqual({ status: null, stdout: '', signal: null });
  });
});
