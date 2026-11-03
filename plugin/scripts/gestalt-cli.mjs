import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
try {
  const pkg = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'));
  const entry = join(checkout, 'bin/gestalt.ts');
  if (pkg.name === '@tienne/gestalt' && pkg.version === version && existsSync(entry)) {
    const tsx = join(checkout, 'node_modules/tsx/dist/loader.mjs');
    // Claude plugin installs also contain the source checkout, without dependencies.
    // Only use source when its local loader is installed; otherwise resolve the pin.
    if (existsSync(tsx)) localArgs = ['--import', tsx, entry];
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
  try {
    for (const offline of [true, false]) {
      if (!offline)
        process.stderr.write(`gestalt CLI: resolving @tienne/gestalt@${version} from npm.\n`);
      const result = spawnSync(
        'npm',
        [
          'exec',
          '--yes',
          ...(offline ? ['--offline'] : []),
          `--package=@tienne/gestalt@${version}`,
          '--',
          process.execPath,
          join(scripts, 'resolve-cli.mjs'),
          version,
        ],
        { cwd: neutral, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 },
      );
      if (result.status !== 0) continue;
      try {
        const candidate = JSON.parse(result.stdout.trim());
        if (typeof candidate !== 'string') continue;
        bin = realpathSync(candidate);
        let directory = dirname(bin);
        let matches = false;
        while (directory !== dirname(directory)) {
          const manifest = join(directory, 'package.json');
          if (existsSync(manifest)) {
            const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
            matches = pkg.name === '@tienne/gestalt' && pkg.version === version;
            break;
          }
          directory = dirname(directory);
        }
        if (!matches) {
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

const result = spawnSync(process.execPath, [...(localArgs ?? [bin]), ...args], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
if (result.error) fail(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.status ?? 1);
