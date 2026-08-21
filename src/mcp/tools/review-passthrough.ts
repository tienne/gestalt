import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { PassthroughReviewEngine } from '../../review/passthrough-engine.js';
import type { PassthroughExecuteEngine } from '../../execute/passthrough-engine.js';
import type { RoleAgentRegistry } from '../../agent/role-agent-registry.js';
import type { ExecuteInput } from '../schemas.js';
import { ProjectMemoryStore } from '../../memory/project-memory-store.js';
import { LocalPrEngine, PrError } from '../../local-pr/engine.js';
import { errorKind } from './pr.js';
import { consensusVerdict, resolveActor } from '../../local-pr/policy.js';
import type { ContinuityVerdict, ReviewIssue, ReviewPublishState } from '../../core/types.js';
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
  // 다만 prId를 함께 줬으면 셀렉터를 해석하지 않는다. prId 갈래는 실행 세션을 쓰지
  // 않는다. 여기서 해석에 실패해도 그 뒤 판단에 영향이 없다. 그런데 해석을 먼저 돌리면
  // 스키마에 적은 우선순위(prId > sessionId)가 뒤집힌다. 없는 sessionId를 명시하면
  // 통과하고 latest 셀렉터를 주면 막히는 갈림도 여기서 사라진다.
  let input = rawInput;
  if (!input.prId) {
    const resolved = resolveExecuteSessionInput(executeEngine, input);
    if (!resolved.ok) return JSON.stringify({ error: resolved.error });
    input = resolved.input;
  }

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
    const message = e instanceof Error ? e.message : String(e);
    // LocalPrEngine이 던지는 PrError는 exitCode로 갈래를 실어 보낸다. ges_pr이 쓰는
    // 같은 변환기로 kind를 붙여 두 도구의 응답 규약을 하나로 맞춘다.
    if (e instanceof PrError)
      return JSON.stringify({ error: message, kind: errorKind(e.exitCode) });
    return JSON.stringify({ error: message });
  }
}

/**
 * 로컬 PR에서 리뷰 대상(변경 파일)을 끌어온다. 조회가 끝나면 저장소를 닫는다.
 *
 * 실패는 PrError로 던진다. 바깥 catch가 exitCode를 kind로 접어서 ges_pr과 같은
 * 응답 규약을 쓴다. 3은 PR을 못 찾은 것이다. 4는 PR은 있는데 리뷰할 게 없는 상태다.
 */
