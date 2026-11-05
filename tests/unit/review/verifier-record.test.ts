import { describe, it, expect } from 'vitest';
import {
  checkConsensusAgainstVerifier,
  parseVerifierOutput,
} from '../../../src/review/verifier-record.js';
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

  it('이슈 id는 대소문자와 앞뒤 공백을 맞춰 담는다', () => {
    const record = parseVerifierOutput(
      JSON.stringify({ verifications: [{ issueId: ' A-1 ', verdict: 'keep' }] }),
      0,
    );

    expect(Object.keys(record.verdicts)).toEqual(['a-1']);
  });

  it('__proto__ 같은 id도 판정으로 남는다', () => {
    const record = parseVerifierOutput(
      '{"verifications":[{"issueId":"__proto__","verdict":"drop","evidence":"a.ts:1"}]}',
      0,
    );

    expect(record.status).toBe('ran');
    expect(Object.hasOwn(record.verdicts, '__proto__')).toBe(true);
    expect(record.verdicts['__proto__']).toEqual({ verdict: 'drop', hasEvidence: true });
  });

  it('같은 id가 두 번 오면 이슈를 더 지키는 판정을 남기고 겹친 수를 센다', () => {
    const record = parseVerifierOutput(
      JSON.stringify({
        verifications: [
          { issueId: 'a-1', verdict: 'keep' },
          { issueId: 'A-1', verdict: 'drop', evidence: 'a.ts:3' },
        ],
      }),
      0,
    );

    expect(record.duplicateCount).toBe(1);
    expect(record.skippedCount).toBe(0);
    expect(record.verdicts['a-1']).toEqual({ verdict: 'keep', hasEvidence: false });
  });

  it('응답 앞에 근거 붙은 drop이 있어도 뒤의 keep이 이긴다', () => {
    const record = parseVerifierOutput(
      JSON.stringify([
        { issueId: 'a-1', verdict: 'drop', evidence: 'a.ts:3' },
        { issueId: 'a-1', verdict: 'keep' },
      ]),
      0,
    );

    expect(record.verdicts['a-1']!.verdict).toBe('keep');
  });

  it('drop끼리 겹치면 근거 없는 쪽을 남긴다', () => {
    const withEvidenceFirst = parseVerifierOutput(
      JSON.stringify([
        { issueId: 'a-1', verdict: 'drop', evidence: 'a.ts:3' },
        { issueId: 'a-1', verdict: 'drop' },
      ]),
      0,
    );
    const withEvidenceLast = parseVerifierOutput(
      JSON.stringify([
        { issueId: 'a-1', verdict: 'drop' },
        { issueId: 'a-1', verdict: 'drop', evidence: 'a.ts:3' },
      ]),
      0,
    );

    expect(withEvidenceFirst.verdicts['a-1']!.hasEvidence).toBe(false);
    expect(withEvidenceLast.verdicts['a-1']!.hasEvidence).toBe(false);
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
      skippedCount: 4,
    });
  });

  it('일부만 읽히면 ran으로 두고 못 읽은 수를 센다', () => {
    const output = JSON.stringify({
      verifications: [
        { issueId: 'a-1', verdict: 'keep' },
        { issueId: 'a-2', verdict: 'skip' },
      ],
    });

    expect(parseVerifierOutput(output, 0)).toMatchObject({ status: 'ran', skippedCount: 1 });
  });
});

describe('checkConsensusAgainstVerifier', () => {
  const issue = (id: string) => ({
    id,
    severity: 'warning' as const,
    category: 'quality' as const,
    file: 'a.ts',
    message: '문제',
    suggestion: '고치기',
    reportedBy: 'quality-reviewer',
  });

  it('합의 id의 대소문자와 앞뒤 공백이 달라도 같은 이슈의 판정으로 찾는다', () => {
    const record = parseVerifierOutput(
      JSON.stringify([
        { issueId: 'g-1', verdict: 'keep' },
        { issueId: 'g-2', verdict: 'drop', evidence: 'a.ts:3' },
      ]),
      1,
    );

    const problem = checkConsensusAgainstVerifier(
      { status: 'ran', record },
      {
        mergedIssues: [issue(' G-1 ')],
        droppedIssues: [{ ...issue(' G-2 '), dropReason: '이미 고쳐짐', dropEvidence: 'a.ts:3' }],
      },
    );

    expect(problem).toBeNull();
  });

  it('프로토타입이 없는 판정 객체가 일반 객체로 바뀌어도 상속된 속성 이름을 판정으로 읽지 않는다', () => {
    const parsed = parseVerifierOutput(
      JSON.stringify({ verifications: [{ issueId: 'x', verdict: 'keep' }] }),
      1,
    );
    const record = { ...parsed, verdicts: { ...parsed.verdicts } };

    const problem = checkConsensusAgainstVerifier(
      { status: 'ran', record },
      { mergedIssues: [issue('constructor'), issue('toString')] },
    );

    expect(problem).toContain('하나도 안 맞는다');
  });

  it('JSON에서 되살린 기록이어도 상속된 이름으로 drop을 통과시키지 않는다', () => {
    const record = JSON.parse(
      JSON.stringify(
        parseVerifierOutput(
          JSON.stringify({ verifications: [{ issueId: 'x', verdict: 'keep' }] }),
          1,
        ),
      ),
    );

    const problem = checkConsensusAgainstVerifier(
      { status: 'ran', record },
      {
        mergedIssues: [
          {
            id: 'x',
            severity: 'warning',
            category: 'quality',
            file: 'a.ts',
            message: '문제',
            suggestion: '고치기',
            reportedBy: 'quality-reviewer',
          },
        ],
        droppedIssues: [
          {
            id: 'constructor',
            severity: 'warning',
            category: 'quality',
            file: 'a.ts',
            message: '문제',
            suggestion: '고치기',
            reportedBy: 'quality-reviewer',
            dropReason: '이미 고쳐짐',
            dropEvidence: 'a.ts:1',
          },
        ],
      },
    );

    expect(problem).toContain('constructor: 검증기 응답에 없는 이슈라 뺄 수 없다');
  });
});

describe('review_verify의 빈 응답', () => {
  it('빈 응답과 공백뿐인 응답은 기록하지 않고 거부한다', () => {
    const engine = new PassthroughReviewEngine();
    const started = engine.startReview({ changedFiles: ['a.ts'], repoRoot: '/repo' }, [], []);
    if (!started.ok) throw started.error;
    const { sessionId } = started.value;

    for (const raw of [
      '',
      '   \n',
      '\u200b',
      '```\n```',
      '```json\n```',
      '```JSON\n\n```',
      '[]',
      '{}',
    ]) {
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
