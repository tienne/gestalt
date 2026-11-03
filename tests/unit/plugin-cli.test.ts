import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNpmStub } from '../helpers/npm-stub.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(pkgVersion = version) {
  const dir = mkdtempSync(join(tmpdir(), 'gestalt cli '));
  dirs.push(dir);
  const plugin = join(dir, 'installed plugin');
  cpSync(join(ROOT, 'plugin'), plugin, { recursive: true });
  const cwd = join(dir, 'target project');
  mkdirSync(cwd);
  const pkg = join(dir, 'npm package');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@tienne/gestalt', version: pkgVersion, type: 'module' }),
  );
  const bin = join(pkg, 'bin/gestalt.js');
  writeFileSync(
    bin,
    `import fs from 'node:fs';
if (process.argv[2] === '--version') { console.log(${JSON.stringify(pkgVersion)}); }
else { console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),input:fs.readFileSync(0,'utf8')})); process.exit(10); }`,
  );
  const npmBin = join(dir, 'npm-bin');
  mkdirSync(npmBin);
  const packageBin = join(dir, 'package-bin');
  mkdirSync(packageBin);
  symlinkSync(bin, join(packageBin, 'gestalt'));
  const log = join(dir, 'npm-log');
  // npm resolution is stubbed; the actual copied wrapper and resolver execute.
  writeNpmStub(npmBin, { packageBin, log });
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(plugin, 'scripts/gestalt-cli.mjs'), ...args], {
      cwd,
      encoding: 'utf8',
      input: 'stdin stays intact\n',
      env: { ...process.env, PATH: npmBin, ...env },
      timeout: 15000,
    });
  return { dir, cwd, plugin, log, run, npmBin, bin };
}

