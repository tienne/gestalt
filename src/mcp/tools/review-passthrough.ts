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
  if (!input.sessionId) {
    return JSON.stringify({ error: 'sessionId (execute session) is required for review_start' });
  }

  const executeSession = executeEngine.getSession(input.sessionId);
  const roleAgents = roleAgentRegistry?.getAll() ?? [];
  // Get review-specific agents from role agent registry (pipeline: review)
  const allRoleAgents = roleAgentRegistry?.getAll() ?? [];
  const reviewAgents = allRoleAgents.filter((a) => a.frontmatter.pipeline === 'review');

  const result = reviewEngine.startReview(executeSession, roleAgents, reviewAgents);
  if (!result.ok) return JSON.stringify({ error: result.error.message });

  const { sessionId, reviewStartContext } = result.value;

  return JSON.stringify({
    status: 'review_started',
    reviewSessionId: sessionId,
    executeSessionId: input.sessionId,
    reviewStartContext: {
      systemPrompt: reviewStartContext.systemPrompt,
      reviewPrompt: reviewStartContext.reviewPrompt,
      matchContext: reviewStartContext.matchContext,
      changedFiles: reviewStartContext.reviewContext.changedFiles,
      dependencyFiles: reviewStartContext.reviewContext.dependencyFiles,
    },
    message: 'Use matchContext to select review agents, then submit each agent\'s review with review_submit.',
  }, null, 2);
}

function handleReviewSubmit(
  reviewEngine: PassthroughReviewEngine,
  input: ExecuteInput,
): string {
  if (!input.reviewSessionId) {
    return JSON.stringify({ error: 'reviewSessionId is required for review_submit' });
  }
  if (!input.reviewAgentName) {
    return JSON.stringify({ error: 'reviewAgentName is required for review_submit' });
  }
  if (!input.reviewResult) {
    return JSON.stringify({ error: 'reviewResult is required for review_submit' });
  }

  const result = reviewEngine.submitReview(
    input.reviewSessionId,
    input.reviewAgentName,
    {
      agentName: input.reviewAgentName,
      issues: input.reviewResult.issues.map((i) => ({
        ...i,
        reportedBy: input.reviewAgentName!,
        line: i.line,
      })),
      approved: input.reviewResult.approved,
      summary: input.reviewResult.summary,
    },
  );

  if (!result.ok) return JSON.stringify({ error: result.error.message });

  return JSON.stringify({
    status: 'review_submitted',
    reviewSessionId: input.reviewSessionId,
    ...result.value,
    message: 'Submit more reviews or call review_consensus to merge all reviews.',
  }, null, 2);
}

function handleReviewConsensus(
  reviewEngine: PassthroughReviewEngine,
  input: ExecuteInput,
): string {
  if (!input.reviewSessionId) {
    return JSON.stringify({ error: 'reviewSessionId is required for review_consensus' });
  }
  if (!input.reviewConsensus) {
    return JSON.stringify({ error: 'reviewConsensus is required for review_consensus' });
  }

  const result = reviewEngine.submitConsensus(
    input.reviewSessionId,
    input.reviewConsensus,
  );

  if (!result.ok) return JSON.stringify({ error: result.error.message });

  const { approved, report, needsFix, canFix, criticalHighCount } = result.value;

  // Save key findings as architecture decisions
  try {
    const memoryStore = new ProjectMemoryStore();
    const { summary, mergedIssues } = input.reviewConsensus!;
    if (summary) memoryStore.addArchitectureDecision(`[Review] ${summary}`);
    for (const issue of mergedIssues.filter((i) => i.severity === 'critical')) {
      memoryStore.addArchitectureDecision(`[Review:critical] ${issue.category}: ${issue.message}`);
    }
  } catch {
    // Memory update failure should not block the response
  }

  return JSON.stringify({
    status: approved ? 'review_passed' : 'review_blocked',
    reviewSessionId: input.reviewSessionId,
    approved,
    criticalHighCount,
    report: report.markdown,
    needsFix,
    canFix,
    message: approved
      ? 'Code review passed! All critical/high issues resolved.'
      : canFix
        ? `${criticalHighCount} critical/high issues found. Use review_fix to auto-fix.`
        : `${criticalHighCount} critical/high issues remain after max attempts. Review the report.`,
  }, null, 2);
}

function handleReviewFix(
  reviewEngine: PassthroughReviewEngine,
  input: ExecuteInput,
): string {
  if (!input.reviewSessionId) {
    return JSON.stringify({ error: 'reviewSessionId is required for review_fix' });
  }

  // If no fix result provided, start fix (return fix context)
  const startResult = reviewEngine.startFix(input.reviewSessionId);
  if (!startResult.ok) return JSON.stringify({ error: startResult.error.message });

  const value = startResult.value;

  // Check if exhausted
  if ('exhausted' in value) {
    return JSON.stringify({
      status: 'review_exhausted',
      reviewSessionId: input.reviewSessionId,
      report: value.report.markdown,
      message: 'Max fix attempts exceeded. Review the report and fix remaining issues manually.',
    }, null, 2);
  }

  // Return fix context for caller
  return JSON.stringify({
    status: 'review_fix_context',
    reviewSessionId: input.reviewSessionId,
    fixContext: {
      systemPrompt: value.systemPrompt,
      fixPrompt: value.fixPrompt,
      issues: value.issues,
      attempt: value.attempt,
      maxAttempts: value.maxAttempts,
    },
    message: `Fix attempt ${value.attempt}/${value.maxAttempts}. Fix the issues and run structural checks, then call review_start to re-review.`,
  }, null, 2);
}
