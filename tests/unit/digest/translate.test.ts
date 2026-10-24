import { describe, expect, it } from 'vitest';
import { applyTranslation } from '../../../src/digest/translate.js';
import { sampleTranscript } from './fixture.js';

describe('applyTranslation', () => {
  it('문장 번호로 번역을 붙이고 빠진 문장과 없는 번호를 따로 알린다', () => {
    const r = applyTranslation(sampleTranscript(), {
      lang: 'ko',
      items: [
        { i: 0, translation: '첫 문장' },
        { i: 2, translation: '세 번째 문장' },
        { i: 99, translation: '없는 문장' },
      ],
    });
    expect(r.applied).toBe(2);
    expect(r.unknown).toEqual([99]);
    expect(r.missing).toHaveLength(10);
    expect(r.transcript.meta.translationLang).toBe('ko');
    expect(r.transcript.segments[0]!.translation).toBe('첫 문장');
    expect(r.transcript.segments[1]).not.toHaveProperty('translation');
  });

  it('같은 언어면 이전 번역을 두고 다른 언어면 지운다', () => {
    const first = applyTranslation(sampleTranscript(), {
      lang: 'ko',
      items: [{ i: 0, translation: '첫 문장' }],
    }).transcript;
    const same = applyTranslation(first, { lang: 'ko', items: [{ i: 1, translation: '둘' }] });
    expect(same.transcript.segments[0]!.translation).toBe('첫 문장');
    expect(same.transcript.segments[1]!.translation).toBe('둘');
    const other = applyTranslation(first, { lang: 'ja', items: [{ i: 1, translation: '二' }] });
    expect(other.transcript.segments[0]).not.toHaveProperty('translation');
    expect(other.transcript.meta.translationLang).toBe('ja');
  });

  it('언어 태그 꼴이 틀리거나 번역이 비면 던진다', () => {
    const t = sampleTranscript();
    expect(() =>
      applyTranslation(t, { lang: 'ko"><x', items: [{ i: 0, translation: 'a' }] }),
    ).toThrow('번역 형식 오류');
    expect(() => applyTranslation(t, { lang: 'ko', items: [{ i: 0, translation: '  ' }] })).toThrow(
      '번역 형식 오류',
    );
    expect(() => applyTranslation(t, { lang: 'ko', items: [] })).toThrow('번역 형식 오류');
  });
});
