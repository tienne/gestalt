import { describe, it, expect } from 'vitest';
import { executeInputSchema } from '../../../src/mcp/schemas.js';

/** review_consensus 입력 스키마가 3.7단계 제안 검증 필드를 받는 꼴을 본다 */

const baseIssue = {
  id: 'i1',
  severity: 'high',
  category: 'quality',
  file: 'src/a.ts',
  line: 3,
  message: 'm',
  suggestion: 's',
  reportedBy: 'quality-reviewer',
} as const;

function parse(reviewConsensus: Record<string, unknown>) {
  return executeInputSchema.safeParse({
    action: 'review_consensus',
    reviewSessionId: 'rs-1',
    reviewConsensus: {
      approvedBy: [],
      blockedBy: [],
      summary: '요약',
      overallApproved: false,
      ...reviewConsensus,
    },
  });
}

describe('reviewConsensus 스키마: 제안 검증 필드', () => {
  it('새 필드가 없는 기존 입력을 그대로 받는다', () => {
    const parsed = parse({ mergedIssues: [baseIssue] });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.reviewConsensus!.droppedIssues).toBeUndefined();
    expect(parsed.data.reviewConsensus!.mergedIssues[0]!.verification).toBeUndefined();
  });

  it('keep과 revise verification을 받는다', () => {
    const parsed = parse({
      mergedIssues: [
        { ...baseIssue, verification: { verdict: 'keep', reason: '안전', alsoCheck: ['b.ts:1'] } },
        {
          ...baseIssue,
          id: 'i2',
          verification: { verdict: 'revise', reason: '깨짐', originalSuggestion: '원래' },
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const [keep, revise] = parsed.data.reviewConsensus!.mergedIssues;
    expect(keep!.verification!.alsoCheck).toEqual(['b.ts:1']);
    expect(revise!.verification!.originalSuggestion).toBe('원래');
  });

  it('verdict drop은 mergedIssues에서 받지 않는다', () => {
    const parsed = parse({
      mergedIssues: [{ ...baseIssue, verification: { verdict: 'drop', reason: '틀림' } }],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((i) => i.path.join('.').endsWith('verification.verdict'))).toBe(
      true,
    );
  });

  it('verification의 reason이 빠지면 받지 않는다', () => {
    const parsed = parse({
      mergedIssues: [{ ...baseIssue, verification: { verdict: 'keep' } }],
    });

    expect(parsed.success).toBe(false);
  });

  it('dropReason과 dropEvidence가 있는 droppedIssues를 받는다', () => {
    const parsed = parse({
      mergedIssues: [],
      droppedIssues: [{ ...baseIssue, dropReason: '규칙 폐지', dropEvidence: 'git log 출력' }],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.reviewConsensus!.droppedIssues![0]!.dropEvidence).toBe('git log 출력');
  });

  it('dropEvidence가 없으면 받지 않는다', () => {
    const parsed = parse({
      mergedIssues: [],
      droppedIssues: [{ ...baseIssue, dropReason: '규칙 폐지' }],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(
      parsed.error.issues.some(
        (i) => i.path.join('.') === 'reviewConsensus.droppedIssues.0.dropEvidence',
      ),
    ).toBe(true);
  });

  it('dropReason이 없거나 빈 문자열이면 받지 않는다', () => {
    expect(
      parse({ mergedIssues: [], droppedIssues: [{ ...baseIssue, dropEvidence: 'e' }] }).success,
    ).toBe(false);
    expect(
      parse({
        mergedIssues: [],
        droppedIssues: [{ ...baseIssue, dropReason: '', dropEvidence: 'e' }],
      }).success,
    ).toBe(false);
  });

  // 공백뿐인 값은 스키마가 아니라 엔진이 거부한다 (suggestion-verification.test.ts)
  it('공백뿐인 dropReason은 스키마를 통과하고 엔진 검사로 넘어간다', () => {
    const parsed = parse({
      mergedIssues: [],
      droppedIssues: [{ ...baseIssue, dropReason: '   ', dropEvidence: 'e' }],
    });

    expect(parsed.success).toBe(true);
  });

  // 나머지 칸은 엔진이 원본에서 채운다 (tests/unit/review/consensus-input.test.ts)
  it('droppedIssues 항목은 id와 dropReason, dropEvidence만 있으면 스키마를 통과한다', () => {
    const parsed = parse({
      mergedIssues: [],
      droppedIssues: [{ id: 'i1', dropReason: 'r', dropEvidence: 'e' }],
    });

    expect(parsed.success).toBe(true);
  });

  it('droppedIssues 항목에 id가 없으면 받지 않는다', () => {
    const { id: _id, ...noId } = baseIssue;
    const parsed = parse({
      mergedIssues: [],
      droppedIssues: [{ ...noId, dropReason: 'r', dropEvidence: 'e' }],
    });

    expect(parsed.success).toBe(false);
  });
});

describe('reviewConsensus 스키마: 엔진이 채우는 칸', () => {
  it('mergedIssues만 있어도 받는다', () => {
    const parsed = executeInputSchema.safeParse({
      action: 'review_consensus',
      reviewSessionId: 'rs-1',
      reviewConsensus: { mergedIssues: [] },
    });

    expect(parsed.success).toBe(true);
  });

  it('reportedBy가 비어도 받는다', () => {
    const { reportedBy: _by, ...noReporter } = baseIssue;
    expect(parse({ mergedIssues: [noReporter] }).success).toBe(true);
  });

  it('reportedBy 배열은 첫 값으로 받는다', () => {
    const parsed = parse({ mergedIssues: [{ ...baseIssue, reportedBy: ['a', 'b'] }] });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.reviewConsensus!.mergedIssues[0]!.reportedBy).toBe('a');
  });

  it('reportedBy 배열의 첫 값이 문자열이 아니면 받지 않는다', () => {
    expect(parse({ mergedIssues: [{ ...baseIssue, reportedBy: [1, 'b'] }] }).success).toBe(false);
  });

  it('두 번 파싱해도 결과가 같다', () => {
    const once = parse({
      mergedIssues: [
        {
          ...baseIssue,
          reportedBy: ['a', 'b'],
          verification: { verdict: 'keep', reason: 'r', alsoCheck: 'x.ts:1' },
        },
      ],
    });
    expect(once.success).toBe(true);
    if (!once.success) return;
    const twice = executeInputSchema.safeParse(once.data);

    expect(twice.success).toBe(true);
    if (!twice.success) return;
    expect(twice.data.reviewConsensus).toEqual(once.data.reviewConsensus);
  });
});
