import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT_CODE, formatScan, parseRegister, scan } from '../../humanize/index.js';

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

  const report = scan(readFileSync(full, 'utf-8'), { register: parseRegister(options.register) });

  console.log(options.json ? JSON.stringify(report, null, 2) : formatScan(report));
}
