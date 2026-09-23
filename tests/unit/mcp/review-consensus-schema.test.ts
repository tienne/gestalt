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

  it('droppedIssues 항목도 mergedIssues와 같은 필수 필드를 요구한다', () => {
    const parsed = parse({
      mergedIssues: [],
      droppedIssues: [{ ...baseIssue, reportedBy: undefined, dropReason: 'r', dropEvidence: 'e' }],
    });

    expect(parsed.success).toBe(false);
  });
});