function collectPrSource(
  prId: string,
  repoRoot: string,
): { changedFiles: string[]; repoRoot: string; prId: string } {
  const engine = new LocalPrEngine(repoRoot);
  try {
    const pr = engine.get(prId);
    if (!pr) throw new PrError(`PR을 못 찾았다: ${prId}`, 3);
    const changedFiles = engine.changedFiles(prId);
    if (changedFiles.length === 0) throw new PrError(`PR ${prId}에 변경된 파일이 없다`, 4);
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
    prSource = collectPrSource(input.prId, repoRoot);
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
type PublishVerdict = Extract<ReviewVerdict, 'approve' | 'request_changes'>;

/**
 * 합의 지문. 내용이 같으면 같은 값이 나온다.
 *
 * 자국을 살릴지 버릴지를 이 값으로 가른다. 같은 합의를 다시 제출한 것은 옮길 내용이
 * 안 바뀐 것이라 자국을 살린다. 지적의 순서까지 넣는 이유는 publish가 목록의 앞에서부터
 * 세어 이어 쓰기 때문이다 — 순서가 달라지면 이어 쓸 자리가 달라진다.
 */
function fingerprint(issues: ReviewIssue[]): string {
  const shape = issues.map((i) => [i.file, i.line, i.severity, i.message, i.reportedBy]);
  return createHash('sha1').update(JSON.stringify(shape)).digest('hex');
}

function verdictOf(issues: ReviewIssue[], continuityVerdict?: ContinuityVerdict): PublishVerdict {
  // 경계를 여기서 다시 세지 않는다. submitConsensus가 approved를 가르는 그 함수를 부른다
  return consensusVerdict(issues, continuityVerdict);
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
  const verdict = verdictOf(consensus.mergedIssues, session.continuityVerdict);
  const reviewer = resolveActor(input.prReviewer, 'gestalt:review');

  log(`review_publish: prId=${prId}, repoRoot=${repoRoot}, verdict=${verdict}`);

  const engine = new LocalPrEngine(repoRoot);
  try {
    const target = engine.get(prId);
    if (!target) throw new PrError(`PR을 못 찾았다: ${prId}`, 3);
    const headSha = target.headSha;

    // 같은 PR, 같은 head, 같은 합의를 가리키는 자국만 이어 쓴다. head가 옮겨갔으면
    // 작성자가 고쳐 올린 새 라운드다. 합의가 바뀌었으면 옮길 목록 자체가 다르다.
    // 어느 쪽이든 처음부터 다시 쓰는 게 맞다.
    const issuesKey = fingerprint(consensus.mergedIssues);
    const prior =
      session.publishState?.prId === prId &&
      session.publishState.headSha === headSha &&
      session.publishState.issuesKey === issuesKey
        ? session.publishState
        : undefined;

    // 이미 한 바퀴를 끝낸 자국이면 아무것도 쓰지 않고 그때 결과를 그대로 돌려준다.
    // 막지 않고 멱등하게 만든 이유는 부르는 쪽이 호스트의 재시도라서다. 오류로 접으면
    // 호스트는 실패로 보고 다시 부른다. 그런데 PR에는 이미 다 쓰여 있다. 이벤트 소싱이라
    // 그때 붙은 중복 코멘트는 지울 수 없고 사람이 손으로 resolve하는 수밖에 없다.
    if (prior?.completed) {
      return JSON.stringify(
        {
          status: 'review_published',
          alreadyPublished: true,
          reviewSessionId: input.reviewSessionId,
          prId,
          verdict: prior.verdict,
          reviewer: prior.reviewer,
          commentCount: prior.postedCount,
          prStatus: target.status,
          round: target.rounds.length,
          message: `이 합의는 head ${headSha.slice(0, 7)}에 이미 옮겼다. 다시 쓰지 않았다.`,
        },
        null,
        2,
      );
    }

    // 앞선 호출이 코멘트 루프 중간에 던졌으면 그 다음 지적부터 잇는다. 코멘트 N건과
    // 판정 하나를 따로 쓰는 다중 쓰기라 원자적으로 묶을 수 없다. 대신 매 코멘트마다
    // 자국을 늘려서, 던진 자리가 어디든 재시도가 쓴 것을 다시 쓰지 않게 한다.
    const state: ReviewPublishState = {
      prId,
      headSha,
      issuesKey,
      postedCount: prior?.postedCount ?? 0,
      completed: false,
      verdict,
      reviewer,
    };
    session.publishState = state;

    const issues = consensus.mergedIssues;
    const postedComments: { path: string; line: number | null; author: string }[] = [];
    for (let i = state.postedCount; i < issues.length; i++) {
      const issue = issues[i]!;
      // 지적의 파일과 라인이 그대로 코멘트 위치다. 라인이 없으면 파일 전체 코멘트다.
      engine.comment(prId, {
        author: actorOfAgent(issue.reportedBy),
        path: issue.file,
        line: issue.line,
        body: issueBody(issue),
      });
      state.postedCount = i + 1;
      postedComments.push({
        path: issue.file,
        line: issue.line ?? null,
        author: actorOfAgent(issue.reportedBy),
      });
    }

    const pr = engine.review(prId, { reviewer, verdict, summary: consensus.summary });
    state.completed = true;

    return JSON.stringify(
      {
        status: 'review_published',
        reviewSessionId: input.reviewSessionId,
        prId,
        verdict,
        reviewer,
        commentCount: postedComments.length,
        comments: postedComments,
        resumedFrom: prior ? prior.postedCount : 0,
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
