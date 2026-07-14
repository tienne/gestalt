import { describe, it, expect, beforeEach } from 'vitest';
import { PassthroughReviewEngine } from '../../../src/review/passthrough-engine.js';
import type {
  ExecuteSession,
  AgentDefinition,
  ReviewConsensusResult,
} from '../../../src/core/types.js';

function createMockExecuteSession(overrides?: Partial<ExecuteSession>): ExecuteSession {
  return {
    sessionId: 'exec-session-1',
    specId: 'spec-1',
    spec: {
      version: '1.0.0',
      goal: 'Test goal',
      constraints: ['constraint-1'],
      acceptanceCriteria: ['AC-1'],
      ontologySchema: { entities: [], relations: [] },
      gestaltAnalysis: [],
      metadata: {
        specId: 'spec-1',
        interviewSessionId: 'int-1',
        resolutionScore: 0.9,
        generatedAt: new Date().toISOString(),
      },
    },
    status: 'completed',
    currentStep: 4,
    planningSteps: [],
    taskResults: [
      {
        taskId: 'task-1',
        status: 'completed',
        output: 'Created src/auth/login.ts with import from "../utils/hash.js"',
        artifacts: ['src/auth/login.ts', 'src/auth/session.ts'],
      },
    ],
    evaluateStage: 'complete',
    driftHistory: [],
    evolutionHistory: [],
    currentGeneration: 0,
    lateralTriedPersonas: [],
    lateralAttempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockAgents(): { roleAgents: AgentDefinition[]; reviewAgents: AgentDefinition[] } {
  return {
    roleAgents: [
      {
        frontmatter: {
          name: 'architect',
          tier: 'standard',
          pipeline: 'execute',
          description: 'Software architect',
          role: true,
          domain: ['architecture', 'design'],
        },
        systemPrompt: 'You are an architect.',
        filePath: 'role-agents/architect/AGENT.md',
      },
    ],
    reviewAgents: [
      {
        frontmatter: {
          name: 'security-reviewer',
          tier: 'standard',
          pipeline: 'review',
          description: 'Security reviewer',
          role: true,
          domain: ['security', 'authentication'],
        },
        systemPrompt: 'You are a security reviewer.',
        filePath: 'review-agents/security-reviewer/AGENT.md',
      },
    ],
  };
}

function createCleanConsensus(): ReviewConsensusResult {
  return {
    mergedIssues: [],
    approvedBy: ['architect', 'security-reviewer'],
    blockedBy: [],
    summary: 'No issues found. Code looks good.',
    overallApproved: true,
  };
}

function createBlockedConsensus(): ReviewConsensusResult {
  return {
    mergedIssues: [
      {
        id: 'issue-1',
        severity: 'critical',
        category: 'security',
        file: 'src/auth/login.ts',
        line: 42,
        message: 'SQL injection vulnerability',
        suggestion: 'Use parameterized queries',
        reportedBy: 'security-reviewer',
      },
      {
        id: 'issue-2',
        severity: 'warning',
        category: 'quality',
        file: 'src/auth/session.ts',
        message: 'Consider extracting magic number',
        suggestion: 'Use named constant',
        reportedBy: 'quality-reviewer',
      },
    ],
    approvedBy: ['architect'],
    blockedBy: ['security-reviewer'],
    summary: 'Critical security issue found.',
    overallApproved: false,
  };
}

describe('PassthroughReviewEngine', () => {
  let engine: PassthroughReviewEngine;

  beforeEach(() => {
    engine = new PassthroughReviewEngine();
  });

  describe('startReview', () => {
    it('creates a review session and returns review context', () => {
      const session = createMockExecuteSession();
      const { roleAgents, reviewAgents } = createMockAgents();

      const result = engine.startReview({ executeSession: session }, roleAgents, reviewAgents);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.sessionId).toBeDefined();
      expect(result.value.reviewStartContext.systemPrompt).toContain('code reviewer');
      expect(result.value.reviewStartContext.reviewPrompt).toContain('Test goal');
      expect(result.value.reviewStartContext.matchContext.availableAgents).toHaveLength(2);
      expect(result.value.reviewStartContext.reviewContext.changedFiles).toContain(
        'src/auth/login.ts',
      );
    });

    it('includes both role agents and review agents in match context', () => {
      const session = createMockExecuteSession();
      const { roleAgents, reviewAgents } = createMockAgents();

      const result = engine.startReview({ executeSession: session }, roleAgents, reviewAgents);
      if (!result.ok) return;

      const agents = result.value.reviewStartContext.matchContext.availableAgents;
      const categories = agents.map((a) => a.category);
      expect(categories).toContain('role-agent');
      expect(categories).toContain('review-specialist');
    });

    it('starts a direct review from changedFiles + repoRoot (no execute session)', () => {
      const { roleAgents, reviewAgents } = createMockAgents();

      const result = engine.startReview(
        { changedFiles: ['src/auth/jwt.ts', 'src/auth/middleware.ts'], repoRoot: '/repo' },
        roleAgents,
        reviewAgents,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.sessionId).toBeDefined();
      expect(result.value.reviewStartContext.reviewContext.changedFiles).toEqual([
        'src/auth/jwt.ts',
        'src/auth/middleware.ts',
      ]);
      // Direct review has no spec/taskResults
      expect(result.value.reviewStartContext.reviewContext.spec).toBeUndefined();
      expect(result.value.reviewStartContext.reviewContext.taskResults).toBeUndefined();
    });

    it('uses empty-string sentinel for executeSessionId in direct review', () => {
      const { roleAgents, reviewAgents } = createMockAgents();

      const result = engine.startReview(
        { changedFiles: ['src/a.ts'], repoRoot: '/repo' },
        roleAgents,
        reviewAgents,
      );
      if (!result.ok) return;

      const session = engine.getSession(result.value.sessionId);
      expect(session.executeSessionId).toBe('');
    });

    it('falls back to "Direct file review" goal when spec is absent', () => {
      const { roleAgents, reviewAgents } = createMockAgents();

      const result = engine.startReview(
        { changedFiles: ['src/a.ts'], repoRoot: '/repo' },
        roleAgents,
        reviewAgents,
      );
      if (!result.ok) return;

      expect(result.value.reviewStartContext.reviewPrompt).toContain('Direct file review');
    });
  });

  describe('submitReview', () => {
    it('stores individual review result', () => {
      const session = createMockExecuteSession();
      const { roleAgents, reviewAgents } = createMockAgents();
      const startResult = engine.startReview({ executeSession: session }, roleAgents, reviewAgents);
      if (!startResult.ok) return;

      const reviewSessionId = startResult.value.sessionId;
      const result = engine.submitReview(reviewSessionId, 'security-reviewer', {
        agentName: 'security-reviewer',
        issues: [
          {
            id: 'i1',
            severity: 'high',
            category: 'security',
            file: 'f.ts',
            message: 'msg',
            suggestion: 'fix',
            reportedBy: '',
          },
        ],
        approved: false,
        summary: 'Issues found',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.submittedCount).toBe(1);
    });

    it('tags issues with reporter name', () => {
      const session = createMockExecuteSession();
      const { roleAgents, reviewAgents } = createMockAgents();
      const startResult = engine.startReview({ executeSession: session }, roleAgents, reviewAgents);
      if (!startResult.ok) return;

      engine.submitReview(startResult.value.sessionId, 'architect', {
        agentName: 'architect',
        issues: [
          {
            id: 'i1',
            severity: 'warning',
            category: 'design',
            file: 'f.ts',
            message: 'msg',
            suggestion: 'fix',
            reportedBy: '',
          },
        ],
        approved: true,
        summary: 'Minor issues',
      });

      const reviewSession = engine.getSession(startResult.value.sessionId);
      expect(reviewSession.reviewResults[0]!.issues[0]!.reportedBy).toBe('architect');
    });

    it('returns error for unknown session', () => {
      const result = engine.submitReview('nonexistent', 'agent', {
        agentName: 'agent',
        issues: [],
        approved: true,
        summary: 'ok',
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('submitConsensus', () => {
    it('approves when no critical/high issues', () => {
      const session = createMockExecuteSession();
      const { roleAgents, reviewAgents } = createMockAgents();
      const startResult = engine.startReview({ executeSession: session }, roleAgents, reviewAgents);
      if (!startResult.ok) return;

      const result = engine.submitConsensus(startResult.value.sessionId, createCleanConsensus());

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.approved).toBe(true);
      expect(result.value.needsFix).toBe(false);
      expect(result.value.criticalHighCount).toBe(0);
      expect(result.value.report.passed).toBe(true);
    });

    it('blocks when critical/high issues exist', () => {
      const session = createMockExecuteSession();
      const { roleAgents, reviewAgents } = createMockAgents();
      const startResult = engine.startReview({ executeSession: session }, roleAgents, reviewAgents);
      if (!startResult.ok) return;

      const result = engine.submitConsensus(startResult.value.sessionId, createBlockedConsensus());

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.approved).toBe(false);
      expect(result.value.needsFix).toBe(true);
      expect(result.value.canFix).toBe(true);
      expect(result.value.criticalHighCount).toBe(1); // only 1 critical, warning doesn't count
    });

    it('allows warnings without blocking', () => {
      const session = createMockExecuteSession();
      const { roleAgents, reviewAgents } = createMockAgents();
      const startResult = engine.startReview({ executeSession: session }, roleAgents, reviewAgents);
      if (!startResult.ok) return;

      const warningOnlyConsensus: ReviewConsensusResult = {
        mergedIssues: [
          {
            id: 'w1',
            severity: 'warning',
            category: 'quality',
            file: 'f.ts',
            message: 'minor',
            suggestion: 'fix',
            reportedBy: 'quality-reviewer',
          },
        ],
        approvedBy: ['architect', 'security-reviewer'],
        blockedBy: [],
        summary: 'Only warnings.',
        overallApproved: true,
      };

      const result = engine.submitConsensus(startResult.value.sessionId, warningOnlyConsensus);
      if (!result.ok) return;
      expect(result.value.approved).toBe(true);
      expect(result.value.criticalHighCount).toBe(0);
    });

    it('generates markdown report', () => {
      const session = createMockExecuteSession();
      const { roleAgents, reviewAgents } = createMockAgents();
      const startResult = engine.startReview({ executeSession: session }, roleAgents, reviewAgents);
      if (!startResult.ok) return;

      const result = engine.submitConsensus(startResult.value.sessionId, createBlockedConsensus());
      if (!result.ok) return;

      expect(result.value.report.markdown).toContain('Code Review Report');
      expect(result.value.report.markdown).toContain('SQL injection');
      expect(result.value.report.markdown).toContain('BLOCKED');
    });
  });

  // ─── 정합 심급 (continuity instance) — v2 ────────────────────
  describe('submitConsensus: continuity instance', () => {
    function startSession(): string {
      const session = createMockExecuteSession();
      const { roleAgents, reviewAgents } = createMockAgents();
      const startResult = engine.startReview({ executeSession: session }, roleAgents, reviewAgents);
      if (!startResult.ok) throw new Error('start failed');
      return startResult.value.sessionId;
    }

    it('omitting continuityVerdict keeps defect-only behavior unchanged', () => {
      const id = startSession();
      const result = engine.submitConsensus(id, createCleanConsensus());
      if (!result.ok) return;
      expect(result.value.approved).toBe(true);
      expect(result.value.escalate).toBe(false);
    });

    it('blocks a defect-clean change when continuity is incoherent', () => {
      const id = startSession();
      const result = engine.submitConsensus(id, createCleanConsensus(), {
        coherent: false,
        driftFindings: [{ axis: 'goal', file: 'src/a.ts', message: '목적과 무관한 변경' }],
        escalate: false,
        summary: '목표에서 벗어난 변경이 있습니다.',
      });
      if (!result.ok) return;
      // 결함은 없지만 정합 심급이 Block
      expect(result.value.criticalHighCount).toBe(0);
      expect(result.value.approved).toBe(false);
      expect(result.value.needsFix).toBe(true);
    });

    it('escalates (not fixable) when continuity fails with escalate on a defect-clean change', () => {
      const id = startSession();
      const result = engine.submitConsensus(id, createCleanConsensus(), {
        coherent: false,
        driftFindings: [{ axis: 'drift', message: '스펙 제약과 모순' }],
        escalate: true,
        summary: '재설계가 필요합니다.',
      });
      if (!result.ok) return;
      expect(result.value.approved).toBe(false);
      expect(result.value.escalate).toBe(true);
      // 라인 수정으로 해결 불가 → fix 루프 대상 아님
      expect(result.value.canFix).toBe(false);
      expect(engine.getSession(id).status).toBe('escalated');
    });

    it('still passes when continuity is coherent and no defects', () => {
      const id = startSession();
      const result = engine.submitConsensus(id, createCleanConsensus(), {
        coherent: true,
        driftFindings: [],
        escalate: false,
        summary: '목표와 정합합니다.',
      });
      if (!result.ok) return;
      expect(result.value.approved).toBe(true);
      expect(result.value.escalate).toBe(false);
      expect(engine.getSession(id).status).toBe('passed');
    });

    it('defects take fix priority over escalate (canFix stays true)', () => {
      const id = startSession();
      const result = engine.submitConsensus(id, createBlockedConsensus(), {
        coherent: false,
        driftFindings: [{ axis: 'goal', message: '목표 이탈' }],
        escalate: true,
        summary: '결함과 이탈이 함께 있습니다.',
      });
      if (!result.ok) return;
      expect(result.value.approved).toBe(false);
      // 결함이 있으므로 fix 루프로 처리 가능
      expect(result.value.canFix).toBe(true);
      expect(engine.getSession(id).status).not.toBe('escalated');
    });

    it('renders a continuity section with drift findings in the report', () => {
      const id = startSession();
      const result = engine.submitConsensus(id, createCleanConsensus(), {
        coherent: false,
        driftFindings: [{ axis: 'consistency', file: 'src/x.ts', message: '네이밍 불일치' }],
        escalate: true,
        summary: '일관성 문제가 있습니다.',
      });
      if (!result.ok) return;
      expect(result.value.report.markdown).toContain('정합 심급');
      expect(result.value.report.markdown).toContain('네이밍 불일치');
      expect(result.value.report.markdown).toContain('[consistency]');
    });

    it('does not render a continuity section when coherent with no drift', () => {
      const id = startSession();
      const result = engine.submitConsensus(id, createCleanConsensus(), {
        coherent: true,
        driftFindings: [],
        escalate: false,
        summary: '정합합니다.',
      });
      if (!result.ok) return;
      expect(result.value.report.markdown).not.toContain('정합 심급');
    });
  });

  // ─── 재리뷰 루프의 정합 재평가 — v2 ──────────────────────────
  describe('fix loop: continuity re-evaluation', () => {
    function setupWithVerdict(verdict: {
      coherent: boolean;
      driftFindings: { axis: 'goal' | 'consistency' | 'drift'; file?: string; message: string }[];
      escalate: boolean;
      summary: string;
    }) {
      const engine = new PassthroughReviewEngine();
      const session = createMockExecuteSession();
      const { roleAgents, reviewAgents } = createMockAgents();
      const startResult = engine.startReview({ executeSession: session }, roleAgents, reviewAgents);
      if (!startResult.ok) throw new Error('start failed');
      const id = startResult.value.sessionId;
      // 결함 + 정합 이탈이 함께 있는 blocked 상태
      engine.submitConsensus(id, createBlockedConsensus(), verdict);
      return { engine, id };
    }

    it('includes fixable (non-escalate) continuity findings in the fix context', () => {
      const { engine, id } = setupWithVerdict({
        coherent: false,
        driftFindings: [{ axis: 'consistency', file: 'src/x.ts', message: '네이밍 불일치' }],
        escalate: false,
        summary: '일관성 문제',
      });

      const result = engine.startFix(id);
      if (!result.ok || 'exhausted' in result.value) return;

      expect(result.value.driftFindings).toHaveLength(1);
      expect(result.value.fixPrompt).toContain('Continuity findings');
      expect(result.value.fixPrompt).toContain('네이밍 불일치');
    });

    it('excludes escalate continuity findings from the fix context', () => {
      const { engine, id } = setupWithVerdict({
        coherent: false,
        driftFindings: [{ axis: 'goal', message: '목표 이탈' }],
        escalate: true,
        summary: '재설계 필요',
      });

      const result = engine.startFix(id);
      if (!result.ok || 'exhausted' in result.value) return;

      expect(result.value.driftFindings).toHaveLength(0);
      expect(result.value.fixPrompt).not.toContain('Continuity findings');
    });

    it('resets continuityVerdict on submitFix so re-review re-evaluates it', () => {
      const { engine, id } = setupWithVerdict({
        coherent: false,
        driftFindings: [{ axis: 'drift', message: '이탈' }],
        escalate: false,
        summary: '이탈',
      });

      engine.startFix(id);
      engine.submitFix(id);

      expect(engine.getSession(id).continuityVerdict).toBeUndefined();
      expect(engine.getSession(id).consensus).toBeUndefined();
      expect(engine.getSession(id).status).toBe('started');
    });
  });

  describe('fix loop', () => {
    function setupBlockedSession() {
      const engine = new PassthroughReviewEngine();
      const session = createMockExecuteSession();
      const { roleAgents, reviewAgents } = createMockAgents();
      const startResult = engine.startReview({ executeSession: session }, roleAgents, reviewAgents);
      if (!startResult.ok) throw new Error('start failed');
      engine.submitConsensus(startResult.value.sessionId, createBlockedConsensus());
      return { engine, reviewSessionId: startResult.value.sessionId };
    }

    it('returns fix context with issues to fix', () => {
      const { engine, reviewSessionId } = setupBlockedSession();

      const result = engine.startFix(reviewSessionId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect('exhausted' in result.value).toBe(false);
      if ('exhausted' in result.value) return;

      expect(result.value.issues).toHaveLength(1); // only critical, not warning
      expect(result.value.issues[0]!.severity).toBe('critical');
      expect(result.value.attempt).toBe(1);
      expect(result.value.maxAttempts).toBe(3);
      expect(result.value.fixPrompt).toContain('Attempt 1/3');
    });

    it('increments attempt count on each fix', () => {
      const { engine, reviewSessionId } = setupBlockedSession();

      engine.startFix(reviewSessionId);
      engine.submitFix(reviewSessionId);
      // Re-block for next attempt
      engine.submitConsensus(reviewSessionId, createBlockedConsensus());

      const result = engine.startFix(reviewSessionId);
      if (!result.ok || 'exhausted' in result.value) return;
      expect(result.value.attempt).toBe(2);
    });

    it('exhausts after max attempts and returns report', () => {
      const { engine, reviewSessionId } = setupBlockedSession();

      // Attempt 1
      engine.startFix(reviewSessionId);
      engine.submitFix(reviewSessionId);
      engine.submitConsensus(reviewSessionId, createBlockedConsensus());

      // Attempt 2
      engine.startFix(reviewSessionId);
      engine.submitFix(reviewSessionId);
      engine.submitConsensus(reviewSessionId, createBlockedConsensus());

      // Attempt 3
      engine.startFix(reviewSessionId);
      engine.submitFix(reviewSessionId);
      engine.submitConsensus(reviewSessionId, createBlockedConsensus());

      // Attempt 4 — should be exhausted
      const result = engine.startFix(reviewSessionId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect('exhausted' in result.value).toBe(true);
      if (!('exhausted' in result.value)) return;

      expect(result.value.exhausted).toBe(true);
      expect(result.value.report.markdown).toContain('BLOCKED');
    });

    it('resets review state after submitFix for re-review', () => {
      const { engine, reviewSessionId } = setupBlockedSession();

      engine.startFix(reviewSessionId);
      const fixResult = engine.submitFix(reviewSessionId);

      expect(fixResult.ok).toBe(true);
      if (!fixResult.ok) return;
      expect(fixResult.value.readyForReReview).toBe(true);

      const session = engine.getSession(reviewSessionId);
      expect(session.reviewResults).toHaveLength(0);
      expect(session.consensus).toBeUndefined();
      expect(session.status).toBe('started');
    });

    it('sets status to failed_with_report when exhausted', () => {
      const { engine, reviewSessionId } = setupBlockedSession();

      for (let i = 0; i < 3; i++) {
        engine.startFix(reviewSessionId);
        engine.submitFix(reviewSessionId);
        engine.submitConsensus(reviewSessionId, createBlockedConsensus());
      }

      engine.startFix(reviewSessionId);

      const session = engine.getSession(reviewSessionId);
      expect(session.status).toBe('failed_with_report');
    });
  });

  describe('session management', () => {
    it('getSession throws for unknown session', () => {
      expect(() => engine.getSession('nonexistent')).toThrow('Review session not found');
    });

    it('listSessions returns all sessions', () => {
      const session = createMockExecuteSession();
      const { roleAgents, reviewAgents } = createMockAgents();

      engine.startReview({ executeSession: session }, roleAgents, reviewAgents);
      engine.startReview(
        { executeSession: { ...session, sessionId: 'exec-2' } },
        roleAgents,
        reviewAgents,
      );

      expect(engine.listSessions()).toHaveLength(2);
    });

    it('sets status to passed on clean consensus', () => {
      const session = createMockExecuteSession();
      const { roleAgents, reviewAgents } = createMockAgents();
      const startResult = engine.startReview({ executeSession: session }, roleAgents, reviewAgents);
      if (!startResult.ok) return;

      engine.submitConsensus(startResult.value.sessionId, createCleanConsensus());

      const reviewSession = engine.getSession(startResult.value.sessionId);
      expect(reviewSession.status).toBe('passed');
    });
  });
});
