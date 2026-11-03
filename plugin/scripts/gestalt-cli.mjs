import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownsPackage } from './package-owner.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scripts, '..');
const args = process.argv.slice(2);
const fail = (message) => {
  process.stderr.write(`gestalt CLI: ${message}\n`);
  process.exit(1);
};

let version;
try {
  version = JSON.parse(readFileSync(join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8')).version;
  if (
    typeof version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  ) {
    throw new Error('invalid version');
  }
} catch {
  fail('cannot read the bundled plugin version; reinstall the plugin.');
}
if (Number(process.versions.node.split('.')[0]) < 22) fail('Node.js >=22 is required.');

// A development checkout is identified by the wrapper's own location, never cwd.
// Installed plugin copies have no parent package and use the exact npm pin below.
const checkout = resolve(pluginRoot, '..');
let localArgs;
let sourceTsconfig;
try {
  const pkg = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'));
  const entry = join(checkout, 'bin/gestalt.ts');
  if (pkg.name === '@tienne/gestalt' && pkg.version === version && existsSync(entry)) {
    const tsx = join(checkout, 'node_modules/tsx/dist/loader.mjs');
    // Dependency-free plugin installs need the compiled fallback or the npm pin.
    if (existsSync(tsx)) {
      localArgs = ['--import', tsx, entry];
      sourceTsconfig = join(checkout, 'tsconfig.json');
    }
  }
  if (!localArgs && pkg.name === '@tienne/gestalt' && pkg.version === version) {
    const compiled = [join(checkout, 'bin/gestalt.js'), join(checkout, 'dist/bin/gestalt.js')].find(
      existsSync,
    );
    if (compiled) localArgs = [compiled];
  }
} catch {
  // A copied plugin is deliberately independent of its containing project.
}

let bin;
if (!localArgs) {
  const neutral = mkdtempSync(join(tmpdir(), 'gestalt-cli-'));
  const npmEnv = { ...process.env };
  // These provider credentials are unnecessary for npm; registry auth stays intact.
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    delete npmEnv[key];
  }
  try {
    writeFileSync(join(neutral, 'package.json'), '{"private":true}\n');
    for (const offline of [true, false]) {
      if (!offline)
        process.stderr.write(`gestalt CLI: resolving @tienne/gestalt@${version} from npm.\n`);
      const result = spawnSync(
        'npm',
        [
          'exec',
          '--yes',
          `--prefix=${neutral}`,
          '--no-workspaces',
          ...(offline ? ['--offline'] : []),
          `--package=@tienne/gestalt@${version}`,
          '--',
          process.execPath,
          join(scripts, 'resolve-cli.mjs'),
          version,
        ],
        {
          cwd: neutral,
          env: npmEnv,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 180_000,
        },
      );
      if (result.status !== 0) continue;
      try {
        const candidate = JSON.parse(result.stdout.trim());
        if (typeof candidate !== 'string') continue;
        bin = realpathSync(candidate);
        if (!ownsPackage(bin, version)) {
          bin = undefined;
          continue;
        }
        // Do not trust the resolver process or a stale global executable.
        const check = spawnSync(process.execPath, [bin, '--version'], {
          cwd: neutral,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10_000,
        });
        if (check.status === 0 && check.stdout.trim() === version) break;
        bin = undefined;
      } catch {
        bin = undefined;
      }
    }
  } finally {
    rmSync(neutral, { recursive: true, force: true });
  }
  if (!bin)
    fail(
      `could not resolve @tienne/gestalt@${version}; check npm, network access, and its native dependencies. No other version was executed.`,
    );
}

const child = spawn(process.execPath, [...(localArgs ?? [bin]), ...args], {
  cwd: process.cwd(),
  stdio: 'inherit',
  ...(sourceTsconfig ? { env: { ...process.env, TSX_TSCONFIG_PATH: sourceTsconfig } } : {}),
});
const terminate = () => child.kill('SIGTERM');
const hangup = () => child.kill('SIGHUP');
// Terminal Ctrl-C already reaches the child's process group; do not send it twice.
const interrupt = () => {};
process.on('SIGTERM', terminate);
process.on('SIGHUP', hangup);
process.on('SIGINT', interrupt);
child.once('error', (error) => fail(error.message));
child.once('exit', (code, signal) => {
  process.off('SIGTERM', terminate);
  process.off('SIGHUP', hangup);
  process.off('SIGINT', interrupt);
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
