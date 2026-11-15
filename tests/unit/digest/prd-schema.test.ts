import { describe, expect, it } from 'vitest';
import {
  BLOCK_DOCS,
  BLOCK_KINDS,
  blockSchema,
  parsePrdView,
} from '../../../src/digest/prd-schema.js';
import { sampleView } from './prd-fixture.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function withBlock(patch: (b: Json) => void): Json {
  const v = sampleView() as Json;
  patch(v.sections[0].blocks[0]);
  return v;
}

describe('prd-view 스키마', () => {
  it('샘플 뷰를 통과시키고 rows와 omitted 기본값을 채운다', () => {
    const r = parsePrdView(sampleView());
    expect(r.ok).toBe(true);
    const v = sampleView() as Json;
    delete v.omitted;
    delete v.meta.rows;
    const r2 = parsePrdView(v);
    expect(r2.ok && r2.value.omitted).toEqual([]);
  });

  it('kind별 필수 칸이 빠지면 거절한다', () => {
    expect(parsePrdView(withBlock((b) => delete b.status)).ok).toBe(false);
    expect(parsePrdView(withBlock((b) => delete b.text)).ok).toBe(false);
  });

  it('src가 비었거나 역순이거나 0이면 거절한다', () => {
    expect(parsePrdView(withBlock((b) => (b.src = []))).ok).toBe(false);
    expect(parsePrdView(withBlock((b) => (b.src = [[5, 3]]))).ok).toBe(false);
    expect(parsePrdView(withBlock((b) => (b.src = [[0, 3]]))).ok).toBe(false);
  });

  it('enum 밖 값과 빈 섹션, 모르는 최상위 키를 거절한다', () => {
    expect(parsePrdView(withBlock((b) => (b.status = 'maybe'))).ok).toBe(false);
    expect(parsePrdView(withBlock((b) => (b.audience = ['ceo']))).ok).toBe(false);
    const v = sampleView() as Json;
    v.sections[0].blocks = [];
    expect(parsePrdView(v).ok).toBe(false);
    expect(parsePrdView({ ...sampleView(), extra: 1 }).ok).toBe(false);
  });

  it('빈 문자열 칸은 받지 않는다. 비어 있으면 필드를 뺀다', () => {
    const v = sampleView() as Json;
    v.sections[2].blocks[0].baseline = '';
    expect(parsePrdView(v).ok).toBe(false);
  });

  it('BLOCK_DOCS의 kind는 스키마의 kind와 같다', () => {
    expect(Object.keys(BLOCK_DOCS).sort()).toEqual([...BLOCK_KINDS].sort());
    expect(blockSchema.options.length).toBe(BLOCK_KINDS.length);
  });
});
