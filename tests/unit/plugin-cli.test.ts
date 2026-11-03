import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  writeFileSync(
    join(npmBin, 'npm'),
    `#!${process.execPath}
const fs=require('node:fs');const cp=require('node:child_process');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})+'\\n');
if(process.env.FAIL_NPM==='1'||(process.env.OFFLINE_MISS==='1'&&process.argv.includes('--offline')))process.exit(1);
const i=process.argv.indexOf('--'); const r=cp.spawnSync(process.argv[i+1],process.argv.slice(i+2),{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(packageBin)}+require('node:path').delimiter+process.env.PATH}});process.exit(r.status??1);
`,
    { mode: 0o755 },
  );
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

describe('copied plugin CLI launcher (stubbed npm resolver)', () => {
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
    expect(calls[0].cwd).not.toBe(f.cwd);
    expect(calls[0].args).toContain(`--package=@tienne/gestalt@${version}`);
    expect(calls[0].args).toContain('--offline');
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
  }, 20000);
});
