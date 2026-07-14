import type { PassthroughReviewEngine } from '../../review/passthrough-engine.js';
import type { PassthroughExecuteEngine } from '../../execute/passthrough-engine.js';
import type { RoleAgentRegistry } from '../../agent/role-agent-registry.js';
import type { ExecuteInput } from '../schemas.js';
import { ProjectMemoryStore } from '../../memory/project-memory-store.js';

export function handleReviewPassthrough(
  reviewEngine: PassthroughReviewEngine,
  executeEngine: PassthroughExecuteEngine,
  roleAgentRegistry: RoleAgentRegistry | undefined,
  input: ExecuteInput,
): string {
  try {
    switch (input.action) {
      case 'review_start':
        return handleReviewStart(reviewEngine, executeEngine, roleAgentRegistry, input);
      case 'review_submit':
        return handleReviewSubmit(reviewEngine, input);
      case 'review_consensus':
        return handleReviewConsensus(reviewEngine, input);
      case 'review_fix':
        return handleReviewFix(reviewEngine, input);
      default:
        return JSON.stringify({ error: `Unknown review action: ${input.action}` });
    }
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

function handleReviewStart(
  reviewEngine: PassthroughReviewEngine,
  executeEngine: PassthroughExecuteEngine,
  roleAgentRegistry: RoleAgentRegistry | undefined,
  input: ExecuteInput,
): string {
  if (!input.sessionId && !(input.changedFiles?.length && input.repoRoot)) {
    return JSON.stringify({
      error:
        'review_start requires either sessionId (execute session) or changedFiles + repoRoot (direct review)',
    });
  }

  const roleAgents = roleAgentRegistry?.getAll() ?? [];
  // Get review-specific agents from role agent registry (pipeline: review)
  const allRoleAgents = roleAgentRegistry?.getAll() ?? [];
  const reviewAgents = allRoleAgents.filter((a) => a.frontmatter.pipeline === 'review');

  const source = input.sessionId
    ? { executeSession: executeEngine.getSession(input.sessionId) }
    : { changedFiles: input.changedFiles!, repoRoot: input.repoRoot! };

  const result = reviewEngine.startReview(source, roleAgents, reviewAgents);
  if (!result.ok) return JSON.stringify({ error: result.error.message });

  const { sessionId, reviewStartContext } = result.value;

  return JSON.stringify(
    {
      status: 'review_started',
      reviewSessionId: sessionId,
      executeSessionId: input.sessionId ?? null,
      reviewStartContext: {
        systemPrompt: reviewStartContext.systemPrompt,
        reviewPrompt: reviewStartContext.reviewPrompt,
        matchContext: reviewStartContext.matchContext,
        changedFiles: reviewStartContext.reviewContext.changedFiles,
        dependencyFiles: reviewStartContext.reviewContext.dependencyFiles,
      },
      message:
        "Use matchContext to select review agents, then submit each agent's review with review_submit.",
    },
    null,
    2,
  );
}

function handleReviewSubmit(reviewEngine: PassthroughReviewEngine, input: ExecuteInput): string {
  if (!input.reviewSessionId) {
    return JSON.stringify({ error: 'reviewSessionId is required for review_submit' });
  }
  if (!input.reviewAgentName) {
    return JSON.stringify({ error: 'reviewAgentName is required for review_submit' });
  }
  if (!input.reviewResult) {
    return JSON.stringify({ error: 'reviewResult is required for review_submit' });
  }

  const result = reviewEngine.submitReview(input.reviewSessionId, input.reviewAgentName, {
    agentName: input.reviewAgentName,
    issues: input.reviewResult.issues.map((i) => ({
      ...i,
      reportedBy: input.reviewAgentName!,
      line: i.line,
    })),
    approved: input.reviewResult.approved,
    summary: input.reviewResult.summary,
  });

  if (!result.ok) return JSON.stringify({ error: result.error.message });

  return JSON.stringify(
    {
      status: 'review_submitted',
      reviewSessionId: input.reviewSessionId,
      ...result.value,
      message: 'Submit more reviews or call review_consensus to merge all reviews.',
    },
    null,
    2,
  );
}

function handleReviewConsensus(reviewEngine: PassthroughReviewEngine, input: ExecuteInput): string {
  if (!input.reviewSessionId) {
    return JSON.stringify({ error: 'reviewSessionId is required for review_consensus' });
  }
  if (!input.reviewConsensus) {
    return JSON.stringify({ error: 'reviewConsensus is required for review_consensus' });
  }

  const result = reviewEngine.submitConsensus(
    input.reviewSessionId,
    input.reviewConsensus,
    input.continuityVerdict,
  );

  if (!result.ok) return JSON.stringify({ error: result.error.message });

  const { approved, report, needsFix, canFix, criticalHighCount, escalate } = result.value;

  // Save key findings as architecture decisions
  try {
    const memoryStore = new ProjectMemoryStore();
    const { summary, mergedIssues } = input.reviewConsensus!;
    const now = new Date().toISOString();
    if (summary) {
      memoryStore.addArchitectureDecision({
        decision: `[Review] ${summary}`,
        rationale: 'Code review consensus summary',
        specId: '',
        timestamp: now,
      });
    }
    for (const issue of mergedIssues.filter((i) => i.severity === 'critical')) {
      memoryStore.addArchitectureDecision({
        decision: `[Review:critical] ${issue.category}: ${issue.message}`,
        rationale: issue.suggestion,
        specId: '',
        timestamp: now,
      });
    }
  } catch {
    // Memory update failure should not block the response
  }

  // escalate가 걸렸고 자동 수정 대상이 아니면(결함 없음) 재설계 신호를 준다.
  const escalatedOnly = !approved && escalate && !canFix;
  const status = approved
    ? 'review_passed'
    : escalatedOnly
      ? 'review_escalated'
      : 'review_blocked';

  return JSON.stringify(
    {
      status,
      reviewSessionId: input.reviewSessionId,
      approved,
      criticalHighCount,
      escalate,
      report: report.markdown,
      needsFix,
      canFix,
      message: approved
        ? 'Code review passed! All critical/high issues resolved.'
        : escalatedOnly
          ? '정합 심급이 목표 이탈을 감지했습니다. 라인 수정(review_fix)이 아니라 스펙 재정리 또는 결정 재확인이 필요합니다.'
          : canFix
            ? `${criticalHighCount} critical/high issues found. Use review_fix to auto-fix.`
            : `${criticalHighCount} critical/high issues remain after max attempts. Review the report.`,
    },
    null,
    2,
  );
}

function handleReviewFix(reviewEngine: PassthroughReviewEngine, input: ExecuteInput): string {
  if (!input.reviewSessionId) {
    return JSON.stringify({ error: 'reviewSessionId is required for review_fix' });
  }

  // If no fix result provided, start fix (return fix context)
  const startResult = reviewEngine.startFix(input.reviewSessionId);
  if (!startResult.ok) return JSON.stringify({ error: startResult.error.message });

  const value = startResult.value;

  // Check if exhausted
  if ('exhausted' in value) {
    return JSON.stringify(
      {
        status: 'review_exhausted',
        reviewSessionId: input.reviewSessionId,
        report: value.report.markdown,
        message: 'Max fix attempts exceeded. Review the report and fix remaining issues manually.',
      },
      null,
      2,
    );
  }

  // Return fix context for caller
  return JSON.stringify(
    {
      status: 'review_fix_context',
      reviewSessionId: input.reviewSessionId,
      fixContext: {
        systemPrompt: value.systemPrompt,
        fixPrompt: value.fixPrompt,
        issues: value.issues,
        driftFindings: value.driftFindings,
        attempt: value.attempt,
        maxAttempts: value.maxAttempts,
      },
      message: `Fix attempt ${value.attempt}/${value.maxAttempts}. Fix the issues (and any continuity findings) and run structural checks, then call review_start to re-review both instances.`,
    },
    null,
    2,
  );
}
