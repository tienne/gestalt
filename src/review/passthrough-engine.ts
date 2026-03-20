import { randomUUID } from 'node:crypto';
import type {
  ReviewSession,
  ReviewResult,
  ReviewConsensusResult,
  ReviewReport,
  ReviewIssue,
  ReviewContext,
  ExecuteSession,
  AgentDefinition,
} from '../core/types.js';
import { type Result, ok, err } from '../core/result.js';
import { ReviewContextCollector } from './context-collector.js';
import { ReviewAgentMatcher, type ReviewMatchContext } from './agent-matcher.js';
import { ReviewReportGenerator } from './report-generator.js';
import type { EventStore } from '../events/store.js';
import { EventType } from '../events/types.js';

const MAX_REVIEW_ATTEMPTS = 3;

export interface ReviewStartContext {
  systemPrompt: string;
  reviewPrompt: string;
  matchContext: ReviewMatchContext;
  reviewContext: ReviewContext;
}

export interface ReviewFixContext {
  systemPrompt: string;
  fixPrompt: string;
  issues: ReviewIssue[];
  attempt: number;
  maxAttempts: number;
}

export class PassthroughReviewEngine {
  private sessions = new Map<string, ReviewSession>();
  private contextCollector = new ReviewContextCollector();
  private agentMatcher = new ReviewAgentMatcher();
  private reportGenerator = new ReviewReportGenerator();

  constructor(private eventStore?: EventStore) {}

