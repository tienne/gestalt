#!/usr/bin/env node

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

import { createCli } from '../src/cli/index.js';

const program = createCli();
program.parse();
