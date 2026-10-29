import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lensSourceSchema, type LensSource } from '../../../src/digest/lens-source.js';
import type { Doubt } from '../../../src/digest/lens-schema.js';
import { lintDigest, lintErrors } from '../../../src/digest/lint.js';
import { parseTranscript, type Cite, type Transcript } from '../../../src/digest/schema.js';
import { lensDigest, lensReport } from './fixture.js';

/**
 * 의심 표시 회귀 셋. 논문 다섯 편에서 잘라 둔 표와 문단 조각으로 기대 의심은 lint를 지나고
 * 속임 후보는 막히는지 본다. 픽스처 출처와 고른 이유는 tests/fixtures/lens/regression/README.md에 있다
 */

const ROOT = join(import.meta.dirname, '../../fixtures/lens/regression');

type Case = { id: string; bulletCite: Cite; doubt: Doubt };
type Expected = {
  paper: { title: string; url: string; slug?: string };
  doubts: (Case & { kind: 'number' | 'direction' })[];
  decoys: (Case & { reason: string; expectedCode: string })[];
};

const papers = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const dir = join(ROOT, d.name);
    const read = (f: string): unknown => JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const transcript = parseTranscript(read('transcript.json'));
    if (!transcript.ok) throw new Error(`${d.name} transcript.json 형식 오류`);
    return {
      name: d.name,
      transcript: transcript.value,
      source: lensSourceSchema.parse(read('source.json')),
      expected: read('expected.json') as Expected,
    };
  });

/** 의심 하나만 단 리포트를 조각에 맞춰 lint하고 의심 자리에서 난 오류 코드만 돌려준다 */
function doubtErrors(transcript: Transcript, source: LensSource, c: Case): string[] {
  const report = lensReport();
  const bullet = report.sections[1]!.subsections[0]!.bullets[0]!;
  bullet.cite = c.bulletCite;
  bullet.doubt = c.doubt;
  const digest = { ...lensDigest(report), slug: transcript.slug };
  return lintErrors(lintDigest(digest, transcript, { source }))
    .filter((i) => i.path.includes('.doubt'))
    .map((i) => i.code);
}

describe('의심 표시 회귀 셋', () => {
  it('논문 다섯 편이 있고 방향 의심과 loose 표 속임 후보가 빠지지 않는다', () => {
    expect(papers.map((p) => p.name).sort()).toEqual([
      'attention',
      'bert',
      'flavordiffusion',
      'resnet',
      'vit',
    ]);
    const doubts = papers.flatMap((p) => p.expected.doubts);
    const decoys = papers.flatMap((p) => p.expected.decoys);
    expect(doubts.filter((d) => d.kind === 'direction').length).toBeGreaterThanOrEqual(2);
    expect(doubts.filter((d) => d.kind === 'number').length).toBeGreaterThanOrEqual(2);
    expect(papers.some((p) => p.source.tables.some((t) => t.grid === 'loose'))).toBe(true);
    expect(decoys.some((d) => d.expectedCode === 'DOUBT_DIRECTION_LOOSE_TABLE')).toBe(true);
    expect(decoys.some((d) => d.expectedCode === 'DOUBT_DIRECTION_AGREES')).toBe(true);
  });

  describe.each(papers)('$name', ({ transcript, source, expected }) => {
    it.each(expected.doubts.map((d) => [d.id, d] as const))('기대 의심 %s는 통과한다', (_, d) => {
      expect(d.kind === 'direction').toBe(d.doubt.direction !== undefined);
      expect(doubtErrors(transcript, source, d)).toEqual([]);
    });

    it.each(expected.decoys.map((d) => [d.id, d] as const))('속임 후보 %s는 막힌다', (_, d) => {
      expect(doubtErrors(transcript, source, d)).toContain(d.expectedCode);
    });
  });
});
