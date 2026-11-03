import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Stub acquisition only; execute the real bundled resolver after npm's `--`. */
export function writeNpmStub(dir: string, opts: { packageBin: string; log?: string }): string {
  mkdirSync(dir, { recursive: true });
  const stub = join(dir, 'npm');
  writeFileSync(
    stub,
    String.raw`#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const log = ${JSON.stringify(opts.log)};
if (log) fs.appendFileSync(log, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(),
  providerKeys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'anthropic_api_key', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY'].filter(k => Object.hasOwn(process.env, k)),
  registryKeys: ['NPM_TOKEN'].filter(k => Object.hasOwn(process.env, k)),
}) + '\n');
if (process.env.NPM_STUB_WAIT_DIR) {
  const dir = process.env.NPM_STUB_WAIT_DIR;
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, () => {
    fs.writeFileSync(path.join(dir, 'npm-stopped'), signal);
    process.exit(0);
  });
  fs.writeFileSync(path.join(dir, 'npm-ready'), JSON.stringify({pid: process.pid, cwd: process.cwd()}));
  setInterval(() => {}, 1000);
} else {
  if (process.env.FAIL_NPM === '1' || (process.env.OFFLINE_MISS === '1' && process.argv.includes('--offline'))) process.exit(1);
  const i = process.argv.indexOf('--');
  if (i < 0) process.exit(2);
  const result = cp.spawnSync(process.argv[i + 1], process.argv.slice(i + 2), {
    stdio: 'inherit', env: {...process.env, PATH: ${JSON.stringify(opts.packageBin)} + path.delimiter + (process.env.PATH ?? '')},
  });
  process.exit(result.status ?? 1);
}
`,
    { mode: 0o755 },
  );
  return stub;
}
