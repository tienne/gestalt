#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(
    `\n  gestalt requires Node.js >= 22.0.0 (current: ${process.version})\n\n` +
      `  Upgrade with:\n` +
      `    nvm install 22 && nvm use 22\n` +
      `    or: https://nodejs.org/\n`,
  );
  process.exit(1);
}

const { FOLLOW_PLUGIN_ENV, resolvePluginDelegation } = await import('../src/cli/follow-plugin.js');
const { getVersion } = await import('../src/core/version.js');

const target = resolvePluginDelegation({
  selfPath: fileURLToPath(import.meta.url),
  currentVersion: getVersion(),
});

if (target) {
  const child = spawn(process.execPath, [target.launcher, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, [FOLLOW_PLUGIN_ENV]: '0' },
  });
  const terminate = () => child.kill('SIGTERM');
  const hangup = () => child.kill('SIGHUP');
  // Ctrl-C는 프로세스 그룹 전체에 가므로 자식에게 다시 보내지 않는다
  const interrupt = () => {};
  process.on('SIGTERM', terminate);
  process.on('SIGHUP', hangup);
  process.on('SIGINT', interrupt);
  child.once('error', (error) => {
    console.error(`gestalt: plugin launcher failed (${error.message})`);
    process.exit(1);
  });
  child.once('exit', (code, signal) => {
    process.off('SIGTERM', terminate);
    process.off('SIGHUP', hangup);
    process.off('SIGINT', interrupt);
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
} else {
  const { createCli } = await import('../src/cli/index.js');
  createCli().parse();
}
