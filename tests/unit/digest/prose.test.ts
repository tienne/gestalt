import { describe, expect, it } from 'vitest';
import {
  applyProse,
  diffMarkers,
  extractMarkers,
  extractProse,
} from '../../../src/digest/prose.js';
import { sampleDigest } from './fixture.js';

describe('extractProse', () => {
  it('제목은 빼고 도입, 결론, 불릿, 키워드 설명을 path와 hash로 뽑는다', () => {
    const items = extractProse(sampleDigest());
    const paths = items.map((i) => i.path);
    expect(paths).toContain('report.lead.question');
    expect(paths).toContain('report.sections.0.conclusion');
    expect(paths).toContain('report.sections.0.subsections.0.bullets.0.text');
    expect(paths).toContain('report.keywords.0.explanation');
    expect(paths.some((p) => p.endsWith('.title'))).toBe(false);
    expect(items[0]!.hash).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('extractMarkers', () => {
  it('키워드 id, 굵게, URL, 숫자를 센다. 키워드 id 속 숫자는 따로 세지 않는다', () => {
    expect(
      extractMarkers('{{kw:v2-api|API}}는 **3배** 빠르다 https://a.io/1 에서 12,000건'),
    ).toEqual(['키워드:v2-api', '굵게', '링크:https://a.io/1', '수치:3', '수치:12,000']);
  });

  it('키워드 표시 글자는 바뀌어도 되지만 id가 바뀌면 걸린다', () => {
    expect(diffMarkers('{{kw:a|코드 레이어}} 소개', '{{kw:a|레이어}}를 소개해요')).toBeNull();
    expect(diffMarkers('{{kw:a|코드}}', '{{kw:b|코드}}')).toEqual({
      missing: ['키워드:a'],
      added: ['키워드:b'],
    });
  });
});

describe('applyProse', () => {
  const pick = (path: string) => extractProse(sampleDigest()).find((i) => i.path === path)!;

  it('표식이 그대로면 같은 path에 넣고 원본은 건드리지 않는다', () => {
    const src = sampleDigest();
    const item = pick('report.sections.0.conclusion');
    const r = applyProse(src, [
      { ...item, text: '{{kw:code-layers|코드 레이어}}로 캔버스에서 코드를 다룬다.' },
    ]);
    expect(r.applied).toBe(1);
    expect(r.digest.report.sections[0]!.conclusion).toBe(
      '{{kw:code-layers|코드 레이어}}로 캔버스에서 코드를 다룬다.',
    );
    expect(src.report.sections[0]!.conclusion).toBe(item.text);
  });

  it('굵게가 빠지면 원문을 두고 MARKER_MISMATCH', () => {
    const item = pick('report.sections.0.subsections.0.bullets.0.text');
    const r = applyProse(sampleDigest(), [{ ...item, text: '코드를 그대로 가져온다.' }]);
    expect(r.applied).toBe(0);
    expect(r.warnings).toEqual([
      { path: item.path, code: 'MARKER_MISMATCH', missing: ['굵게'], added: [] },
    ]);
  });

  it('hash가 다르면 STALE, 모르는 path와 빈 문장, 중복 path도 경고만 한다', () => {
    const a = pick('report.lead.answer');
    const b = pick('report.lead.takeaway');
    const r = applyProse(sampleDigest(), [
      { ...a, hash: '000000000000', text: '새 문장' },
      { path: 'report.lead.nope', hash: a.hash, text: 'x' },
      { ...b, text: ' ' },
      { ...b, text: '두 번째' },
    ]);
    expect(r.warnings.map((w) => w.code)).toEqual(['STALE', 'UNKNOWN_PATH', 'DUPLICATE_PATH']);
    expect(r.applied).toBe(0);
  });

  it('그대로 돌려준 항목은 unchanged로 센다', () => {
    const a = pick('report.lead.answer');
    expect(applyProse(sampleDigest(), [a]).unchanged).toBe(1);
  });
});
