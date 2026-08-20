import { resolve } from 'node:path';
import type { PassthroughReviewEngine } from '../../review/passthrough-engine.js';
import type { PassthroughExecuteEngine } from '../../execute/passthrough-engine.js';
import type { RoleAgentRegistry } from '../../agent/role-agent-registry.js';
import type { ExecuteInput } from '../schemas.js';
import { ProjectMemoryStore } from '../../memory/project-memory-store.js';
import { LocalPrEngine } from '../../local-pr/engine.js';
import type { ReviewIssue } from '../../core/types.js';
import type { ReviewVerdict } from '../../local-pr/types.js';
import { log } from '../../core/log.js';
import { resolveExecuteSessionInput } from './execute/utils.js';

export function handleReviewPassthrough(
  reviewEngine: PassthroughReviewEngine,
  executeEngine: PassthroughExecuteEngine,
  roleAgentRegistry: RoleAgentRegistry | undefined,
  rawInput: ExecuteInput,
): string {
  // review_* 액션의 sessionId도 실행 세션이라 active/latest 셀렉터를 지원한다.
  const resolved = resolveExecuteSessionInput(executeEngine, rawInput);
  if (!resolved.ok) return JSON.stringify({ error: resolved.error });
  const input = resolved.input;

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
      case 'review_publish':
        return handleReviewPublish(reviewEngine, input);
      default:
        return JSON.stringify({ error: `Unknown review action: ${input.action}` });
    }
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

/** 로컬 PR에서 리뷰 대상(변경 파일)을 끌어온다. 조회가 끝나면 저장소를 닫는다. */
function collectPrSource(
  prId: string,
  repoRoot: string,
): { changedFiles: string[]; repoRoot: string; prId: string } | { error: string } {
  const engine = new LocalPrEngine(repoRoot);
  try {
    const pr = engine.get(prId);
    if (!pr) return { error: `PR을 못 찾았다: ${prId}` };
    const changedFiles = engine.changedFiles(prId);
    if (changedFiles.length === 0) return { error: `PR ${prId}에 변경된 파일이 없다` };
    return { changedFiles, repoRoot, prId };
  } finally {
    engine.dispose();
  }
}