function runWaitingWrapper(f: ReturnType<typeof fixture>, env: Record<string, string> = {}) {
  const wrapper = spawn(process.execPath, [join(f.plugin, 'scripts/gestalt-cli.mjs'), 'wait'], {
    cwd: f.cwd,
    env: { ...process.env, PATH: f.npmBin, ...env },
    stdio: 'ignore',
    detached: true,
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      wrapper.once('error', reject);
      wrapper.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  const cleanup = async () => {
    if (wrapper.pid) {
      try {
        process.kill(-wrapper.pid, 'SIGKILL');
      } catch {
        // The successful path has already reaped the complete process group.
      }
    }
    await exited;
  };
  return { wrapper, exited, cleanup };
}

describe('copied plugin CLI launcher (stubbed npm resolver)', { timeout: 20000 }, () => {
  it('preserves argv, stdin, cwd and exit 10 without a global gestalt', () => {
    const f = fixture();
    const result = f.run(['humanize-scan', '--file', 'a b;$(touch SHOULD_NOT_EXIST).md']);
    expect(result.status).toBe(10);
    expect(JSON.parse(result.stdout)).toEqual({
      cwd: realpathSync(f.cwd),
      args: ['humanize-scan', '--file', 'a b;$(touch SHOULD_NOT_EXIST).md'],
      input: 'stdin stays intact\n',
    });
    const calls = readFileSync(f.log, 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).not.toBe(realpathSync(f.cwd));
    expect(dirname(calls[0].cwd)).toBe(realpathSync(tmpdir()));
    expect(basename(calls[0].cwd)).toMatch(/^gestalt-cli-/);
    expect(calls[0].args).toContain(`--package=@tienne/gestalt@${version}`);
    expect(calls[0].args).toContain('--offline');
    const prefix = calls[0].args.find((arg: string) => arg.startsWith('--prefix='));
    expect(prefix).toBeDefined();
    expect(basename(prefix.slice('--prefix='.length))).toBe(basename(calls[0].cwd));
    expect(calls[0].args).toContain('--no-workspaces');
  });

  it('keeps provider credentials out of npm but preserves them for the actual CLI', () => {
    const f = fixture();
    const keys = [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'anthropic_api_key',
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'NPM_TOKEN',
    ];
    writeFileSync(
      f.bin,
      `if(process.argv[2]==='--version')console.log(${JSON.stringify(version)});
else console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]]))));`,
    );
    const values = Object.fromEntries(keys.map((key) => [key, `fixture-${key}`]));
    const result = f.run(['environment'], values);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(values);
    const call = JSON.parse(readFileSync(f.log, 'utf8').trim());
    expect(call.providerKeys).toEqual([]);
    expect(call.registryKeys).toEqual(['NPM_TOKEN']);
  });

  it('tries the exact same pin online after an offline miss', () => {
    const f = fixture();
    const result = f.run(['echo'], { OFFLINE_MISS: '1' });
    expect(result.status).toBe(10);
    const calls = readFileSync(f.log, 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toContain(`--package=@tienne/gestalt@${version}`);
    expect(calls[1].args).not.toContain('--offline');
  });

  it('rejects a stale global even when npm succeeds', () => {
    const f = fixture('0.0.1');
    const result = f.run(['echo']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`could not resolve @tienne/gestalt@${version}`);
  });

  it('fails visibly when npm cannot resolve the pin', () => {
    const f = fixture();
    const result = f.run(['echo'], { FAIL_NPM: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No other version was executed');
    expect(readFileSync(f.log, 'utf8')).not.toContain('latest');
  });

  it('fails before npm when the installed plugin version cannot be read', () => {
    const f = fixture();
    rmSync(join(f.plugin, '.codex-plugin/plugin.json'));
    const result = f.run(['echo']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot read the bundled plugin version');
    expect(existsSync(f.log)).toBe(false);
  });

  it('ignores a target project CLI even when its package name and version match', () => {
    const f = fixture();
    writeFileSync(
      join(f.cwd, 'package.json'),
      JSON.stringify({ name: '@tienne/gestalt', version }),
    );
    mkdirSync(join(f.cwd, 'bin'));
    const marker = join(f.cwd, 'HIJACKED');
    writeFileSync(
      join(f.cwd, 'bin/gestalt.ts'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`,
    );
    const result = f.run(['echo']);
    expect(result.status).toBe(10);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(f.log)).toBe(true);
    expect(JSON.parse(result.stdout).cwd).toBe(realpathSync(f.cwd));
  });

  it('resolves npm for a full plugin checkout that has source but no tsx dependency', () => {
    const f = fixture();
    writeFileSync(
      join(f.dir, 'package.json'),
      JSON.stringify({ name: '@tienne/gestalt', version }),
    );
    mkdirSync(join(f.dir, 'bin'));
    writeFileSync(join(f.dir, 'bin/gestalt.ts'), 'throw new Error("uninstalled source ran");');
    const result = f.run(['echo']);
    expect(result.status).toBe(10);
    expect(existsSync(f.log)).toBe(true);
    expect(result.stderr).not.toContain('run pnpm install');
    expect(result.stderr).not.toContain('uninstalled source ran');
  });

  it('runs this checkout from an unrelated target directory without npm', () => {
    const f = fixture();
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'plugin/scripts/gestalt-cli.mjs'), '--version'],
      {
        cwd: f.cwd,
        encoding: 'utf8',
        env: { ...process.env, PATH: '' },
        timeout: 15000,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(version);
  });

  it('pins source tsconfig instead of loading target-project import aliases', () => {
    const f = fixture();
    const marker = join(f.cwd, 'SOURCE_HIJACKED');
    const config = join(f.cwd, 'tsconfig.json');
    writeFileSync(
      config,
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { commander: ['./evil.ts'] } } }),
    );
    writeFileSync(
      join(f.cwd, 'evil.ts'),
      `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');throw new Error('target tsconfig executed');`,
    );
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'plugin/scripts/gestalt-cli.mjs'), '--version'],
      {
        cwd: f.cwd,
        encoding: 'utf8',
        env: { ...process.env, PATH: '', TSX_TSCONFIG_PATH: config },
        timeout: 15000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(version);
    expect(existsSync(marker)).toBe(false);
  });

  it.each(['SIGTERM', 'SIGHUP'] as const)(
    'forwards %s to a running CLI child and waits for its exit',
    async (signal) => {
      const f = fixture();
      const ready = join(f.dir, 'child-ready');
      const stopped = join(f.dir, 'child-stopped');
      writeFileSync(
        f.bin,
        `import fs from 'node:fs';
if(process.argv[2]==='--version')console.log(${JSON.stringify(version)});
else {
  for(const signal of ['SIGTERM','SIGHUP'])process.on(signal,()=>{
    fs.writeFileSync(${JSON.stringify(stopped)},signal);
    setTimeout(()=>process.exit(0),100);
  });
  fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);
}`,
      );
      const running = runWaitingWrapper(f);
      try {
        await expect.poll(() => existsSync(ready), { timeout: 10000 }).toBe(true);
        const childPid = Number(readFileSync(ready, 'utf8'));
        expect(running.wrapper.kill(signal)).toBe(true);
        expect(await running.exited).toEqual({ code: 0, signal: null });
        expect(readFileSync(stopped, 'utf8')).toBe(signal);
        expect(() => process.kill(childPid, 0)).toThrow();
      } finally {
        await running.cleanup();
      }
    },
  );

  it.each(['wrapper', 'group'] as const)(
    'does not forward SIGINT and waits for the child (%s delivery)',
    async (delivery) => {
      const f = fixture();
      const ready = join(f.dir, 'child-ready');
      const interrupts = join(f.dir, 'interrupts');
      const release = join(f.dir, 'release');
      writeFileSync(
        f.bin,
        `import fs from 'node:fs';
if(process.argv[2]==='--version')console.log(${JSON.stringify(version)});
else {
  process.on('SIGINT',()=>fs.appendFileSync(${JSON.stringify(interrupts)},'INT'));
  fs.writeFileSync(${JSON.stringify(interrupts)},'');
  fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));
  setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0)},20);
}`,
      );
      const running = runWaitingWrapper(f);
      try {
        await expect.poll(() => existsSync(ready), { timeout: 10000 }).toBe(true);
        if (delivery === 'group') process.kill(-running.wrapper.pid!, 'SIGINT');
        else expect(running.wrapper.kill('SIGINT')).toBe(true);
        // Allow delivery to both members before checking that the wrapper waited.
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(running.wrapper.exitCode).toBeNull();
        expect(running.wrapper.signalCode).toBeNull();
        expect(readFileSync(interrupts, 'utf8')).toBe(delivery === 'group' ? 'INT' : '');
        writeFileSync(release, 'exit');
        expect(await running.exited).toEqual({ code: 0, signal: null });
      } finally {
        await running.cleanup();
      }
    },
  );

  it('preserves a CLI child signal exit on the wrapper', async () => {
    const f = fixture();
    const ready = join(f.dir, 'child-ready');
    writeFileSync(
      f.bin,
      `import fs from 'node:fs';
if(process.argv[2]==='--version')console.log(${JSON.stringify(version)});
else { fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000); }`,
    );
    const running = runWaitingWrapper(f);
    try {
      await expect.poll(() => existsSync(ready), { timeout: 10000 }).toBe(true);
      process.kill(Number(readFileSync(ready, 'utf8')), 'SIGTERM');
      expect(await running.exited).toEqual({ code: null, signal: 'SIGTERM' });
    } finally {
      await running.cleanup();
    }
  });

  it.each(['SIGTERM', 'SIGHUP', 'SIGINT'] as const)(
    'cleans up npm acquisition on %s without retrying online',
    async (signal) => {
      const f = fixture();
      const running = runWaitingWrapper(f, { NPM_STUB_WAIT_DIR: f.dir });
      let neutral: string | undefined;
      try {
        const ready = join(f.dir, 'npm-ready');
        await expect.poll(() => existsSync(ready), { timeout: 10000 }).toBe(true);
        const npm = JSON.parse(readFileSync(ready, 'utf8')) as { pid: number; cwd: string };
        neutral = npm.cwd;
        expect(existsSync(neutral)).toBe(true);
        if (signal === 'SIGINT') process.kill(-running.wrapper.pid!, signal);
        else expect(running.wrapper.kill(signal)).toBe(true);
        expect(await running.exited).toEqual({ code: null, signal });
        expect(readFileSync(join(f.dir, 'npm-stopped'), 'utf8')).toBe(signal);
        expect(() => process.kill(npm.pid, 0)).toThrow();
        expect(existsSync(neutral)).toBe(false);
        const calls = readFileSync(f.log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(calls).toHaveLength(1);
        expect(calls[0].args).toContain('--offline');
      } finally {
        await running.cleanup();
        // Failure cleanup must also remove an old wrapper's leaked directory.
        if (neutral) rmSync(neutral, { recursive: true, force: true });
      }
    },
  );
});

describe('copied plugin CLI launcher with actual offline npm', { timeout: 20000 }, () => {
  it('does not execute a forged exact-version package in a TMPDIR parent workspace', () => {
    const f = fixture();
    const parent = join(f.dir, 'hostile temp parent');
    const pkg = join(parent, 'node_modules/@tienne/gestalt');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(
      join(parent, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['*'] }),
    );
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@tienne/gestalt', version, bin: { gestalt: 'bin/gestalt.cjs' } }),
    );
    const marker = join(f.dir, 'NPM_HIJACKED');
    const bin = join(pkg, 'bin/gestalt.cjs');
    writeFileSync(
      bin,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');console.log(${JSON.stringify(version)});`,
      { mode: 0o755 },
    );
    mkdirSync(join(parent, 'node_modules/.bin'));
    symlinkSync(bin, join(parent, 'node_modules/.bin/gestalt'));
    const npmrc = join(f.dir, 'empty.npmrc');
    const globalNpmrc = join(f.dir, 'empty-global.npmrc');
    writeFileSync(npmrc, '');
    writeFileSync(globalNpmrc, '');
    const env = {
      ...process.env,
      PATH: process.env.PATH ?? '',
      TMPDIR: parent,
      npm_config_cache: join(f.dir, 'empty npm cache'),
      npm_config_offline: 'true',
      npm_config_userconfig: npmrc,
      npm_config_globalconfig: globalNpmrc,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    };
    const workspace = join(parent, 'control-workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'package.json'), '{"private":true}');
    const control = spawnSync(
      'npm',
      [
        'exec',
        '--yes',
        '--offline',
        `--package=@tienne/gestalt@${version}`,
        '--',
        'gestalt',
        '--version',
      ],
      { cwd: workspace, env, encoding: 'utf8', timeout: 10000 },
    );
    expect(control.status, control.stderr).toBe(0);
    expect(
      existsSync(marker),
      'The fixture must reproduce npm parent/workspace package selection',
    ).toBe(true);
    rmSync(marker);
    const result = f.run(['probe'], env);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('could not resolve');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(f.log)).toBe(false);
  });
});
