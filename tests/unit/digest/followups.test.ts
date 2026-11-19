import { describe, expect, it } from 'vitest';
import { findFollowupCandidates } from '../../../src/digest/followups.js';
import { lintDigest, lintErrors } from '../../../src/digest/lint.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderDigestMarkdown } from '../../../src/digest/render-md.js';
import { type Report } from '../../../src/digest/schema.js';
import { sampleDigest, sampleTranscript } from './fixture.js';

function setup() {
  const digest = sampleDigest();
  const report = digest.reports[0]!;
  report.options.range = [0, 30];
  report.sections = report.sections.slice(0, 1);
  report.skipped = [];
  report.keywords = report.keywords.filter((k) => k.firstCite.to < 6);
  const transcript = sampleTranscript();
  transcript.segments[0]!.text = 'Each word type shares a single vector across its occurrences.';
  transcript.segments[6]!.text = 'Now, a note about classroom lighting.';
  transcript.segments[8]!.text = 'To clarify, each word has two vectors for its two roles.';
  transcript.segments[9]!.text = 'One is for the center term, the other for the context term.';
  const followup: NonNullable<Report['followups']>[number] = {
    kind: 'clarification',
    anchor: { ...report.sections[0]!.subsections[0]!.bullets[0]!.cite },
    cite: { key: 8, from: 8, to: 9 },
    quote: transcript.segments[8]!.text,
    note: '단어 유형당 공유하되 중심과 문맥 역할에 따라 벡터가 따로 있다고 설명한다.',
  };
  return { digest, report, transcript, followup };
}

describe('시간 구간 리포트의 후속 설명', () => {
  it('본문 인용과 이후 원문만 모아 범위 뒤의 관련 후보를 찾는다', () => {
    const { report, transcript } = setup();
    const candidates = findFollowupCandidates(transcript, report);
    expect(candidates[0]).toMatchObject({
      anchor: { key: 0 },
      cite: { key: 8 },
      after: expect.arrayContaining([expect.objectContaining({ i: 8 })]),
    });
    expect(candidates.every((c) => c.cite.from >= 6 && c.before.every((s) => s.i < 6))).toBe(true);
    expect(candidates.some((c) => c.anchor.key === 0 && c.cite.key === 6)).toBe(false);
    transcript.segments[8]!.text = 'Take a break before the classroom changes.';
    expect(findFollowupCandidates(transcript, report).some((c) => c.anchor.key === 0)).toBe(false);
    delete report.options.range;
    expect(findFollowupCandidates(transcript, report)).toEqual([]);
  });

  it('검증한 인용만 별도 필드로 받고 본문 인용의 범위는 그대로 검사한다', () => {
    const { digest, report, transcript, followup } = setup();
    report.followups = [followup];
    const codes = () => lintErrors(lintDigest(digest, transcript)).map((error) => error.code);
    expect(codes()).toEqual([]);
    followup.cite.key = 9;
    expect(codes()).toContain('FOLLOWUP_CITE_SPAN');
    followup.cite.key = 8;
    const bullet = report.sections[0]!.subsections[0]!.bullets[1]!;
    bullet.cite = followup.cite;
    expect(codes()).toContain('BULLET_CITE_OUT_OF_SUBSECTION');
    followup.cite = { key: 0, from: 0, to: 0 };
    expect(codes()).toContain('FOLLOWUP_NOT_AFTER_RANGE');
    followup.cite = { key: 6, from: 6, to: 6 };
    followup.quote = transcript.segments[6]!.text;
    expect(codes()).toContain('FOLLOWUP_CONTEXT_MISSING');
    followup.quote = '이 원문에는 없는 발언이다.';
    expect(codes()).toContain('QUOTE_NOT_IN_SOURCE');
    followup.anchor = { key: 2, from: 2, to: 2 };
    expect(codes()).toContain('FOLLOWUP_ANCHOR_UNKNOWN');
    delete report.options.range;
    expect(codes()).toContain('FOLLOWUP_RANGE_REQUIRED');
  });

  it('보통과 쉬운 보기, 마크다운에서 같은 시각을 열고 정정을 별도로 표시한다', () => {
    const { digest, report, transcript, followup } = setup();
    transcript.segments[10]!.text =
      'I need to correct my earlier statement about word vectors. Each role has its own vector.';
    report.followups = [
      followup,
      {
        ...followup,
        kind: 'correction',
        cite: { key: 10, from: 10, to: 10 },
        quote: transcript.segments[10]!.text,
      },
    ];
    expect(lintErrors(lintDigest(digest, transcript))).toEqual([]);
    const easy = { ...report, options: { ...report.options, difficulty: 'easy' } } as const;
    digest.reports.push(easy);
    const { html } = renderDigestHtml(digest, transcript);
    expect(html.match(/<h2>후속 설명<\/h2>/g)).toHaveLength(2);
    expect(html).toContain('<strong>구체화</strong>');
    expect(html).toContain('<strong>정정</strong>');
    for (const edition of digest.reports) {
      const markdown = renderDigestMarkdown(digest, transcript, { report: edition });
      expect(markdown).toContain('## 후속 설명');
      expect(markdown).toContain('**정정**');
      expect(markdown).toContain('t=0s) → [00:40]');
      expect(markdown).toContain('t=40s)');
      expect(markdown).toContain(followup.quote);
    }
  });
});
