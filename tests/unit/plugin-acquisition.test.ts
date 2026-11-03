import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
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
    };
  } finally {
    clearTimeout(watchdog);
    killGroup();
    await closed;
  }
}

describe('CLI acquisition subprocess lifetime', { timeout: 15000 }, () => {
  it('reports a timed-out attempt as failure without marking user cancellation', async () => {
    const { result } = await runAcquisition('setInterval(()=>{},1000);', 200);
    expect(result).toEqual({ status: null, stdout: '', signal: null });
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
    const { result, marker } = await runAcquisition(
      `
import fs from 'node:fs';
process.on('SIGTERM',()=>fs.appendFileSync(__MARKER__,'TERM'));
fs.writeFileSync(__MARKER__,'ready');setInterval(()=>{},1000);`,
      2000,
    );
    expect(readFileSync(marker, 'utf8')).toBe('readyTERM');
    expect(result).toEqual({ status: null, stdout: '', signal: null });
  });
});
