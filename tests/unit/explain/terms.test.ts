import { describe, it, expect } from 'vitest';
import { coreTerms, extractTerms, findTermUses } from '../../../src/explain/index.js';

const texts = (terms: { text: string }[]) => terms.map((t) => t.text);

describe('전문용어 추출', () => {
  it('백틱 코드와 대문자 약어, 식별자, 경로를 뽑는다', () => {
    const terms = extractTerms(
      '`pnpm gate` 를 돌리면 ESM 로더가 resolveTsFilename 을 거쳐 src/explain/check.ts 를 읽는다.',
    );
    const found = texts(terms);
    expect(found).toContain('pnpm gate');
    expect(found).toContain('ESM');
    expect(found).toContain('resolveTsFilename');
    expect(found).toContain('src/explain/check.ts');
  });

  it('스네이크케이스 식별자를 통째로 잡는다', () => {
    expect(texts(extractTerms('Error [ERR_MODULE_NOT_FOUND]: 못 찾았다'))).toContain(
      'ERR_MODULE_NOT_FOUND',
    );
  });

  it('파일명 앞부분을 잘라 따로 세지 않는다', () => {
    const found = texts(extractTerms('vitest.config.ts 의 alias 설정을 본다'));
    expect(found).toContain('vitest.config.ts');
    expect(found).not.toContain('config.ts');
  });

  it('긴 용어 안에 든 짧은 용어를 두 번 세지 않는다', () => {
    const terms = extractTerms('ERR_MODULE_NOT_FOUND 가 났다. MODULE 하나 때문이다.');
    const module = terms.find((t) => t.text === 'MODULE');
    expect(module?.count).toBe(1);
  });

  it('한 번도 안 나온 후보는 버린다', () => {
    expect(extractTerms('그냥 한국어 문장이에요.')).toEqual([]);
  });

  it('건수가 같으면 경로를 뒤로 민다', () => {
    const terms = extractTerms('ESM 로더가 /app/src/humanize/detectors 를 못 찾았다.');
    expect(texts(coreTerms(terms, 2))[0]).toBe('ESM');
  });

  it('자주 나온 말이 먼저다', () => {
    const terms = extractTerms('ESM ESM ESM 이고 CJS 는 한 번이다.');
    expect(texts(coreTerms(terms, 1))).toEqual(['ESM']);
  });
});

describe('풀이 판정', () => {
  const terms = extractTerms('`캐시` 와 ESM 을 본다');

  it('용어 뒤 괄호 설명을 풀이로 본다', () => {
    const uses = findTermUses('캐시(한 번 받아온 걸 저장해두는 자리)가 오래됐어요.', terms);
    expect(uses.find((u) => u.term === '캐시')?.glossed).toBe(true);
  });

  it('용어가 괄호 안에 들어간 어순도 풀이로 본다', () => {
    const uses = findTermUses('설정 파일(캐시, 받아온 걸 저장해두는 자리)을 고쳐요.', terms);
    expect(uses.find((u) => u.term === '캐시')?.glossed).toBe(true);
  });

  it('같은 문장의 풀이 표지를 인정한다', () => {
    const uses = findTermUses('ESM 은 쉽게 말하면 요즘 방식 불러오기예요.', terms);
    expect(uses.find((u) => u.term === 'ESM')?.glossed).toBe(true);
  });

  it('풀이가 없으면 안 풀린 것으로 둔다', () => {
    const uses = findTermUses('ESM 로더가 멈췄어요.', terms);
    expect(uses.find((u) => u.term === 'ESM')?.glossed).toBe(false);
  });

  it('다른 문장의 풀이는 그 문장에 안 걸어준다', () => {
    const uses = findTermUses('ESM 로더가 멈췄어요. 캐시(저장해둔 자리)도 봤어요.', terms);
    expect(uses.find((u) => u.term === 'ESM')?.glossed).toBe(false);
  });
});
