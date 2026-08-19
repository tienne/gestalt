#!/usr/bin/env tsx
/**
 * 에이전트 문서의 S1 어투 패턴 잔존 건수를 기준으로 잠근다.
 *
 * 남은 건 대부분 탐지기가 못 가리는 오탐이다 ("보고"·"경고"처럼 -고로 끝나는 명사).
 * 0건을 강제하면 오탐을 피하려 문장을 비트는 일이 생기므로, 현재 값을 적어두고
 * 늘어날 때만 막는다. 문서를 정리하면 이 스크립트를 다시 돌려 기준을 낮춘다.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countS1ByFile } from './verify-rule-refs.js';

const out = join(dirname(fileURLToPath(import.meta.url)), 'humanize-baseline.json');
const counts = Object.fromEntries([...countS1ByFile()].sort(([a], [b]) => a.localeCompare(b)));

const previous: Record<string, number> = existsSync(out)
  ? (JSON.parse(readFileSync(out, 'utf-8')) as Record<string, number>)
  : {};

const raised = Object.entries(counts)
  .filter(([file, count]) => count > (previous[file] ?? 0))
  .map(([file, count]) => `  ${file}: ${previous[file] ?? 0} → ${count}`);

// 기준을 올리는 건 "고치는 대신 덮는" 것이라 기본으로 막는다. 검사가 실패할 때마다
// 이 스크립트를 돌리면 회귀 방지 장치가 그 자리에서 없어진다. 내리는 쪽은 늘 허용한다 —
// 문서를 정리한 결과이므로 잠글 이유가 없다.
const allowRaise = process.argv.includes('--allow-raise');

if (raised.length > 0 && !allowRaise) {
  console.error(
    `기준을 올리려는 파일이 ${raised.length}개다. 문장을 고치는 쪽이 먼저다.\n${raised.join('\n')}\n\n` +
      '검사 범위를 넓히는 것처럼 올리는 게 맞는 경우에만 --allow-raise 를 붙이고, ' +
      'PR 본문에 이유를 적는다.',
  );
  process.exit(1);
}

writeFileSync(out, `${JSON.stringify(counts, null, 2)}\n`);
const total = Object.values(counts).reduce((s, n) => s + n, 0);
console.log(`기준 갱신: 문서 ${Object.keys(counts).length}개, S1 ${total}건`);
if (raised.length > 0) console.log(`올린 항목 ${raised.length}개 (--allow-raise)`);
