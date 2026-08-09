#!/usr/bin/env tsx
/**
 * 에이전트 문서의 S1 어투 패턴 잔존 건수를 기준으로 잠근다.
 *
 * 남은 건 대부분 탐지기가 못 가리는 오탐이다 ("보고"·"경고"처럼 -고로 끝나는 명사).
 * 0건을 강제하면 오탐을 피하려 문장을 비트는 일이 생기므로, 현재 값을 적어두고
 * 늘어날 때만 막는다. 문서를 정리하면 이 스크립트를 다시 돌려 기준을 낮춘다.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countS1ByFile } from './verify-rule-refs.js';

const out = join(dirname(fileURLToPath(import.meta.url)), 'humanize-baseline.json');
const counts = Object.fromEntries([...countS1ByFile()].sort(([a], [b]) => a.localeCompare(b)));

writeFileSync(out, `${JSON.stringify(counts, null, 2)}\n`);
console.log(`기준 갱신: 문서 ${Object.keys(counts).length}개, S1 ${Object.values(counts).reduce((s, n) => s + n, 0)}건`);
