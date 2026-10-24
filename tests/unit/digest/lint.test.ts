import { describe, expect, it } from 'vitest';
import { lintDigest, lintErrors, type DigestIssue } from '../../../src/digest/index.js';
import { sampleDigest, sampleTranscript } from './fixture.js';

const codes = (issues: DigestIssue[]) => issues.map((i) => i.code);

describe('lintDigest', () => {
  it('유효본은 오류도 경고도 없다', () => {
    expect(lintDigest(sampleDigest(), sampleTranscript())).toEqual([]);
  });

  describe('대섹션이 스크립트 전체를 덮는다', () => {
    it('끝에 빈 구간이 있으면 오류', () => {
      const t = sampleTranscript();
      t.segments.push({ i: 12, startSec: 60, text: 'Outro.' });
      const issues = lintDigest(sampleDigest(), t);
      expect(codes(issues)).toContain('SECTION_GAP');
      expect(issues.find((i) => i.code === 'SECTION_GAP')!.message).toContain('12번 문장');
    });

    it('빈 구간을 skipped에 이유와 함께 적으면 통과', () => {
      const t = sampleTranscript();
      t.segments.push({ i: 12, startSec: 60, text: 'Subscribe.' });
      const d = sampleDigest();
      d.reports[0]!.skipped = [{ from: 12, to: 12, reason: '구독 안내' }];
      expect(lintErrors(lintDigest(d, t))).toEqual([]);
    });

    it('대섹션 사이가 비면 오류', () => {
      const d = sampleDigest();
      const s2 = d.reports[0]!.sections[1]!;
      s2.cite = { key: 7, from: 7, to: 11 };
      s2.subsections[0]!.cite = { key: 7, from: 7, to: 8 };
      s2.subsections[0]!.frameSec = 35;
      s2.subsections[0]!.bullets[0]!.cite = { key: 7, from: 7, to: 7 };
      expect(codes(lintErrors(lintDigest(d, sampleTranscript())))).toEqual(['SECTION_GAP']);
    });

    it('대섹션끼리 겹치면 오류', () => {
      const d = sampleDigest();
      d.reports[0]!.sections[0]!.cite = { key: 1, from: 0, to: 6 };
      expect(codes(lintDigest(d, sampleTranscript()))).toContain('SECTION_OVERLAP');
    });
  });

  describe('소섹션이 대섹션을 덮는다', () => {
    it('소섹션 사이가 비면 오류', () => {
      const d = sampleDigest();
      const sub = d.reports[0]!.sections[0]!.subsections[1]!;
      sub.cite = { key: 4, from: 4, to: 5 };
      sub.frameSec = 20;
      sub.bullets[0]!.cite = { key: 4, from: 4, to: 4 };
      expect(codes(lintErrors(lintDigest(d, sampleTranscript())))).toEqual(['SUBSECTION_GAP']);
    });

    it('소섹션이 겹치면 오류', () => {
      const d = sampleDigest();
      d.reports[0]!.sections[0]!.subsections[0]!.cite = { key: 0, from: 0, to: 3 };
      expect(codes(lintDigest(d, sampleTranscript()))).toContain('SUBSECTION_OVERLAP');
    });

    it('소섹션이 대섹션 끝을 넘어가면 오류', () => {
      const d = sampleDigest();
      d.reports[0]!.sections[0]!.subsections[1]!.cite = { key: 4, from: 3, to: 6 };
      expect(codes(lintDigest(d, sampleTranscript()))).toContain('SUBSECTION_OVERLAP');
    });
  });

  it('key가 범위 밖이면 오류', () => {
    const d = sampleDigest();
    d.reports[0]!.sections[1]!.subsections[0]!.bullets[1]!.cite = { key: 9, from: 8, to: 8 };
    const issues = lintErrors(lintDigest(d, sampleTranscript()));
    expect(codes(issues)).toEqual(['KEY_OUT_OF_RANGE']);
    expect(issues[0]!.path).toBe('reports.0.sections.1.subsections.0.bullets.1.cite.key');
  });

  it('스크립트에 없는 문장 번호는 오류', () => {
    const d = sampleDigest();
    d.reports[0]!.keywords[0]!.firstCite = { key: 40, from: 40, to: 40 };
    expect(codes(lintDigest(d, sampleTranscript()))).toContain('CITE_OUT_OF_RANGE');
  });

  it('3단 불릿은 오류', () => {
    const d = sampleDigest();
    d.reports[0]!.sections[0]!.subsections[0]!.bullets[0]!.children![0]!.children = [
      { text: '3단', cite: { key: 1, from: 1, to: 1 } },
    ];
    expect(codes(lintDigest(d, sampleTranscript()))).toEqual(['BULLET_DEPTH']);
  });

  it('keywords에 없는 키워드 마커는 오류', () => {
    const d = sampleDigest();
    d.reports[0]!.sections[1]!.subsections[1]!.bullets[0]!.text = '{{kw:agent|에이전트}}가 돕는다.';
    const issues = lintDigest(d, sampleTranscript());
    expect(codes(issues)).toEqual(['UNKNOWN_KEYWORD']);
    expect(issues[0]!.message).toContain('agent');
  });

  it('frameSec이 소섹션 첫 문장 시각과 다르면 오류', () => {
    const d = sampleDigest();
    d.reports[0]!.sections[1]!.subsections[1]!.frameSec = 47;
    expect(codes(lintDigest(d, sampleTranscript()))).toEqual(['FRAME_SEC_MISMATCH']);
  });

  it('같은 id가 두 번 나오면 오류', () => {
    const d = sampleDigest();
    d.reports[0]!.sections[1]!.subsections[1]!.id = 's1';
    expect(codes(lintDigest(d, sampleTranscript()))).toEqual(['DUPLICATE_ID']);
  });

  it('transcript와 slug가 다르면 오류', () => {
    const d = sampleDigest();
    d.slug = 'other';
    expect(codes(lintDigest(d, sampleTranscript()))).toEqual(['SLUG_MISMATCH']);
  });

  describe('분량은 경고만 낸다', () => {
    it('소섹션이 1개면 경고', () => {
      const d = sampleDigest();
      const s1 = d.reports[0]!.sections[0]!;
      const [first, second] = s1.subsections;
      first!.cite = { key: 0, from: 0, to: 5 };
      first!.bullets.push(...second!.bullets);
      s1.subsections = [first!];
      const issues = lintDigest(d, sampleTranscript());
      expect(lintErrors(issues)).toEqual([]);
      expect(codes(issues)).toEqual(['SUBSECTION_COUNT']);
    });

    it('1단 불릿이 5개면 경고', () => {
      const d = sampleDigest();
      const bullets = d.reports[0]!.sections[0]!.subsections[1]!.bullets;
      for (let k = 0; k < 3; k++) bullets.push({ text: '더', cite: { key: 3, from: 3, to: 3 } });
      const issues = lintDigest(d, sampleTranscript());
      expect(issues.map((i) => [i.code, i.severity])).toEqual([['BULLET_COUNT', 'warning']]);
    });
  });

  describe('불릿 출처는 소속 소섹션 안에 있다', () => {
    it('1단 불릿이 다른 소섹션 문장을 가리키면 오류', () => {
      const d = sampleDigest();
      d.reports[0]!.sections[0]!.subsections[0]!.bullets[1]!.cite = { key: 4, from: 4, to: 4 };
      const issues = lintErrors(lintDigest(d, sampleTranscript()));
      expect(codes(issues)).toEqual(['BULLET_CITE_OUT_OF_SUBSECTION']);
      expect(issues[0]!.path).toBe('reports.0.sections.0.subsections.0.bullets.1.cite');
    });

    it('2단 불릿이 대섹션 밖을 가리켜도 오류', () => {
      const d = sampleDigest();
      d.reports[0]!.sections[0]!.subsections[0]!.bullets[0]!.children![0]!.cite = {
        key: 7,
        from: 7,
        to: 7,
      };
      const issues = lintErrors(lintDigest(d, sampleTranscript()));
      expect(codes(issues)).toEqual(['BULLET_CITE_OUT_OF_SUBSECTION']);
      expect(issues[0]!.path).toBe('reports.0.sections.0.subsections.0.bullets.0.children.0.cite');
    });

    it('키워드 firstCite는 어느 섹션이든 가리킬 수 있다', () => {
      const d = sampleDigest();
      d.reports[0]!.keywords[0]!.firstCite = { key: 10, from: 10, to: 10 };
      expect(lintDigest(d, sampleTranscript())).toEqual([]);
    });
  });

  it('skipped가 스크립트 끝을 넘어가면 오류', () => {
    const t = sampleTranscript();
    t.segments.push({ i: 12, startSec: 60, text: 'Outro.' });
    const d = sampleDigest();
    d.reports[0]!.skipped = [{ from: 12, to: 99999, reason: '끝인사' }];
    const issues = lintErrors(lintDigest(d, t));
    expect(codes(issues)).toEqual(['CITE_OUT_OF_RANGE']);
    expect(issues[0]!.path).toBe('reports.0.skipped.0');
  });

  it('제목에 굵게나 키워드 마커가 있으면 오류', () => {
    const d = sampleDigest();
    d.reports[0]!.sections[0]!.title = '**코드** 레이어';
    d.reports[0]!.sections[1]!.subsections[0]!.title = '{{kw:code-layers|코드 레이어}} 만들기';
    const issues = lintDigest(d, sampleTranscript());
    expect(issues.map((i) => [i.code, i.path])).toEqual([
      ['TITLE_MARKER', 'reports.0.sections.0.title'],
      ['TITLE_MARKER', 'reports.0.sections.1.subsections.0.title'],
    ]);
  });

  it.each(['****', '앞 **굵게** 뒤 **'])('굵게 쌍으로 안 풀리는 ** 는 경고: %s', (text) => {
    const d = sampleDigest();
    d.reports[0]!.lead.answer = text;
    expect(codes(lintDigest(d, sampleTranscript()))).toEqual(['UNBALANCED_BOLD']);
  });

  it('** 짝이 안 맞으면 경고', () => {
    const d = sampleDigest();
    d.reports[0]!.lead.answer = '**굵게가 안 닫혔다';
    expect(lintDigest(d, sampleTranscript()).map((i) => [i.code, i.severity])).toEqual([
      ['UNBALANCED_BOLD', 'warning'],
    ]);
  });
});
