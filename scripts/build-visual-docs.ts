import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildDocsSite } from '../src/visual-system/docs-site.js';

// 호스팅이 정해지기 전까지는 레포 안 .gestalt/(gitignore)에 정적 파일 한 장으로 뽑는다
const outArg = process.argv.indexOf('--out');
const out = resolve(
  outArg > 0 && process.argv[outArg + 1]
    ? process.argv[outArg + 1]!
    : '.gestalt/visual-docs/index.html',
);
const { html, renderedIds } = buildDocsSite();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
process.stdout.write(
  `${out} (${(html.length / 1024).toFixed(0)}KB, 페이지 ${renderedIds.length}개)\n`,
);
