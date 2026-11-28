import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PRESENTATION_THEMES,
  syncPresentationTemplate,
} from '../src/visual-system/presentation.js';

// 템플릿은 designer가 그대로 복사하는 파일이라 생성 결과를 레포에 커밋한다. --check는 바꾸지 않고 낡은 파일만 알린다
const check = process.argv.includes('--check');
const dir = resolve('plugin/role-agents/presentation-designer/templates');
const stale: string[] = [];
for (const theme of PRESENTATION_THEMES) {
  const file = resolve(dir, `${theme.id}.html`);
  const before = readFileSync(file, 'utf8');
  const after = syncPresentationTemplate(before, theme);
  if (before === after) continue;
  stale.push(theme.id);
  if (!check) writeFileSync(file, after);
}
process.stdout.write(
  stale.length
    ? `${check ? '낡은 템플릿' : '다시 쓴 템플릿'}: ${stale.join(', ')}\n`
    : '템플릿 10종이 최신이다\n',
);
if (check && stale.length) process.exit(1);
