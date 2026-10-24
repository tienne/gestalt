import { describe, expect, it } from 'vitest';
import { lintDigest } from '../../../src/digest/lint.js';
import {
  parseRangeArg,
  parseTimeArg,
  sliceFileName,
  sliceTranscript,
} from '../../../src/digest/slice.js';
import { sampleDigest, sampleTranscript } from './fixture.js';

describe('parseTimeArg', () => {
  it('초와 분:초, 시:분:초를 받는다', () => {
    expect(parseTimeArg('90')).toBe(90);
    expect(parseTimeArg('12.5')).toBe(12.5);
    expect(parseTimeArg('1:30')).toBe(90);
    expect(parseTimeArg('1:02:03')).toBe(3723);
  });

  it('꼴이 틀리면 null이다', () => {
    expect(parseTimeArg('1:75')).toBeNull();
    expect(parseTimeArg('1:60:00')).toBeNull();
    expect(parseTimeArg('abc')).toBeNull();
    expect(parseTimeArg('')).toBeNull();
  });
});

describe('parseRangeArg', () => {
  it('시작-끝을 초 튜플로 바꾼다', () => {
    expect(parseRangeArg('1:30-5:00')).toEqual([90, 300]);
    expect(parseRangeArg('10-20')).toEqual([10, 20]);
  });

  it('시작이 끝보다 뒤거나 꼴이 틀리면 던진다', () => {
    expect(() => parseRangeArg('20-10')).toThrow('앞이어야');
    expect(() => parseRangeArg('10')).toThrow('시작-끝');
    expect(() => parseRangeArg('1-2-3')).toThrow('시작-끝');
  });
});

describe('sliceTranscript', () => {
  it('구간에 시작 시각이 든 문장만 i를 그대로 두고 자른다', () => {
    const s = sliceTranscript(sampleTranscript(), [10, 25]);
    expect(s.from).toBe(2);
    expect(s.to).toBe(4);
    expect(s.segments.map((x) => x.i)).toEqual([2, 3, 4]);
    expect(s.range).toEqual([10, 25]);
  });

  it('든 문장이 없으면 던진다', () => {
    expect(() => sliceTranscript(sampleTranscript(), [100, 200])).toThrow('문장이 없어요');
  });

  it('파일 이름에 구간 초를 싣는다', () => {
    expect(sliceFileName([90.5, 300])).toBe('transcript.slice-90-300.json');
  });
});

describe('구간 리포트 lint', () => {
  it('자른 범위만 덮은 리포트는 오류 없이 통과한다', () => {
    const t = sampleTranscript();
    const s = sliceTranscript(t, [10, 25]);
    const d = sampleDigest();
    const base = d.reports[0]!;
    const sub = base.sections[0]!.subsections[0]!;
    d.reports.push({
      ...base,
      options: { ...base.options, range: s.range },
      skipped: [],
      sections: [
        {
          ...base.sections[0]!,
          cite: { key: s.from, from: s.from, to: s.to },
          subsections: [
            {
              ...sub,
              cite: { key: s.from, from: s.from, to: s.to },
              frameSec: 10,
              bullets: [{ text: '구간 요약', cite: { key: 3, from: 3, to: 3 } }],
            },
          ],
        },
      ],
      keywords: base.keywords.map((k) => ({ ...k, firstCite: { key: 3, from: 3, to: 3 } })),
    });
    const errors = lintDigest(d, t).filter(
      (i) => i.severity === 'error' && i.path.startsWith('reports.1'),
    );
    expect(errors.map((e) => `${e.code} ${e.path} ${e.message}`)).toEqual([]);
  });

  it('구간 리포트의 키워드 출처가 구간 밖이면 오류다', () => {
    const t = sampleTranscript();
    const d = sampleDigest();
    const base = d.reports[0]!;
    d.reports[0] = { ...base, options: { ...base.options, range: [0, 62] } };
    expect(lintDigest(d, t).some((i) => i.code === 'OUT_OF_REPORT_RANGE')).toBe(false);
    d.reports[0] = { ...base, options: { ...base.options, range: [10, 62] } };
    const issues = lintDigest(d, t).filter((i) => i.path.includes('.firstCite'));
    expect(issues.map((i) => i.code)).toContain('OUT_OF_REPORT_RANGE');
  });
});
