import { describe, expect, it } from 'vitest';
import { parseDigest, parseTranscript } from '../../../src/digest/index.js';
import { sampleDigest, sampleTranscript } from './fixture.js';

describe('parseDigest', () => {
  it('유효본을 받고 빠진 옵션은 기본값으로 채운다', () => {
    const raw = sampleDigest();
    const report = { ...raw.reports[0]! } as Record<string, unknown>;
    delete report.options;
    delete report.skipped;
    const r = parseDigest({ ...raw, reports: [report] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.reports[0]!.options).toEqual({
      length: 'default',
      difficulty: 'normal',
      lang: 'ko',
    });
    expect(r.value.reports[0]!.skipped).toEqual([]);
  });

  it('1.0.0의 report 한 벌은 reports 한 칸으로 읽는다', () => {
    const { reports, ...rest } = sampleDigest();
    const r = parseDigest({ ...rest, schemaVersion: '1.0.0', report: reports[0] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.reports).toHaveLength(1);
    expect(r.value.reports[0]!.lead).toEqual(reports[0]!.lead);
    expect('report' in r.value).toBe(false);
  });

  it('reports가 비면 거절한다', () => {
    expect(parseDigest({ ...sampleDigest(), reports: [] }).ok).toBe(false);
  });

  it('구간이 거꾸로거나 언어 태그 꼴이 아니면 거절한다', () => {
    const d = sampleDigest();
    d.reports[0]!.options.range = [30, 10];
    expect(parseDigest(d).ok).toBe(false);
    const e = sampleDigest();
    e.reports[0]!.options.lang = 'ko"><script>';
    expect(parseDigest(e).ok).toBe(false);
  });

  it('필수 필드가 빠지면 경로와 함께 거절한다', () => {
    const d = sampleDigest() as unknown as { reports: Array<{ lead: Record<string, unknown> }> };
    delete d.reports[0]!.lead.takeaway;
    const r = parseDigest(d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.issues.some((i) => i.startsWith('reports.0.lead.takeaway'))).toBe(true);
  });

  it('from이 to보다 큰 출처는 거절한다', () => {
    const d = sampleDigest();
    d.reports[0]!.sections[0]!.cite = { key: 3, from: 5, to: 2 };
    expect(parseDigest(d).ok).toBe(false);
  });

  it('skipped의 from이 to보다 크면 거절한다', () => {
    const d = sampleDigest();
    d.reports[0]!.skipped = [{ from: 5, to: 2, reason: '거꾸로' }];
    const r = parseDigest(d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.issues.join()).toContain('reports.0.skipped.0');
  });

  it('3단 불릿은 스키마가 받고 lint가 잡는다', () => {
    const d = sampleDigest();
    d.reports[0]!.sections[0]!.subsections[0]!.bullets[0]!.children![0]!.children = [
      { text: '3단', cite: { key: 1, from: 1, to: 1 } },
    ];
    expect(parseDigest(d).ok).toBe(true);
  });
});

describe('parseTranscript', () => {
  it('유효본을 받는다', () => {
    expect(parseTranscript(sampleTranscript()).ok).toBe(true);
  });

  it('i가 자리 번호와 다르면 거절한다', () => {
    const t = sampleTranscript();
    t.segments[3]!.i = 7;
    const r = parseTranscript(t);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.issues.join()).toContain('segments.3.i');
  });

  describe('meta.url은 ingest가 쓰는 꼴만 받는다', () => {
    const withMeta = (meta: Record<string, unknown>) => {
      const t = sampleTranscript();
      return { ...t, meta: { ...t.meta, ...meta } };
    };

    it.each([
      ['옵션처럼 읽히는 값', { url: '--exec=touch /tmp/x' }],
      ['javascript: 링크', { url: 'javascript:alert(1)' }],
      ['다른 영상 주소', { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }],
      ['videoId 없는 유튜브', { videoId: undefined }],
      ['file:이 아닌 로컬 영상', { source: 'file', videoId: undefined, url: '/tmp/a.mp4' }],
    ])('%s는 거절한다', (_label, meta) => {
      expect(parseTranscript(withMeta(meta)).ok).toBe(false);
    });

    it('url이 없는 유튜브와 file: 로컬 영상은 받는다', () => {
      expect(parseTranscript(withMeta({ url: undefined })).ok).toBe(true);
      expect(
        parseTranscript(withMeta({ source: 'file', videoId: undefined, url: 'file:///tmp/a.mp4' }))
          .ok,
      ).toBe(true);
    });
  });

  it('시작 시각이 거꾸로 가면 거절한다', () => {
    const t = sampleTranscript();
    t.segments[4]!.startSec = 1;
    expect(parseTranscript(t).ok).toBe(false);
  });
});