function handleReviewStart(
  reviewEngine: PassthroughReviewEngine,
  executeEngine: PassthroughExecuteEngine,
  roleAgentRegistry: RoleAgentRegistry | undefined,
  input: ExecuteInput,
): string {
  if (!input.prId && !input.sessionId && !(input.changedFiles?.length && input.repoRoot)) {
    return JSON.stringify({
      error:
        'review_start requires prId (local PR), sessionId (execute session), or changedFiles + repoRoot (direct review)',
    });
  }

  const roleAgents = roleAgentRegistry?.getAll() ?? [];
  // Get review-specific agents from role agent registry (pipeline: review)
  const allRoleAgents = roleAgentRegistry?.getAll() ?? [];
  const reviewAgents = allRoleAgents.filter((a) => a.frontmatter.pipeline === 'review');

  // prId를 주면 리뷰 대상을 손으로 나열하지 않는다. PR이 이미 알고 있다.
  let prSource: { changedFiles: string[]; repoRoot: string; prId: string } | undefined;
  if (input.prId) {
    const repoRoot = resolve(input.repoRoot ?? process.cwd());
    log(`review_start: prId=${input.prId}, repoRoot=${repoRoot}`);
    const collected = collectPrSource(input.prId, repoRoot);
    if ('error' in collected) return JSON.stringify({ error: collected.error, kind: 'not_found' });
    prSource = collected;
  }

  const source = prSource
    ? prSource
    : input.sessionId
      ? { executeSession: executeEngine.getSession(input.sessionId) }
      : { changedFiles: input.changedFiles!, repoRoot: input.repoRoot! };

  const result = reviewEngine.startReview(source, roleAgents, reviewAgents);
  if (!result.ok) return JSON.stringify({ error: result.error.message });

  const { sessionId, reviewStartContext } = result.value;

  return JSON.stringify(
    {
      status: 'review_started',
      reviewSessionId: sessionId,
      executeSessionId: prSource ? null : (input.sessionId ?? null),
      prId: prSource?.prId ?? null,
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
  const status = approved ? 'review_passed' : escalatedOnly ? 'review_escalated' : 'review_blocked';

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

// ─── review_publish ─────────────────────────────────────────────

/**
 * 합의 결과를 PR 판정으로 옮기는 경계.
 *
 * critical이나 high가 한 건이라도 있으면 request_changes다. 남은 것이 warning뿐이면
 * approve다. 이 경계는 submitConsensus가 approved를 가르는 자리(critical/high 0건)와
 * 같다. 두 곳이 어긋나면 파이프라인은 통과인데 PR은 리젝인 상태가 생긴다.
 *
 * 정합 심급이 coherent=false를 냈으면 결함이 없어도 request_changes로 내린다.
 * submitConsensus의 approved도 같은 조건으로 막는다.
 */
function verdictOf(issues: ReviewIssue[], continuityBlocks: boolean): ReviewVerdict {
  const hasDefect = issues.some((i) => i.severity === 'critical' || i.severity === 'high');
  return hasDefect || continuityBlocks ? 'request_changes' : 'approve';
}

/**
 * 리뷰 에이전트 이름을 Actor 형태로 바꾼다.
 *
 * Actor는 `codex:worker-2`처럼 앞에 주체를 붙인다. 에이전트 이름에는 그 접두사가
 * 없어서 `agent:`를 붙인다. 이미 콜론이 있으면 부르는 쪽이 형태를 갖췄다고 보고 둔다.
 */
function actorOfAgent(name: string): string {
  return name.includes(':') ? name : `agent:${name}`;
}

function issueBody(issue: ReviewIssue): string {
  const head = `**[${issue.severity}] ${issue.category}** — ${issue.reportedBy}`;
  const suggestion = issue.suggestion ? `\n\n제안: ${issue.suggestion}` : '';
  return `${head}\n\n${issue.message}${suggestion}`;
}

function handleReviewPublish(reviewEngine: PassthroughReviewEngine, input: ExecuteInput): string {
  if (!input.reviewSessionId) {
    return JSON.stringify({ error: 'reviewSessionId is required for review_publish' });
  }

  const session = reviewEngine.getSession(input.reviewSessionId);
  const consensus = session.consensus;
  if (!consensus) {
    return JSON.stringify({
      error: 'review_publish는 합의 결과를 옮긴다. review_consensus를 먼저 부른다',
    });
  }

  const prId = input.prId ?? session.prId;
  if (!prId) {
    return JSON.stringify({
      error: 'prId is required for review_publish (review_start를 prId로 열었으면 생략 가능)',
    });
  }

  const repoRoot = resolve(input.repoRoot ?? session.repoRoot ?? process.cwd());
  const continuityBlocks = session.continuityVerdict ? !session.continuityVerdict.coherent : false;
  const verdict = verdictOf(consensus.mergedIssues, continuityBlocks);
  const reviewer = input.prReviewer ?? process.env['GESTALT_ACTOR'] ?? 'gestalt:review';

  log(`review_publish: prId=${prId}, repoRoot=${repoRoot}, verdict=${verdict}`);

  const engine = new LocalPrEngine(repoRoot);
  try {
    const postedComments: { path: string; line: number | null; author: string }[] = [];
    for (const issue of consensus.mergedIssues) {
      // 지적의 파일과 라인이 그대로 코멘트 위치다. 라인이 없으면 파일 전체 코멘트다.
      engine.comment(prId, {
        author: actorOfAgent(issue.reportedBy),
        path: issue.file,
        line: issue.line,
        body: issueBody(issue),
      });
      postedComments.push({
        path: issue.file,
        line: issue.line ?? null,
        author: actorOfAgent(issue.reportedBy),
      });
    }

    const pr = engine.review(prId, { reviewer, verdict, summary: consensus.summary });

    return JSON.stringify(
      {
        status: 'review_published',
        reviewSessionId: input.reviewSessionId,
        prId,
        verdict,
        reviewer,
        commentCount: postedComments.length,
        comments: postedComments,
        prStatus: pr.status,
        round: pr.rounds.length,
        message:
          verdict === 'approve'
            ? 'PR에 approve를 남겼다. critical/high 지적이 없다.'
            : 'PR에 request_changes를 남겼다. 작성자가 코멘트를 받아 고칠 차례다.',
      },
      null,
      2,
    );
  } finally {
    engine.dispose();
  }
}
