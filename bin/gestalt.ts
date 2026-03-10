#!/usr/bin/env tsx
import { createCli } from '../src/cli/index.js';

const program = createCli();
program.parse();
