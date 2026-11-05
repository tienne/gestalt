import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { EventStore } from '../../../src/events/store.js';
import { PassthroughReviewEngine } from '../../../src/review/passthrough-engine.js';
import { executeInputSchema } from '../../../src/mcp/schemas.js';
import type { ReviewIssue } from '../../../src/core/types.js';

/**
 * review_consensus가 모양만 어긋난 입력을 거부하지 않고 받는지 본다.
 *
 * 실제 호출처럼 스키마를 먼저 지나고 엔진에 들어간다. 받는 쪽은 채운 값이 맞는지까지 본다.
 * 거부하는 쪽은 그 id를 짚는지 본다. 뺀 이슈는 칸을 비우거나 낮춰 적어 금지를 피하는 입력을
 * 직접 넣어 본다.
 */

function original(overrides: Partial<ReviewIssue> & Pick<ReviewIssue, 'id'>): ReviewIssue {
  return {
    severity: 'high',
    category: 'quality',
    file: 'src/a.ts',
    line: 10,
    message: `문제 ${overrides.id}`,
    suggestion: `제안 ${overrides.id}`,
    reportedBy: 'quality-reviewer',
    ...overrides,
  };
}

const EVIDENCE = {
  dropReason: '근거로 든 규칙이 base에 없다',
  dropEvidence: 'git show abc:docs/r.md',
};

