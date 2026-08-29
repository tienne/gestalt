/**
 * 탐지기 회귀 코퍼스 검사.
 *
 * 룰을 하나 넣을 때마다 기존 룰이 조용히 죽거나, 새 정규식이 남의 문장을
 * 먹는 일이 생긴다. 룰이 늘어도 검출이 그대로인지는 사람 눈으로 못 지킨다.
 * 코퍼스가 그 자리를 대신한다 — 기대값은 걸리는 룰 '전부'라서,
 * 새 룰이 잘못 감지하는 것도 같은 테스트에서 잡힌다.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { countByRule, DETECTABLE_RULE_IDS } from '../../../src/humanize/detectors.js';

interface HitCase {
  ruleId: string;
  text: string;
  expect: Record<string, number>;
  /** 잡히는 게 맞는 자리가 아니라 못 가르고 잘못 감지하는 자리면 여기에 적는다 */
  label?: string;
}

interface MissCase {
  label: string;
  text: string;
}

const CORPUS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/humanize/detector-corpus.json',
);

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf-8')) as {
  hits: HitCase[];
  misses: MissCase[];
};

function counts(text: string): Record<string, number> {
  return Object.fromEntries([...countByRule(text)].sort(([a], [b]) => a.localeCompare(b)));
}

describe('탐지기 회귀 코퍼스', () => {
  it.each(corpus.hits)('$ruleId $label — $text', (item) => {
    expect(counts(item.text)).toEqual(item.expect);
  });

  it.each(corpus.misses)('잘못 감지 없음 — $label', (item) => {
    expect(counts(item.text)).toEqual({});
  });

  it('탐지기가 있는 룰은 전부 코퍼스에 있다', () => {
    const covered = new Set(corpus.hits.map((h) => h.ruleId));
    const missing = DETECTABLE_RULE_IDS.filter((id) => !covered.has(id));
    expect(missing).toEqual([]);
  });

  it('코퍼스가 죽은 룰을 가리키지 않는다', () => {
    const detectable = new Set(DETECTABLE_RULE_IDS);
    const stale = corpus.hits.map((h) => h.ruleId).filter((id) => !detectable.has(id));
    expect(stale).toEqual([]);
  });
});
