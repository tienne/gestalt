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
  const userconfig = join(dir, 'user.npmrc');
  const globalconfig = join(dir, 'global.npmrc');
  writeFileSync(userconfig, '');
  writeFileSync(globalconfig, '');
  const npmConfigEnv = { npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig };
  // npm resolution is stubbed; the actual copied wrapper and resolver execute.
  writeNpmStub(npmBin, { packageBin, log });
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [join(plugin, 'scripts/gestalt-cli.mjs'), ...args], {
      cwd,
      encoding: 'utf8',
      input: 'stdin stays intact\n',
      env: { ...process.env, ...npmConfigEnv, PATH: npmBin, ...env },
      timeout: 15000,
    });
  return { dir, cwd, plugin, log, run, npmBin, bin, npmConfigEnv };
}

function runWaitingWrapper(f: ReturnType<typeof fixture>, env: Record<string, string> = {}) {
  const wrapper = spawn(process.execPath, [join(f.plugin, 'scripts/gestalt-cli.mjs'), 'wait'], {
    cwd: f.cwd,
    env: { ...process.env, ...f.npmConfigEnv, PATH: f.npmBin, ...env },
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
    expect(calls.every((call) => !existsSync(call.cwd))).toBe(true);
  });

  it('filters provider secrets while preserving npm authentication, proxies and CA settings', () => {
    const f = fixture();
    const removed = [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'anthropic_api_key',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_ACCESS_KEY_ID',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'CODEX_API_KEY',
      'XAI_API_KEY',
      'GROK_API_KEY',
      'MISTRAL_API_KEY',
      'OPENROUTER_API_KEY',
      'HF_TOKEN',
      'SLACK_BOT_TOKEN',
      'SENTRY_AUTH_TOKEN',
      'AZURE_CLIENT_SECRET',
      'INTERNAL_SECRET_KEY',
      'INTERNAL_PASSWORD',
    ];
    const preserved = [
      'NPM_TOKEN',
      'NODE_AUTH_TOKEN',
      'NPM_GITHUB_TOKEN',
      'npm_config_cafile',
      'HTTPS_PROXY',
      'NODE_EXTRA_CA_CERTS',
      'npm_config__authToken',
      'MY_ANTHROPIC_X',
    ];
    const keys = [...removed, ...preserved];
    writeFileSync(
      f.bin,
      `if(process.argv[2]==='--version')console.log(${JSON.stringify(version)});
else console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]]))));`,
    );
    const values = Object.fromEntries(keys.map((key) => [key, `fixture-${key}`]));
    // A real file avoids Node's optional CA warning; npm itself remains stubbed.
    const ca = join(f.dir, 'empty-ca.pem');
    writeFileSync(ca, '');
    values.NODE_EXTRA_CA_CERTS = ca;
    const result = f.run(['environment'], values);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(values);
    const call = JSON.parse(readFileSync(f.log, 'utf8').trim());
    for (const key of removed) expect(call.envKeys, key).not.toContain(key);
    for (const key of preserved) expect(call.envKeys, key).toContain(key);
  });

  it('preserves secret-shaped variables referenced by user and global npm configuration', () => {
    const f = fixture();
    writeFileSync(
      f.npmConfigEnv.npm_config_userconfig,
      '//registry.fixture/:_authToken=${ARTIFACTORY_API_KEY}\n',
    );
    writeFileSync(
      f.npmConfigEnv.npm_config_globalconfig,
      '//global.fixture/:_authToken=${GH_TOKEN}\n',
    );
    const result = f.run(['environment'], {
      ARTIFACTORY_API_KEY: 'fixture-artifactory',
      GH_TOKEN: 'fixture-github',
      REFERENCED_CLIENT_SECRET: 'fixture-client',
      npm_config_registry: 'https://${REFERENCED_CLIENT_SECRET}@registry.fixture/',
      CODEX_API_KEY: 'fixture-codex',
    });
    expect(result.status, result.stderr).toBe(10);
    const call = JSON.parse(readFileSync(f.log, 'utf8').trim());
    expect(call.envKeys).toEqual(
      expect.arrayContaining(['ARTIFACTORY_API_KEY', 'GH_TOKEN', 'REFERENCED_CLIENT_SECRET']),
    );
    expect(call.envKeys).not.toContain('CODEX_API_KEY');
  });

  it('preserves optional references in npm configuration and configuration environment values', () => {
    const f = fixture();
    writeFileSync(
      f.npmConfigEnv.npm_config_userconfig,
      '//registry.fixture/:_authToken=${GITHUB_TOKEN?}\n',
    );
    writeFileSync(
      f.npmConfigEnv.npm_config_globalconfig,
      '//global.fixture/:_authToken=${XAI_API_KEY?}\n',
    );
    const result = f.run(['echo'], {
      GITHUB_TOKEN: 'fixture-github',
      XAI_API_KEY: 'fixture-xai',
      REFERENCED_CLIENT_SECRET: 'fixture-client',
      npm_config_registry: 'https://${REFERENCED_CLIENT_SECRET?}@registry.fixture/',
      CODEX_API_KEY: 'fixture-codex',
    });
    expect(result.status, result.stderr).toBe(10);
    const call = JSON.parse(readFileSync(f.log, 'utf8').trim());
    expect(call.envKeys).toEqual(
      expect.arrayContaining(['GITHUB_TOKEN', 'XAI_API_KEY', 'REFERENCED_CLIENT_SECRET']),
    );
    expect(call.envKeys).not.toContain('CODEX_API_KEY');
  });

  it('does not preserve credentials referenced only in npm configuration comments', () => {
    const f = fixture();
    writeFileSync(
      f.npmConfigEnv.npm_config_userconfig,
      '# _authToken=${CODEX_API_KEY}\n ; _authToken=${GH_TOKEN?}\n',
    );
    const result = f.run(['echo'], {
      CODEX_API_KEY: 'fixture-codex',
      GH_TOKEN: 'fixture-github',
    });
    expect(result.status, result.stderr).toBe(10);
    const call = JSON.parse(readFileSync(f.log, 'utf8').trim());
    expect(call.envKeys).not.toContain('CODEX_API_KEY');
    expect(call.envKeys).not.toContain('GH_TOKEN');
  });

  it('does not treat an escaped npm interpolation as a credential reference', () => {
    const f = fixture();
    writeFileSync(f.npmConfigEnv.npm_config_userconfig, '_authToken=\\${CODEX_API_KEY}\n');
    const result = f.run(['echo'], { CODEX_API_KEY: 'fixture-codex' });
    expect(result.status, result.stderr).toBe(10);
    const call = JSON.parse(readFileSync(f.log, 'utf8').trim());
    expect(call.envKeys).not.toContain('CODEX_API_KEY');
  });

  it.each(['~/registry.npmrc', '${HOME}/registry.npmrc', '${HOME?}/registry.npmrc'])(
    'expands the user configuration path %s against the supplied home',
    (userconfig) => {
      const f = fixture();
      const home = join(f.dir, 'config-home');
      mkdirSync(home);
      writeFileSync(join(home, 'registry.npmrc'), '_authToken=${MY_REGISTRY_API_KEY}\n');
      const result = f.run(['echo'], {
        HOME: home,
        npm_config_userconfig: userconfig,
        MY_REGISTRY_API_KEY: 'fixture-registry',
      });
      expect(result.status, result.stderr).toBe(10);
      const call = JSON.parse(readFileSync(f.log, 'utf8').trim());
      expect(call.envKeys).toContain('MY_REGISTRY_API_KEY');
    },
  );

  it('expands a missing optional prefix in a global configuration path to an empty string', () => {
    const f = fixture();
    const globalConfig = join(f.dir, 'optional-global.npmrc');
    writeFileSync(globalConfig, '_authToken=${MY_REGISTRY_API_KEY?}\n');
    const result = f.run(['echo'], {
      npm_config_globalconfig: '${GESTALT_TEST_ABSENT_PREFIX?}' + globalConfig,
      GESTALT_TEST_ABSENT_PREFIX: undefined,
      MY_REGISTRY_API_KEY: 'fixture-registry',
    });
    expect(result.status, result.stderr).toBe(10);
    const call = JSON.parse(readFileSync(f.log, 'utf8').trim());
    expect(call.envKeys).toContain('MY_REGISTRY_API_KEY');
  });

  it('reads default user npm configuration from the supplied home directory', () => {
    const f = fixture();
    const userHome = join(f.dir, 'user-home');
    mkdirSync(userHome);
    writeFileSync(
      join(userHome, '.npmrc'),
      '//registry.fixture/:_authToken=${MY_REGISTRY_API_KEY}\n',
    );
    const result = f.run(['echo'], {
      HOME: userHome,
      npm_config_userconfig: undefined,
      MY_REGISTRY_API_KEY: 'fixture-registry',
    });
    expect(result.status, result.stderr).toBe(10);
    const call = JSON.parse(readFileSync(f.log, 'utf8').trim());
    expect(call.envKeys).toContain('MY_REGISTRY_API_KEY');
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
    const calls = readFileSync(f.log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.every((call) => !existsSync(call.cwd))).toBe(true);
  });

  it('reports npm signal failure instead of treating it as a user cancellation', () => {
    const f = fixture();
    const result = f.run(['echo'], { NPM_STUB_SELF_KILL: '1' });
    expect(result.status, result.stderr).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain('could not resolve');
    const calls = readFileSync(f.log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toContain('--offline');
    expect(calls[1].args).not.toContain('--offline');
    expect(calls.every((call) => !existsSync(call.cwd))).toBe(true);
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
      writeFileSync(
        f.bin,
        `import fs from 'node:fs';
if(process.argv[2]==='--version')console.log(${JSON.stringify(version)});
else {
  process.on('SIGINT',()=>fs.appendFileSync(${JSON.stringify(interrupts)},'INT'));
  process.on('SIGTERM',()=>{fs.appendFileSync(${JSON.stringify(interrupts)},'TERM');process.exit(0)});
  fs.writeFileSync(${JSON.stringify(interrupts)},'');
  fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));
  setInterval(()=>{},1000);
}`,
      );
      const running = runWaitingWrapper(f);
      try {
        await expect.poll(() => existsSync(ready), { timeout: 10000 }).toBe(true);
        if (delivery === 'group') process.kill(-running.wrapper.pid!, 'SIGINT');
        else expect(running.wrapper.kill('SIGINT')).toBe(true);
        if (delivery === 'group')
          await expect.poll(() => readFileSync(interrupts, 'utf8')).toBe('INT');
        expect(running.wrapper.exitCode).toBeNull();
        expect(running.wrapper.signalCode).toBeNull();
        expect(running.wrapper.kill('SIGTERM')).toBe(true);
        expect(await running.exited).toEqual({ code: 0, signal: null });
        expect(readFileSync(interrupts, 'utf8')).toBe(delivery === 'group' ? 'INTTERM' : 'TERM');
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

  it('cancels the version check and removes its neutral directory before exiting', async () => {
    const f = fixture();
    const ready = join(f.dir, 'version-ready');
    const final = join(f.dir, 'final-ran');
    writeFileSync(
      f.bin,
      `import fs from 'node:fs';
if(process.argv[2]==='--version') {
  fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);
} else { fs.writeFileSync(${JSON.stringify(final)},'ran'); }`,
    );
    const running = runWaitingWrapper(f);
    let neutral: string | undefined;
    try {
      await expect.poll(() => existsSync(ready), { timeout: 10000 }).toBe(true);
      const childPid = Number(readFileSync(ready, 'utf8'));
      const call = JSON.parse(readFileSync(f.log, 'utf8').trim());
      neutral = call.cwd;
      expect(existsSync(neutral!)).toBe(true);
      expect(running.wrapper.kill('SIGTERM')).toBe(true);
      expect(await running.exited).toEqual({ code: null, signal: 'SIGTERM' });
      expect(existsSync(neutral!)).toBe(false);
      expect(() => process.kill(childPid, 0)).toThrow();
      expect(existsSync(final)).toBe(false);
    } finally {
      await running.cleanup();
      if (neutral) rmSync(neutral, { recursive: true, force: true });
    }
  });

  it.each(['interrupt', 'interrupt-then-term'] as const)(
    'cleans up npm when only the wrapper receives %s',
    async (delivery) => {
      const f = fixture();
      const running = runWaitingWrapper(f, { NPM_STUB_WAIT_DIR: f.dir });
      let neutral: string | undefined;
      try {
        const ready = join(f.dir, 'npm-ready');
        await expect.poll(() => existsSync(ready), { timeout: 10000 }).toBe(true);
        const npm = JSON.parse(readFileSync(ready, 'utf8')) as { pid: number; cwd: string };
        neutral = npm.cwd;
        const interruptedAt = performance.now();
        expect(running.wrapper.kill('SIGINT')).toBe(true);
        if (delivery === 'interrupt-then-term') expect(running.wrapper.kill('SIGTERM')).toBe(true);
        expect(await running.exited).toEqual({
          code: null,
          signal: delivery === 'interrupt' ? 'SIGINT' : 'SIGTERM',
        });
        if (delivery === 'interrupt') {
          // Assert the lower bound after exit so slow CI cannot turn a pre-deadline
          // absence check into a false failure by waking after the grace period.
          expect(performance.now() - interruptedAt).toBeGreaterThanOrEqual(1500);
        }
        expect(readFileSync(join(f.dir, 'npm-stopped'), 'utf8')).toBe('SIGTERM');
        expect(existsSync(neutral)).toBe(false);
        expect(() => process.kill(npm.pid, 0)).toThrow();
        expect(readFileSync(f.log, 'utf8').trim().split('\n')).toHaveLength(1);
      } finally {
        await running.cleanup();
        if (neutral) rmSync(neutral, { recursive: true, force: true });
      }
    },
  );

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
