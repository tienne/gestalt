import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT_CODE, formatScan, scan } from '../../humanize/index.js';
import type { Register } from '../../humanize/index.js';

export interface HumanizeScanOptions {
  file: string;
  register?: string;
  json?: boolean;
}

export function humanizeScanCommand(options: HumanizeScanOptions): void {
  const full = resolve(process.cwd(), options.file);
  if (!existsSync(full)) {
    console.error(`파일이 없습니다: ${full}`);
    process.exit(EXIT_CODE.unknown);
  }

  const register: Register =
    options.register === 'chat' ? 'chat' : options.register === 'report' ? 'report' : 'doc';
  const report = scan(readFileSync(full, 'utf-8'), { register });

  console.log(options.json ? JSON.stringify(report, null, 2) : formatScan(report));
}
