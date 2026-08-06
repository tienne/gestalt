#!/usr/bin/env tsx
/**
 * Verify that dist/plugin matches plugin/ byte-for-byte.
 *
 * npm 설치 환경에서는 config.ts의 PACKAGE_ROOT가 dist/를 가리키므로
 * 런타임이 실제로 읽는 자산은 plugin/ 이 아니라 dist/plugin/ 이다.
 * postbuild의 `cp -r`는 삭제를 반영하지 않아서, plugin/ 에서 지운 스킬이
 * dist/plugin/ 에 남아 배포되면 아무도 모른 채 유령 스킬이 로드된다.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/** postbuild가 dist/plugin으로 복사하는 디렉토리와 동일하게 유지할 것 */
const ASSET_DIRS = ['agents', 'role-agents', 'review-agents', 'personas', 'skills'] as const;

function collectFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1));
}

const missing: string[] = [];
const stale: string[] = [];
const differing: string[] = [];

for (const dir of ASSET_DIRS) {
  const sourceRoot = resolve(ROOT, 'plugin', dir);
  const distRoot = resolve(ROOT, 'dist', 'plugin', dir);

  if (!statSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`plugin/${dir} 가 없습니다. ASSET_DIRS와 postbuild 목록을 확인하세요.`);
    process.exit(1);
  }
  if (!existsSync(distRoot)) {
    console.error(`dist/plugin/${dir} 가 없습니다. \`pnpm build\` 를 먼저 실행하세요.`);
    process.exit(1);
  }

  const sourceFiles = collectFiles(sourceRoot);
  const distFiles = new Set(collectFiles(distRoot));

  for (const file of sourceFiles) {
    if (!distFiles.has(file)) {
      missing.push(`${dir}/${file}`);
      continue;
    }
    if (!readFileSync(join(sourceRoot, file)).equals(readFileSync(join(distRoot, file)))) {
      differing.push(`${dir}/${file}`);
    }
  }

  const sourceSet = new Set(sourceFiles);
  for (const file of distFiles) {
    if (!sourceSet.has(file)) stale.push(`${dir}/${file}`);
  }
}

const report = (label: string, files: string[]) => {
  if (files.length === 0) return;
  console.error(`\n${label} (${files.length}건)`);
  for (const file of files.sort()) console.error(`  ${file}`);
};

if (missing.length > 0 || stale.length > 0 || differing.length > 0) {
  console.error('dist/plugin 이 plugin/ 과 일치하지 않습니다.');
  report('dist에 복사되지 않음', missing);
  report('dist에만 남아있음 (원본에서 삭제된 자산)', stale);
  report('내용이 다름', differing);
  console.error('\n`rm -rf dist/plugin && pnpm build` 로 다시 만들어주세요.');
  process.exit(1);
}

const total = ASSET_DIRS.reduce(
  (sum, dir) => sum + collectFiles(resolve(ROOT, 'plugin', dir)).length,
  0
);
console.log(`Verified ${total} plugin assets in dist/plugin (${ASSET_DIRS.join(', ')})`);
