import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatReport, runGate, EXIT_CODE } from '../../humanize/index.js';
import type { Register } from '../../humanize/index.js';

export interface HumanizeGateOptions {
  before: string;
  after: string;
  register?: string;
  json?: boolean;
}

function read(label: string, path: string): string {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) {
    console.error(`${label} 파일이 없습니다: ${full}`);
    process.exit(EXIT_CODE.unknown);
  }
  return readFileSync(full, 'utf-8');
}

export function humanizeGateCommand(options: HumanizeGateOptions): void {
  const register: Register = options.register === 'chat' ? 'chat' : 'doc';
  const before = read('원문', options.before);
  const after = read('윤문본', options.after);

  if (before.trim().length === 0) {
    console.error('원문이 비어 있어 판정할 수 없습니다.');
    process.exit(EXIT_CODE.unknown);
  }

  const report = runGate(before, after, { register });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }

  process.exit(report.exitCode);
}