describe('review_consensus 입력 채우기', () => {
  let dbPath: string;
  let store: EventStore;
  let engine: PassthroughReviewEngine;

  beforeEach(() => {
    dbPath = `.gestalt-test/consensus-input-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughReviewEngine(store);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  /** 리뷰를 열고 리뷰어별 원본을 review_submit으로 넣는다. approved는 이슈가 없을 때만 true다 */
  function open(originals: Record<string, Omit<ReviewIssue, 'reportedBy'>[]>): string {
    const started = engine.startReview({ changedFiles: ['src/a.ts'], repoRoot: '/repo' }, [], []);
    if (!started.ok) throw started.error;
    const sessionId = started.value.sessionId;
    for (const [agentName, issues] of Object.entries(originals)) {
      engine.submitReview(sessionId, agentName, {
        agentName,
        issues: issues.map((i) => ({ ...i, reportedBy: agentName })),
        approved: issues.length === 0,
        summary: `${agentName} 요약`,
      });
    }
    return sessionId;
  }

  /** 스키마를 지난 값으로 엔진을 부른다. 스키마에서 걸리면 그 에러를 던진다 */
  function call(sessionId: string, args: Record<string, unknown>) {
    const parsed = executeInputSchema.safeParse({
      action: 'review_consensus',
      reviewSessionId: sessionId,
      ...args,
    });
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    return engine.submitConsensus(
      sessionId,
      parsed.data.reviewConsensus!,
      parsed.data.continuityVerdict,
    );
  }

  function accepted(sessionId: string, args: Record<string, unknown>) {
    const result = call(sessionId, args);
    if (!result.ok) throw result.error;
    return { ...result.value, consensus: engine.getSession(sessionId).consensus! };
  }

  function rejected(sessionId: string, args: Record<string, unknown>): string {
    const result = call(sessionId, args);
    expect(result.ok, '거부돼야 할 입력이 통과했다').toBe(false);
    if (result.ok) return '';
    expect(engine.getSession(sessionId).consensus, '거부된 호출이 합의를 남겼다').toBeUndefined();
    return result.error.message;
  }

  const issueOf = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    severity: 'high',
    category: 'quality',
    file: 'src/a.ts',
    message: `문제 ${id}`,
    suggestion: `제안 ${id}`,
    ...extra,
  });

  describe('mergedIssues[].reportedBy', () => {
    it('비었으면 같은 id 원본의 리뷰어로 채운다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
      const { consensus } = accepted(sid, { reviewConsensus: { mergedIssues: [issueOf('q1')] } });
      expect(consensus.mergedIssues[0]!.reportedBy).toBe('quality-reviewer');
    });

    it('비었으면 `<reportedBy>:<원래 id>` 꼴 id의 접두 원본으로 채운다', () => {
      const sid = open({
        'quality-reviewer': [original({ id: 'i1' })],
        'security-reviewer': [original({ id: 'i1', category: 'perf' })],
      });
      const { consensus } = accepted(sid, {
        reviewConsensus: { mergedIssues: [issueOf('security-reviewer:i1')] },
      });
      expect(consensus.mergedIssues[0]!.reportedBy).toBe('security-reviewer');
    });

    it('배열로 오면 첫 값을 쓴다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
      const { consensus } = accepted(sid, {
        reviewConsensus: {
          mergedIssues: [issueOf('q1', { reportedBy: ['comment-reviewer', 'quality-reviewer'] })],
        },
      });
      expect(consensus.mergedIssues[0]!.reportedBy).toBe('comment-reviewer');
    });

    it('빈 배열은 안 보낸 것으로 보고 원본에서 채운다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
      const { consensus } = accepted(sid, {
        reviewConsensus: { mergedIssues: [issueOf('q1', { reportedBy: [] })] },
      });
      expect(consensus.mergedIssues[0]!.reportedBy).toBe('quality-reviewer');
    });

    it('같은 id 원본이 여러 리뷰어에게 있으면 고르지 않고 reportedBy를 적으라고 거부한다', () => {
      const sid = open({
        'quality-reviewer': [original({ id: 'issue-1' })],
        'comment-reviewer': [original({ id: 'issue-1', file: 'src/c.ts' })],
      });
      const message = rejected(sid, { reviewConsensus: { mergedIssues: [issueOf('issue-1')] } });
      expect(message).toContain('issue-1');
      expect(message).toContain('reportedBy를 직접 적는다');
    });

    it('같은 리뷰어가 같은 id를 두 번 냈으면 그 리뷰어로 채운다', () => {
      const sid = open({
        'quality-reviewer': [original({ id: 'q1' }), original({ id: 'q1', line: 20 })],
      });
      const { consensus } = accepted(sid, { reviewConsensus: { mergedIssues: [issueOf('q1')] } });
      expect(consensus.mergedIssues[0]!.reportedBy).toBe('quality-reviewer');
    });

    it('비었는데 원본이 없으면 그 id를 짚어 거부한다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
      const message = rejected(sid, {
        reviewConsensus: { mergedIssues: [issueOf('q1'), issueOf('ghost-7')] },
      });
      expect(message).toContain('ghost-7');
      expect(message).toContain('reportedBy');
      expect(message).not.toContain('q1');
    });
  });

  describe('mergedIssues[].reportedBy의 빈 문자열', () => {
    it('빈 문자열과 공백뿐인 값은 안 적은 것으로 보고 원본에서 채운다', () => {
      for (const blank of ['', '   ', '\t', '\u200b', '\u3164', '-']) {
        const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
        const { consensus } = accepted(sid, {
          reviewConsensus: { mergedIssues: [issueOf('q1', { reportedBy: blank })] },
        });
        expect(consensus.mergedIssues[0]!.reportedBy).toBe('quality-reviewer');
      }
    });

    it('빈 문자열이고 원본도 없으면 작성자 이름 칸을 적으라고 거부한다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
      const message = rejected(sid, {
        reviewConsensus: { mergedIssues: [issueOf('q1'), issueOf('ghost-7', { reportedBy: '' })] },
      });
      expect(message).toContain('ghost-7');
    });

    it('droppedIssues도 빈 문자열을 안 적은 것으로 보고 원본에서 채운다', () => {
      for (const blank of ['', '\u200b', '\u3164']) {
        const sid = open({ 'quality-reviewer': [original({ id: 'q1', severity: 'warning' })] });
        const { consensus } = accepted(sid, {
          reviewConsensus: {
            mergedIssues: [],
            droppedIssues: [{ id: 'q1', reportedBy: blank, ...EVIDENCE }],
          },
        });
        expect(consensus.droppedIssues![0]!.reportedBy).toBe('quality-reviewer');
      }
    });

    it('droppedIssues의 공백뿐인 reportedBy도 안 적은 것과 같게 여러 리뷰어 원본을 고르지 않는다', () => {
      const sid = open({
        'quality-reviewer': [original({ id: 'i1', severity: 'warning' })],
        'comment-reviewer': [original({ id: 'i1', severity: 'warning' })],
      });
      const message = rejected(sid, {
        reviewConsensus: {
          mergedIssues: [],
          droppedIssues: [{ id: 'i1', reportedBy: '  ', ...EVIDENCE }],
        },
      });
      expect(message).toContain('여러 리뷰어');
    });
  });

  describe('critical이나 security 원본이 합의에서 빠지는 길', () => {
    it('critical 원본이 있는데 mergedIssues가 비면 그 원본을 짚어 거부한다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1', severity: 'critical' })] });
      const message = rejected(sid, { reviewConsensus: { mergedIssues: [] } });
      expect(message).toContain('quality-reviewer:q1');
      expect(message).toContain('mergedIssues에 없다');
    });

    it('security 원본을 빼고 warning만 남긴 합의도 거부한다', () => {
      const sid = open({
        'security-reviewer': [original({ id: 's1', category: 'security', severity: 'high' })],
        'quality-reviewer': [original({ id: 'q1', severity: 'warning' })],
      });
      const message = rejected(sid, {
        reviewConsensus: { mergedIssues: [issueOf('q1', { severity: 'warning' })] },
      });
      expect(message).toContain('security-reviewer:s1');
      expect(message).not.toContain('quality-reviewer:q1');
    });

    it('검증 기록이 ran이어도 같은 이유로 거부한다', () => {
      const sid = open({ 'security-reviewer': [original({ id: 's1', category: 'security' })] });
      engine.submitVerification(sid, JSON.stringify([{ issueId: 's1', verdict: 'keep' }]));
      const message = rejected(sid, { reviewConsensus: { mergedIssues: [] } });
      expect(message).toContain('security-reviewer:s1');
    });

    it('같은 id나 접두 꼴 id로 이어 두면 통과한다', () => {
      const sid = open({
        'security-reviewer': [original({ id: 'i1', category: 'security', severity: 'critical' })],
        'quality-reviewer': [original({ id: 'i1', severity: 'warning' })],
      });
      accepted(sid, {
        reviewConsensus: {
          mergedIssues: [issueOf('security-reviewer:i1', { severity: 'critical' })],
        },
      });
    });

    it('같은 id로 이었어도 severity를 낮췄으면 낮아졌다고 짚어 거부한다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1', severity: 'critical' })] });
      const message = rejected(sid, {
        reviewConsensus: { mergedIssues: [issueOf('q1', { severity: 'warning' })] },
      });
      expect(message).toContain('quality-reviewer:q1');
      expect(message).toContain('낮아졌다');
    });

    it('같은 id로 이었어도 security category를 바꿨으면 거부한다', () => {
      const sid = open({
        'security-reviewer': [original({ id: 's1', category: 'security', severity: 'high' })],
      });
      const message = rejected(sid, {
        reviewConsensus: { mergedIssues: [issueOf('s1', { category: 'style' })] },
      });
      expect(message).toContain('security-reviewer:s1');
      expect(message).toContain('낮아졌다');
    });

    it('security category는 그대로 두고 severity만 낮춰도 거부한다', () => {
      const sid = open({
        'security-reviewer': [original({ id: 's1', category: 'security', severity: 'high' })],
      });
      const message = rejected(sid, {
        reviewConsensus: {
          mergedIssues: [issueOf('s1', { category: 'security', severity: 'warning' })],
        },
      });
      expect(message).toContain('security-reviewer:s1');
      expect(message).toContain('낮아졌다');
    });

    it('critical 원본을 category에 security만 끼워 warning으로 낮춰도 거부한다', () => {
      const sid = open({
        'quality-reviewer': [original({ id: 'q1', category: 'bug', severity: 'critical' })],
      });
      const message = rejected(sid, {
        reviewConsensus: {
          mergedIssues: [issueOf('q1', { category: 'security-note', severity: 'warning' })],
        },
      });
      expect(message).toContain('quality-reviewer:q1');
      expect(message).toContain('낮아졌다');
    });

    it('접두 없이 같은 id를 쓴 두 원본을 낮은 이슈 하나로 이어도 높은 쪽 원본을 거부한다', () => {
      const sid = open({
        'security-reviewer': [original({ id: 'x1', category: 'security', severity: 'warning' })],
        'quality-reviewer': [original({ id: 'x1', category: 'bug', severity: 'critical' })],
      });
      const message = rejected(sid, {
        reviewConsensus: {
          mergedIssues: [
            issueOf('x1', {
              category: 'security',
              severity: 'warning',
              reportedBy: 'security-reviewer',
            }),
          ],
        },
      });
      expect(message).toContain('quality-reviewer:x1');
      expect(message).not.toContain('security-reviewer:x1');
    });

    it('id가 다른 두 security 원본을 하나로만 이으면 접힌 쪽 원본을 거부한다', () => {
      const sid = open({
        'security-reviewer': [original({ id: 's1', category: 'security', severity: 'high' })],
        'quality-reviewer': [original({ id: 'q3', category: 'security', severity: 'high' })],
      });
      const message = rejected(sid, {
        reviewConsensus: {
          mergedIssues: [
            issueOf('s1', {
              category: 'security',
              severity: 'high',
              reportedBy: 'security-reviewer',
            }),
          ],
        },
      });
      expect(message).toContain('quality-reviewer:q3');
      expect(message).toContain('mergedIssues에 없다');
      expect(message).not.toContain('security-reviewer:s1');
    });

    it('id가 다른 두 security 원본을 각자 id로 두면 통과한다', () => {
      const sid = open({
        'security-reviewer': [original({ id: 's1', category: 'security', severity: 'high' })],
        'quality-reviewer': [original({ id: 'q3', category: 'security', severity: 'high' })],
      });
      accepted(sid, {
        reviewConsensus: {
          mergedIssues: [
            issueOf('s1', {
              category: 'security',
              severity: 'high',
              reportedBy: 'security-reviewer',
            }),
            issueOf('q3', {
              category: 'security',
              severity: 'high',
              reportedBy: 'quality-reviewer',
            }),
          ],
        },
      });
    });

    it('원본보다 높은 severity로 올려 이으면 통과한다', () => {
      const sid = open({
        'security-reviewer': [original({ id: 's1', category: 'security', severity: 'high' })],
      });
      accepted(sid, {
        reviewConsensus: {
          mergedIssues: [issueOf('s1', { category: 'security', severity: 'critical' })],
        },
      });
    });

    it('security 원본을 critical로 올리면 category가 bug로 바뀌어도 통과한다', () => {
      const sid = open({
        'security-reviewer': [original({ id: 's1', category: 'security', severity: 'high' })],
      });
      accepted(sid, {
        reviewConsensus: {
          mergedIssues: [issueOf('s1', { category: 'bug', severity: 'critical' })],
        },
      });
    });

    it.each([
      ['critical 원본', { id: 'q1', category: 'bug', severity: 'critical' }, 'quality-reviewer'],
      [
        'security/high 원본',
        { id: 's1', category: 'security', severity: 'high' },
        'security-reviewer',
      ],
    ] as const)('%s을 revise 판정을 달고 warning으로 낮춰도 거부한다', (_label, origin, agent) => {
      const sid = open({ [agent]: [original({ ...origin })] });
      const message = rejected(sid, {
        reviewConsensus: {
          mergedIssues: [
            issueOf(origin.id, {
              category: origin.category,
              severity: 'warning',
              verification: {
                verdict: 'revise',
                reason: '전제는 맞지만 제안을 고쳐야 한다',
                originalSuggestion: `제안 ${origin.id}`,
              },
            }),
          ],
        },
      });
      expect(message).toContain(`${agent}:${origin.id}`);
      expect(message).toContain('낮아졌다');
    });

    it('접두 꼴 id로 낮춰 이어도 거부한다', () => {
      const sid = open({ 'security-reviewer': [original({ id: 's1', category: 'security' })] });
      rejected(sid, {
        reviewConsensus: {
          mergedIssues: [
            issueOf('security-reviewer:s1', { category: 'style', severity: 'warning' }),
          ],
        },
      });
    });

    it('리뷰어 둘이 같은 id를 쓰고 접두 꼴로 따로 두면 각자 이어져 통과한다', () => {
      const sid = open({
        'security-reviewer': [original({ id: 'i1', category: 'security', severity: 'critical' })],
        'quality-reviewer': [original({ id: 'i1', severity: 'warning' })],
      });
      accepted(sid, {
        reviewConsensus: {
          mergedIssues: [
            issueOf('security-reviewer:i1', { severity: 'critical' }),
            issueOf('quality-reviewer:i1', { severity: 'warning' }),
          ],
        },
      });
    });

    it('같은 id의 원본 여럿 가운데 critical이 하나뿐이어도 이은 이슈가 critical이면 통과한다', () => {
      const sid = open({
        'security-reviewer': [original({ id: 'x1', severity: 'critical' })],
        'quality-reviewer': [original({ id: 'x1', severity: 'warning' })],
      });
      accepted(sid, {
        reviewConsensus: {
          mergedIssues: [issueOf('x1', { severity: 'critical', reportedBy: 'security-reviewer' })],
        },
      });
    });

    it('critical을 냈다가 이슈를 비워 다시 낸 리뷰어도 원본이 남아 mergedIssues []를 거부한다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1', severity: 'critical' })] });
      engine.submitReview(sid, 'quality-reviewer', {
        agentName: 'quality-reviewer',
        issues: [],
        approved: true,
        summary: '다시 봤다',
      });
      const message = rejected(sid, { reviewConsensus: { mergedIssues: [] } });
      expect(message).toContain('quality-reviewer:q1');
    });

    it('warning 원본만 있으면 mergedIssues를 비워도 통과한다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1', severity: 'warning' })] });
      accepted(sid, { reviewConsensus: { mergedIssues: [] } });
    });

    it('review_submit이 없으면 mergedIssues를 비워도 통과한다', () => {
      const sid = open({});
      accepted(sid, { reviewConsensus: { mergedIssues: [] } });
    });
  });

  describe('엔진이 세는 칸', () => {
    it('approvedBy와 blockedBy가 비면 review_submit의 approved로 채운다', () => {
      const sid = open({
        'quality-reviewer': [original({ id: 'q1' })],
        'comment-reviewer': [],
      });
      const { consensus, report } = accepted(sid, {
        reviewConsensus: { mergedIssues: [issueOf('q1')] },
      });
      expect(consensus.approvedBy).toEqual(['comment-reviewer']);
      expect(consensus.blockedBy).toEqual(['quality-reviewer']);
      expect(report.markdown).toContain('**Blocked by**: quality-reviewer');
    });

    it('같은 리뷰어가 두 번 냈으면 마지막 판정을 쓴다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
      engine.submitReview(sid, 'quality-reviewer', {
        agentName: 'quality-reviewer',
        issues: [],
        approved: true,
        summary: '다시 봤다',
      });
      const { consensus } = accepted(sid, { reviewConsensus: { mergedIssues: [] } });
      expect(consensus.approvedBy).toEqual(['quality-reviewer']);
      expect(consensus.blockedBy).toEqual([]);
    });

    it('적어 보낸 approvedBy와 blockedBy는 그대로 둔다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
      const { consensus } = accepted(sid, {
        reviewConsensus: {
          mergedIssues: [issueOf('q1')],
          approvedBy: ['a'],
          blockedBy: ['b'],
        },
      });
      expect(consensus.approvedBy).toEqual(['a']);
      expect(consensus.blockedBy).toEqual(['b']);
    });

    it('approvedBy와 blockedBy에 []를 적어 보내면 투표로 채우지 않고 그대로 둔다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
      const { consensus } = accepted(sid, {
        reviewConsensus: { mergedIssues: [issueOf('q1')], approvedBy: [], blockedBy: [] },
      });
      expect(consensus.approvedBy).toEqual([]);
      expect(consensus.blockedBy).toEqual([]);
    });

    it('채움 문자와 섞인 자모와 정상 조합 자모는 내용으로 보고 그대로 쓴다', () => {
      for (const summary of ['\u1100\u1160', '\u1100\u1161']) {
        const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
        const { consensus } = accepted(sid, {
          reviewConsensus: { mergedIssues: [issueOf('q1')], summary },
        });
        expect(consensus.summary).toBe(summary);
      }
    });

    it('summary가 비면 이슈 수로 채운다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1' }), original({ id: 'q2' })] });
      const { consensus } = accepted(sid, {
        reviewConsensus: {
          mergedIssues: [issueOf('q1', { severity: 'warning' })],
          droppedIssues: [{ id: 'q2', ...EVIDENCE }],
        },
      });
      expect(consensus.summary).toContain('이슈 1개(critical 0, high 0, warning 1), 뺀 이슈 1개');
    });

    it('summary가 공백이나 제로폭 문자뿐이어도 이슈 수로 채운다', () => {
      for (const blank of ['', '   ', '\u200b', '\u3164', '\u115f\u1160\uffa0']) {
        const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
        const { consensus } = accepted(sid, {
          reviewConsensus: {
            mergedIssues: [issueOf('q1', { severity: 'warning' })],
            summary: blank,
          },
        });
        expect(consensus.summary).toContain('이슈 1개(critical 0, high 0, warning 1)');
      }
    });

    it('overallApproved가 비어도 엔진이 판정한다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
      const { approved, consensus } = accepted(sid, {
        reviewConsensus: { mergedIssues: [issueOf('q1')] },
      });
      expect(approved).toBe(false);
      expect(consensus.overallApproved).toBe(false);
    });

    it('overallApproved를 true로 보내도 high가 남으면 막는다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
      const { approved, consensus } = accepted(sid, {
        reviewConsensus: { mergedIssues: [issueOf('q1')], overallApproved: true },
      });
      expect(approved).toBe(false);
      expect(consensus.overallApproved).toBe(false);
    });

    it('mergedIssues는 비워 보낼 수 없다. 빈 배열로 채우면 판정이 통과로 바뀐다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
      expect(() => call(sid, { reviewConsensus: { summary: 's' } })).toThrow(
        /reviewConsensus\.mergedIssues/,
      );
    });
  });

  describe('verification.alsoCheck', () => {
    it('문자열 하나로 오면 한 칸짜리 배열로 받는다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
      const { consensus } = accepted(sid, {
        reviewConsensus: {
          mergedIssues: [
            issueOf('q1', { verification: { verdict: 'keep', reason: 'r', alsoCheck: 'b.ts:3' } }),
          ],
        },
      });
      expect(consensus.mergedIssues[0]!.verification!.alsoCheck).toEqual(['b.ts:3']);
    });

    it('숫자처럼 문자열도 배열도 아니면 거부한다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
      expect(() =>
        call(sid, {
          reviewConsensus: {
            mergedIssues: [
              issueOf('q1', { verification: { verdict: 'keep', reason: 'r', alsoCheck: 3 } }),
            ],
          },
        }),
      ).toThrow(/alsoCheck/);
    });
  });

  describe('droppedIssues의 빈 칸', () => {
    it('severity, category, file, message, suggestion, reportedBy를 원본에서 채운다', () => {
      const sid = open({
        'quality-reviewer': [original({ id: 'q1', severity: 'warning', file: 'src/b.ts' })],
      });
      const { consensus } = accepted(sid, {
        reviewConsensus: { mergedIssues: [], droppedIssues: [{ id: 'q1', ...EVIDENCE }] },
      });
      expect(consensus.droppedIssues![0]).toMatchObject({
        id: 'q1',
        severity: 'warning',
        category: 'quality',
        file: 'src/b.ts',
        message: '문제 q1',
        suggestion: '제안 q1',
        reportedBy: 'quality-reviewer',
        ...EVIDENCE,
      });
    });

    it('적어 보낸 칸은 원본 값으로 덮지 않는다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
      const { consensus } = accepted(sid, {
        reviewConsensus: {
          mergedIssues: [],
          droppedIssues: [{ id: 'q1', message: '병합하며 고친 문장', ...EVIDENCE }],
        },
      });
      expect(consensus.droppedIssues![0]!.message).toBe('병합하며 고친 문장');
      expect(consensus.droppedIssues![0]!.severity).toBe('high');
    });

    it('`<reportedBy>:<원래 id>` 꼴 id도 접두 원본에서 채운다', () => {
      const sid = open({
        'quality-reviewer': [original({ id: 'i1', file: 'src/q.ts' })],
        'comment-reviewer': [original({ id: 'i1', file: 'src/c.ts' })],
      });
      const { consensus } = accepted(sid, {
        reviewConsensus: {
          mergedIssues: [],
          droppedIssues: [{ id: 'comment-reviewer:i1', ...EVIDENCE }],
        },
      });
      expect(consensus.droppedIssues![0]!.file).toBe('src/c.ts');
      expect(consensus.droppedIssues![0]!.reportedBy).toBe('comment-reviewer');
    });

    it('같은 id 원본이 여러 리뷰어에게 있고 reportedBy가 비면 거부한다', () => {
      const sid = open({
        'quality-reviewer': [original({ id: 'issue-1', severity: 'warning', file: 'src/q.ts' })],
        'comment-reviewer': [original({ id: 'issue-1', severity: 'warning', file: 'src/c.ts' })],
      });
      const message = rejected(sid, {
        reviewConsensus: { mergedIssues: [], droppedIssues: [{ id: 'issue-1', ...EVIDENCE }] },
      });
      expect(message).toContain('issue-1');
      expect(message).toContain('reportedBy를 직접 적는다');
    });

    it('reportedBy를 적으면 그 리뷰어의 원본으로 채운다', () => {
      const sid = open({
        'quality-reviewer': [original({ id: 'issue-1', severity: 'warning', file: 'src/q.ts' })],
        'comment-reviewer': [
          original({ id: 'issue-1', severity: 'warning', file: 'src/c.ts', message: '주석 문제' }),
        ],
      });
      const { consensus } = accepted(sid, {
        reviewConsensus: {
          mergedIssues: [],
          droppedIssues: [{ id: 'issue-1', reportedBy: 'comment-reviewer', ...EVIDENCE }],
        },
      });
      expect(consensus.droppedIssues![0]).toMatchObject({
        file: 'src/c.ts',
        message: '주석 문제',
        reportedBy: 'comment-reviewer',
      });
    });

    it('적은 reportedBy의 원본이 없으면 다른 리뷰어 원본으로 채우지 않는다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1', severity: 'warning' })] });
      const message = rejected(sid, {
        reviewConsensus: {
          mergedIssues: [],
          droppedIssues: [{ id: 'q1', reportedBy: 'comment-reviewer', ...EVIDENCE }],
        },
      });
      expect(message).toContain('comment-reviewer가 낸 같은 id의 review_submit 원본이 없어');
    });

    it('빈 칸이 있는데 원본이 없으면 그 id와 빈 칸을 짚어 거부한다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1' })] });
      const message = rejected(sid, {
        reviewConsensus: {
          mergedIssues: [],
          droppedIssues: [{ id: 'nowhere-3', category: 'quality', ...EVIDENCE }],
        },
      });
      expect(message).toContain('nowhere-3');
      expect(message).toContain('severity');
      expect(message).toContain('채울 수 없다');
    });

    it('칸을 다 적었으면 원본이 없어도 예전처럼 받는다', () => {
      const sid = open({ 'quality-reviewer': [] });
      const { consensus } = accepted(sid, {
        reviewConsensus: {
          mergedIssues: [],
          droppedIssues: [{ ...issueOf('free-1'), reportedBy: 'quality-reviewer', ...EVIDENCE }],
        },
      });
      expect(consensus.droppedIssues).toHaveLength(1);
    });
  });

  // 칸을 비우거나 낮춰 적어서 금지를 피하는 입력. 전부 거부돼야 한다
  describe('droppedIssues 우회 시도', () => {
    it('critical 원본의 severity를 비워 보내면 거부한다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1', severity: 'critical' })] });
      const message = rejected(sid, {
        reviewConsensus: { mergedIssues: [], droppedIssues: [{ id: 'q1', ...EVIDENCE }] },
      });
      expect(message).toContain('q1: review_submit 원본이 critical/quality라 뺄 수 없다');
    });

    it('critical 원본의 severity를 warning으로 낮춰 보내면 거부한다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1', severity: 'critical' })] });
      const message = rejected(sid, {
        reviewConsensus: {
          mergedIssues: [],
          droppedIssues: [{ id: 'q1', severity: 'warning', ...EVIDENCE }],
        },
      });
      expect(message).toContain('원본이 critical/quality라 뺄 수 없다');
    });

    it('security 원본의 category를 비워 보내면 거부한다', () => {
      const sid = open({
        'security-reviewer': [original({ id: 's1', severity: 'warning', category: 'security' })],
      });
      const message = rejected(sid, {
        reviewConsensus: { mergedIssues: [], droppedIssues: [{ id: 's1', ...EVIDENCE }] },
      });
      expect(message).toContain('원본이 warning/security라 뺄 수 없다');
    });

    it('security 원본의 category를 quality로 바꾸고 severity도 비워 보내면 거부한다', () => {
      const sid = open({
        'security-reviewer': [original({ id: 's1', severity: 'high', category: 'appsec' })],
      });
      const message = rejected(sid, {
        reviewConsensus: {
          mergedIssues: [],
          droppedIssues: [{ id: 's1', category: 'quality', ...EVIDENCE }],
        },
      });
      expect(message).toContain('원본이 high/appsec라 뺄 수 없다');
    });

    it('접두 꼴 id로 critical 원본을 가리키며 칸을 비워도 거부한다', () => {
      const sid = open({
        'quality-reviewer': [original({ id: 'i1', severity: 'warning' })],
        'performance-reviewer': [original({ id: 'i1', severity: 'critical', category: 'perf' })],
      });
      const message = rejected(sid, {
        reviewConsensus: {
          mergedIssues: [],
          droppedIssues: [{ id: 'performance-reviewer:i1', ...EVIDENCE }],
        },
      });
      expect(message).toContain('원본이 critical/perf라 뺄 수 없다');
    });

    it('같은 id 원본 중 하나라도 critical이면 첫 원본이 warning이어도 거부한다', () => {
      const sid = open({
        'quality-reviewer': [original({ id: 'i1', severity: 'warning' })],
        'performance-reviewer': [original({ id: 'i1', severity: 'critical', category: 'perf' })],
      });
      const message = rejected(sid, {
        reviewConsensus: { mergedIssues: [], droppedIssues: [{ id: 'i1', ...EVIDENCE }] },
      });
      expect(message).toContain('원본이 critical/perf라 뺄 수 없다');
    });

    it('스키마에 없는 우회 키를 붙여도 버려지고 거부는 그대로다', () => {
      const sid = open({ 'quality-reviewer': [original({ id: 'q1', severity: 'critical' })] });
      const message = rejected(sid, {
        reviewConsensus: {
          mergedIssues: [],
          droppedIssues: [{ id: 'q1', skipOriginalCheck: true, force: true, ...EVIDENCE }],
          allowCriticalDrop: true,
        },
      });
      expect(message).toContain('원본이 critical/quality라 뺄 수 없다');
    });
  });

  describe('continuityVerdict', () => {
    const verdictOf = (extra: Record<string, unknown>) => ({
      driftFindings: [],
      escalate: false,
      summary: '정합 요약',
      ...extra,
    });

    it('coherent 대신 verdict "block"이 오면 false로 받아 막는다', () => {
      const sid = open({ 'comment-reviewer': [] });
      const { approved } = accepted(sid, {
        reviewConsensus: { mergedIssues: [] },
        continuityVerdict: verdictOf({ verdict: 'block' }),
      });
      expect(approved).toBe(false);
      expect(engine.getSession(sid).continuityVerdict!.coherent).toBe(false);
    });

    it('coherent 대신 verdict "pass"가 오면 true로 받는다', () => {
      const sid = open({ 'comment-reviewer': [] });
      const { approved } = accepted(sid, {
        reviewConsensus: { mergedIssues: [] },
        continuityVerdict: verdictOf({ verdict: 'Pass' }),
      });
      expect(approved).toBe(true);
    });

    it('coherent가 있으면 verdict는 보지 않는다', () => {
      const sid = open({ 'comment-reviewer': [] });
      const { approved } = accepted(sid, {
        reviewConsensus: { mergedIssues: [] },
        continuityVerdict: verdictOf({ coherent: false, verdict: 'pass' }),
      });
      expect(approved).toBe(false);
    });

    it('coherent도 verdict도 없으면 채우지 않고 거부한다', () => {
      const sid = open({ 'comment-reviewer': [] });
      expect(() =>
        call(sid, {
          reviewConsensus: { mergedIssues: [] },
          continuityVerdict: verdictOf({ verdict: 'unsure' }),
        }),
      ).toThrow(/continuityVerdict\.coherent/);
    });

    it('항목의 message 대신 summary가 오면 message로 옮기고 evidence를 붙인다', () => {
      const sid = open({ 'comment-reviewer': [] });
      accepted(sid, {
        reviewConsensus: { mergedIssues: [] },
        continuityVerdict: verdictOf({
          coherent: false,
          driftFindings: [{ axis: 'goal', summary: '목표와 어긋난다', evidence: 'a.ts:3' }],
        }),
      });
      expect(engine.getSession(sid).continuityVerdict!.driftFindings[0]!.message).toBe(
        '목표와 어긋난다 (근거: a.ts:3)',
      );
    });

    it('axis가 빠지면 엔진이 고르지 않고 거부한다', () => {
      const sid = open({ 'comment-reviewer': [] });
      expect(() =>
        call(sid, {
          reviewConsensus: { mergedIssues: [] },
          continuityVerdict: verdictOf({
            coherent: false,
            driftFindings: [{ file: 'a.ts', message: 'm' }],
          }),
        }),
      ).toThrow(/goal, consistency, drift 중 하나를 적는다/);
    });
  });
});
