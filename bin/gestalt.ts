#!/usr/bin/env node

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

const { resolvePluginDelegation, runDelegated } = await import('../src/cli/follow-plugin.js');
const { getVersion } = await import('../src/core/version.js');

const target = resolvePluginDelegation({
  selfPath: fileURLToPath(import.meta.url),
  currentVersion: getVersion(),
});

if (target) {
  // 사람이 보는 터미널에서만 알린다. 파이프로 읽는 스크립트의 stderr는 건드리지 않는다
  if (process.stderr.isTTY) {
    console.error(
      `gestalt: following plugin ${target.version} (${target.host}) — GESTALT_FOLLOW_PLUGIN=0 to disable`,
    );
  }
  try {
    const { code, signal } = await runDelegated(target, process.argv.slice(2));
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  } catch (error) {
    console.error(`gestalt: plugin launcher failed (${(error as Error).message})`);
    process.exit(1);
  }
} else {
  const { createCli } = await import('../src/cli/index.js');
  createCli().parse();
}
