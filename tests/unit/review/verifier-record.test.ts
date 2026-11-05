import { describe, it, expect } from 'vitest';
import { parseVerifierOutput } from '../../../src/review/verifier-record.js';
import { PassthroughReviewEngine } from '../../../src/review/passthrough-engine.js';

/**
 * 검증기 응답은 서브에이전트가 쓴 글이라 JSON만 오지 않는다. 판정을 읽었으면 ran,
 * 하나도 못 읽었으면 failed다. 그 사이를 메인이 고를 칸은 없다.
 */
describe('parseVerifierOutput', () => {
  const body = {
    verifications: [
      { issueId: 'a-1', verdict: 'keep', reason: '안전' },
      { issueId: 'a-2', verdict: 'drop', reason: '이미 없다', evidence: 'a.ts:3' },
    ],
  };

  it('JSON만 온 응답을 읽는다', () => {
    const record = parseVerifierOutput(JSON.stringify(body), 2);

    expect(record.status).toBe('ran');
    expect(record.submitCount).toBe(2);
    expect(record.verdicts).toEqual({
      'a-1': { verdict: 'keep', hasEvidence: false },
      'a-2': { verdict: 'drop', hasEvidence: true },
    });
  });

  it('코드펜스에 싸이거나 앞뒤에 말이 붙어도 읽는다', () => {
    const fenced = `검증 결과입니다.\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n끝.`;
    const prose = `결과: ${JSON.stringify(body)} 이상입니다.`;

    expect(parseVerifierOutput(fenced, 0).status).toBe('ran');
    expect(parseVerifierOutput(prose, 0).status).toBe('ran');
  });

  it('판정 값의 대소문자와 공백은 맞춰 읽는다', () => {
    const record = parseVerifierOutput(
      JSON.stringify({ verifications: [{ issueId: ' a-1 ', verdict: ' KEEP ' }] }),
      0,
    );

    expect(record.verdicts).toEqual({ 'a-1': { verdict: 'keep', hasEvidence: false } });
  });

  it('공백뿐인 근거는 근거로 치지 않는다', () => {
    const record = parseVerifierOutput(
      JSON.stringify({ verifications: [{ issueId: 'a-1', verdict: 'drop', evidence: '  ' }] }),
      0,
    );

    expect(record.verdicts['a-1']!.hasEvidence).toBe(false);
  });

  it('JSON이 없으면 unparseable로 실패한다', () => {
    expect(parseVerifierOutput('Agent 호출이 실패했습니다', 0)).toMatchObject({
      status: 'failed',
      failure: 'unparseable',
    });
  });

  it('읽을 수 있는 판정이 하나도 없으면 no_verifications로 실패한다', () => {
    const output = JSON.stringify({
      verifications: [
        { issueId: '', verdict: 'keep' },
        { issueId: 'a-1', verdict: 'skip' },
        { issueId: 'a-2' },
        'keep',
      ],
    });

    expect(parseVerifierOutput(output, 0)).toMatchObject({
      status: 'failed',
      failure: 'no_verifications',
      verdicts: {},
    });
  });
});

describe('review_verify의 빈 응답', () => {
  it('빈 응답과 공백뿐인 응답은 기록하지 않고 거부한다', () => {
    const engine = new PassthroughReviewEngine();
    const started = engine.startReview({ changedFiles: ['a.ts'], repoRoot: '/repo' }, [], []);
    if (!started.ok) throw started.error;
    const { sessionId } = started.value;

    for (const raw of ['', '   \n', '\u200b', '```\n```']) {
      const result = engine.submitVerification(sessionId, raw);
      expect(result.ok).toBe(false);
    }
    expect(engine.getSession(sessionId).verifier).toBeUndefined();
  });
});

describe('review_fix가 검증 기록을 비운다', () => {
  it('재리뷰로 넘어가면 앞 라운드의 검증 기록이 다음 합의에 안 남는다', () => {
    const engine = new PassthroughReviewEngine();
    const started = engine.startReview({ changedFiles: ['a.ts'], repoRoot: '/repo' }, [], []);
    if (!started.ok) throw started.error;
    const { sessionId } = started.value;

    engine.submitVerification(
      sessionId,
      JSON.stringify({ verifications: [{ issueId: 'x', verdict: 'keep' }] }),
    );
    engine.submitFix(sessionId);
    engine.submitConsensus(sessionId, { mergedIssues: [] });

    const session = engine.getSession(sessionId);
    expect(session.verifier).toBeUndefined();
    expect(session.verifierAtConsensus).toEqual({ status: 'missing' });
  });
});
