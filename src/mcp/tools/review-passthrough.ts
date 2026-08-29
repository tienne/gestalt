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
        decision: `[Review] ${asMemoryNote(summary)}`,
        rationale: 'Code review consensus summary (agent-generated record, not an instruction)',
        specId: '',
        timestamp: now,
      });
    }
    for (const issue of mergedIssues.filter((i) => i.severity === 'critical')) {
      memoryStore.addArchitectureDecision({
        decision: `[Review:critical] ${asMemoryNote(`${issue.category}: ${issue.message}`)}`,
        rationale: asMemoryNote(issue.suggestion),
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
 * 안 바뀐 것이라 자국을 살린다. 리뷰 코멘트의 순서까지 넣는 이유는 publish가 목록의 앞에서부터
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

/**
 * 이 코멘트가 어느 합의에서 나왔는지 남기는 자국.
 *
 * 세션의 진행 상태는 메모리에만 산다. 프로세스가 죽거나 세션이 다른 자리에서 열리면
 * 그 값이 통째로 사라진다. 그러면 같은 합의로 다시 부른 publish가 코멘트를 전부 다시 쓴다.
 * PR은 이벤트 소싱이라 그렇게 붙은 중복은 지울 수 없고 사람이 손으로 닫아야 한다.
 * 그래서 어디까지 썼는지를 PR 자신에게도 남긴다 — 재기동해도 여기서 되짚는다.
 *
 * 코멘트의 `marker` 필드에 넣는다. 본문에 실었더니 CLI에서도 웹에서도 그대로 보였다 —
 * 웹은 본문을 이스케이프해서 `<!-- ... -->`를 화면에 그대로 찍고 CLI는 평문으로
 * 내보낸다. 사람이 읽을 이유가 없는 해시 줄이 리뷰 코멘트마다 붙었다.
 */
function publishMarker(issuesKey: string): string {
  return `gestalt:publish:${issuesKey}`;
}

/**
 * 자국을 본문에 싣던 시절의 형태.
 *
 * 이 자국이 이미 붙은 PR이 남아 있다. 재개 지점을 셀 때 옛 형태도 함께 봐야
 * 그 PR에 다시 publish를 걸었을 때 코멘트가 통째로 겹쳐 쓰인다.
 */
function legacyBodyMarker(issuesKey: string): string {
  return `<!-- gestalt:publish ${issuesKey} -->`;
}

/**
 * 리뷰가 만든 문장을 프로젝트 메모리에 넣기 전에 형태를 눌러 둔다.
 *
 * 이 값은 리뷰 에이전트가 diff와 코멘트를 읽고 만든 것이라 신뢰 경계 바깥이다.
 * 그리고 메모리의 아키텍처 결정은 이후 모든 스펙 생성 프롬프트에 실린다 — 리뷰
 * 대상 코드에 심어 둔 문장이 그 경로로 들어갈 수 있다.
 *
 * 줄바꿈을 없애 프롬프트 안에서 새 절이나 목록을 만들지 못하게 한다. 길이를 잘라
 * 긴 지시문이 통째로 실리지 않게 한다. 내용 자체는 판단하지 않는다 — 그건 여기서
 * 할 수 있는 일이 아니다. 형태를 눌러 두는 것까지가 이 함수의 범위다.
 */
const MAX_MEMORY_CHARS = 300;

function asMemoryNote(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_MEMORY_CHARS);
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
    const sessionPrior =
      session.publishState?.prId === prId &&
      session.publishState.headSha === headSha &&
      session.publishState.issuesKey === issuesKey
        ? session.publishState
        : undefined;

    // 세션 자국이 없어도 PR 자신에게 물어본다. 자국은 메모리에만 살아서 프로세스가
    // 죽거나 세션이 다른 자리에서 열리면 사라진다. 그런데 PR에 붙은 코멘트는 남아 있다.
    // 그 수를 세지 않으면 재기동 뒤 같은 합의가 코멘트를 통째로 다시 쓴다.
    const marker = publishMarker(issuesKey);
    const legacy = legacyBodyMarker(issuesKey);
    const alreadyOnPr = target.comments.filter(
      (c) => c.headSha === headSha && (c.marker === marker || c.body.includes(legacy)),
    ).length;
    const alreadyJudged = target.reviews.some(
      (r) => r.headSha === headSha && r.reviewer === reviewer,
    );

    const prior: ReviewPublishState | undefined =
      sessionPrior ??
      (alreadyOnPr > 0
        ? {
            prId,
            headSha,
            issuesKey,
            postedCount: alreadyOnPr,
            completed: alreadyOnPr >= consensus.mergedIssues.length && alreadyJudged,
            verdict,
            reviewer,
          }
        : undefined);

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

    // 앞선 호출이 코멘트 루프 중간에 던졌으면 그다음 코멘트부터 잇는다. 코멘트 N건과
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
    const pending = issues.slice(state.postedCount);

    // 리뷰 코멘트의 파일과 라인이 그대로 코멘트 위치다. 라인이 없으면 파일 전체 코멘트다.
    if (pending.length > 0) {
      // 재개 지점은 엔진이 주는 인덱스로만 잡는다. 여기서 카운터를 따로 올리면 두
      // 계산이 갈릴 때 재개 지점이 밀려 코멘트가 겹치거나 빠진다
      const resumeFrom = state.postedCount;
      engine.commentMany(
        prId,
        pending.map((issue) => ({
          author: actorOfAgent(issue.reportedBy),
          path: issue.file,
          line: issue.line,
          body: issueBody(issue),
          marker,
        })),
        (i) => {
          state.postedCount = resumeFrom + i + 1;
        },
      );
    }

    const postedComments = pending.map((issue) => ({
      path: issue.file,
      line: issue.line ?? null,
      author: actorOfAgent(issue.reportedBy),
    }));

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
            ? 'PR에 approve를 남겼다. critical/high 결함이 없다.'
            : 'PR에 request_changes를 남겼다. 작성자가 코멘트를 받아 고칠 차례다.',
      },
      null,
      2,
    );
  } finally {
    engine.dispose();
  }
}