  // ─── review_start ─────────────────────────────────────────────
  startReview(
    executeSession: ExecuteSession,
    roleAgents: AgentDefinition[],
    reviewAgents: AgentDefinition[],
  ): Result<{ sessionId: string; reviewStartContext: ReviewStartContext }> {
    const reviewContext = this.contextCollector.collect(
      executeSession.spec,
      executeSession.taskResults,
    );

    const matchContext = this.agentMatcher.generateMatchContext(
      reviewContext,
      roleAgents,
      reviewAgents,
    );

    const sessionId = randomUUID();
    const session: ReviewSession = {
      sessionId,
      executeSessionId: executeSession.sessionId,
      status: 'started',
      currentAttempt: 0,
      maxAttempts: MAX_REVIEW_ATTEMPTS,
      reviewContext,
      matchedAgents: [],
      reviewResults: [],
      reports: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(sessionId, session);

    this.emitEvent(sessionId, EventType.REVIEW_STARTED, {
      executeSessionId: executeSession.sessionId,
      changedFiles: reviewContext.changedFiles.length,
      dependencyFiles: reviewContext.dependencyFiles.length,
    });

    const systemPrompt = `You are a code reviewer in the Gestalt pipeline.
Your job is to review code changes from the perspective of the assigned agent role.

## Review Rules
1. Focus on your specific domain expertise
2. Classify each issue as: critical, high, or warning
3. Provide actionable suggestions with code examples when possible
4. Be specific about file and line number
5. Don't flag style issues that linters would catch

## Output Format
Respond with ONLY a JSON object:
{
  "issues": [
    {
      "id": "unique-id",
      "severity": "critical" | "high" | "warning",
      "category": "your-category",
      "file": "path/to/file.ts",
      "line": 42,
      "message": "Description of the issue",
      "suggestion": "How to fix it"
    }
  ],
  "approved": true | false,
  "summary": "Overall assessment"
}`;

    const reviewPrompt = `## Code Review

**Spec Goal**: ${reviewContext.spec.goal}

**Changed Files** (${reviewContext.changedFiles.length}):
${reviewContext.changedFiles.map((f) => `  - ${f}`).join('\n')}

**Dependency Context** (${reviewContext.dependencyFiles.length}):
${reviewContext.dependencyFiles.map((f) => `  - ${f}`).join('\n')}

**Constraints**:
${reviewContext.spec.constraints.map((c) => `  - ${c}`).join('\n')}

Review the code changes from your assigned perspective. Focus on issues that matter, not nitpicks.`;

    return ok({
      sessionId,
      reviewStartContext: {
        systemPrompt,
        reviewPrompt,
        matchContext,
        reviewContext,
      },
    });
  }

  // ─── review_submit ────────────────────────────────────────────
  submitReview(
    sessionId: string,
    agentName: string,
    result: ReviewResult,
  ): Result<{ allSubmitted: boolean; submittedCount: number; expectedCount: number }> {
    const session = this.sessions.get(sessionId);
    if (!session) return err(new Error(`Review session not found: ${sessionId}`));

    // Tag issues with reporter
    const taggedResult: ReviewResult = {
      ...result,
      issues: result.issues.map((issue) => ({
        ...issue,
        reportedBy: agentName,
      })),
    };

    session.reviewResults.push(taggedResult);
    if (!session.matchedAgents.includes(agentName)) {
      session.matchedAgents.push(agentName);
    }
    session.status = 'reviewing';
    session.updatedAt = new Date().toISOString();

    this.emitEvent(sessionId, EventType.REVIEW_SUBMITTED, {
      agentName,
      issueCount: result.issues.length,
      approved: result.approved,
    });

    return ok({
      allSubmitted: false, // Caller decides when all agents have submitted
      submittedCount: session.reviewResults.length,
      expectedCount: session.matchedAgents.length,
    });
  }

  // ─── review_consensus ─────────────────────────────────────────
  submitConsensus(
    sessionId: string,
    consensus: ReviewConsensusResult,
  ): Result<{
    approved: boolean;
    report: ReviewReport;
    needsFix: boolean;
    canFix: boolean;
    criticalHighCount: number;
  }> {
    const session = this.sessions.get(sessionId);
    if (!session) return err(new Error(`Review session not found: ${sessionId}`));

    session.consensus = consensus;
    session.status = 'consensus';
    session.updatedAt = new Date().toISOString();

    const criticalHighIssues = consensus.mergedIssues.filter(
      (i) => i.severity === 'critical' || i.severity === 'high',
    );
    const approved = criticalHighIssues.length === 0;
    const needsFix = !approved;
    const canFix = session.currentAttempt < session.maxAttempts;

    const report = this.reportGenerator.generate(
      { ...consensus, overallApproved: approved },
      session.currentAttempt + 1,
    );
    session.reports.push(report);

    this.emitEvent(sessionId, EventType.REVIEW_CONSENSUS_COMPLETED, {
      totalIssues: consensus.mergedIssues.length,
      criticalHighCount: criticalHighIssues.length,
      approved,
      approvedBy: consensus.approvedBy,
      blockedBy: consensus.blockedBy,
    });

    if (approved) {
      session.status = 'passed';
      this.emitEvent(sessionId, EventType.REVIEW_PASSED, {
        attempt: session.currentAttempt + 1,
        warningCount: consensus.mergedIssues.filter((i) => i.severity === 'warning').length,
      });
    }

    return ok({
      approved,
      report,
      needsFix,
      canFix,
      criticalHighCount: criticalHighIssues.length,
    });
  }

  // ─── review_fix ───────────────────────────────────────────────
  startFix(
    sessionId: string,
  ): Result<ReviewFixContext | { report: ReviewReport; exhausted: true }> {
    const session = this.sessions.get(sessionId);
    if (!session) return err(new Error(`Review session not found: ${sessionId}`));
    if (!session.consensus) return err(new Error('No consensus available for fix'));

    session.currentAttempt++;
    session.updatedAt = new Date().toISOString();

    // Check if max attempts exceeded
    if (session.currentAttempt > session.maxAttempts) {
      session.status = 'failed_with_report';

      const report = this.reportGenerator.generate(
        session.consensus,
        session.currentAttempt,
      );
      session.reports.push(report);

      this.emitEvent(sessionId, EventType.REVIEW_FAILED, {
        attempt: session.currentAttempt,
        reason: 'max_attempts_exceeded',
        remainingIssues: session.consensus.mergedIssues
          .filter((i) => i.severity === 'critical' || i.severity === 'high')
          .length,
      });

      return ok({ report, exhausted: true as const });
    }

    session.status = 'fixing';

    const criticalHighIssues = session.consensus.mergedIssues.filter(
      (i) => i.severity === 'critical' || i.severity === 'high',
    );

    this.emitEvent(sessionId, EventType.REVIEW_FIX_STARTED, {
      attempt: session.currentAttempt,
      issueCount: criticalHighIssues.length,
    });

    const systemPrompt = `You are a code fixer in the Gestalt pipeline.
Your job is to fix issues found during code review.

## Rules
1. Fix only critical and high severity issues
2. Keep changes minimal — don't refactor unrelated code
3. After fixing, the code must still pass lint, build, and test
4. Explain each fix briefly

## Output Format
Respond with ONLY a JSON object:
{
  "fixes": [
    {
      "issueId": "id of the issue being fixed",
      "file": "path/to/file.ts",
      "description": "What was changed and why",
      "resolved": true | false
    }
  ],
  "structuralCheckRequired": true
}`;

    const issueList = criticalHighIssues
      .map(
        (i) =>
          `- [${i.severity.toUpperCase()}] ${i.file}${i.line ? `:${i.line}` : ''}: ${i.message}\n  Suggestion: ${i.suggestion}`,
      )
      .join('\n');

    const fixPrompt = `## Fix Code Review Issues (Attempt ${session.currentAttempt}/${session.maxAttempts})

**Issues to fix** (${criticalHighIssues.length}):
${issueList}

Fix these issues while maintaining code integrity. Run structural checks after fixing.`;

    return ok({
      systemPrompt,
      fixPrompt,
      issues: criticalHighIssues,
      attempt: session.currentAttempt,
      maxAttempts: session.maxAttempts,
    });
  }

  submitFix(
    sessionId: string,
  ): Result<{ readyForReReview: boolean; attempt: number }> {
    const session = this.sessions.get(sessionId);
    if (!session) return err(new Error(`Review session not found: ${sessionId}`));

    // Reset for re-review
    session.reviewResults = [];
    session.consensus = undefined;
    session.status = 'started';
    session.updatedAt = new Date().toISOString();

    this.emitEvent(sessionId, EventType.REVIEW_FIX_COMPLETED, {
      attempt: session.currentAttempt,
    });

    return ok({
      readyForReReview: true,
      attempt: session.currentAttempt,
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────
  getSession(sessionId: string): ReviewSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Review session not found: ${sessionId}`);
    return session;
  }

  listSessions(): ReviewSession[] {
    return [...this.sessions.values()];
  }

  private emitEvent(sessionId: string, eventType: EventType, payload: unknown): void {
    this.eventStore?.append('review', sessionId, eventType, payload);
  }
}
