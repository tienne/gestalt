import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ReviewSession,
  ReviewResult,
  ReviewConsensusResult,
  ReviewConsensusInput,
  ReviewReport,
  ReviewIssue,
  ReviewContext,
  ExecuteSession,
  AgentDefinition,
  ContinuityVerdict,
  ContinuityDriftFinding,
  ReviewVerifierRecord,
} from '../core/types.js';
import { type Result, ok, err } from '../core/result.js';
import { ReviewContextCollector } from './context-collector.js';
import {
  HARNESS_REVIEWER,
  ReviewAgentMatcher,
  detectHarnessTargets,
  ensureRequiredAgents,
  type ReviewMatchContext,
} from './agent-matcher.js';
import { ReviewReportGenerator } from './report-generator.js';
import { logger } from '../core/logger.js';
import type { EventStore } from '../events/store.js';
import { EventType } from '../events/types.js';
import { isConsensusApproved } from '../local-pr/policy.js';
import { hasContent, verificationStats, type VerificationStats } from './verification.js';
import { resolveConsensusInput } from './consensus-input.js';
import {
  checkConsensusAgainstVerifier,
  parseVerifierOutput,
  summarizeVerifierRecord,
  verifierAtConsensus,
} from './verifier-record.js';

const MAX_REVIEW_ATTEMPTS = 3;

/**
 * 코드펜스 기호와 바로 뒤에 붙은 언어 표시를 지운다. ```json만 있는 응답이 `json`이라는 글자
 * 때문에 내용이 있는 것으로 읽히지 않게 빈 응답 판정에서만 쓴다. 공용 hasContent는 그대로 둔다.
 */
function stripCodeFences(text: string): string {
  return text.replace(/```[\w+-]*/g, '');
}

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
  /** 정합 심급이 잡은 수정 가능한(escalate 아닌) 이탈 항목. 라인 수정과 함께 해소한다. */
  driftFindings: ContinuityDriftFinding[];
  attempt: number;
  maxAttempts: number;
}

// 매칭 프롬프트로 요구만 하면 호출자가 빼먹어도 그대로 합의까지 간다. 합의 입구에서 막아야 강제가 된다
function checkMissingRequiredReviews(session: ReviewSession): string | null {
  const harnessTargets = session.reviewContext?.harnessTargets ?? [];
  if (harnessTargets.length === 0) return null;
  const submitted = new Set(session.reviewResults.map((r) => r.agentName));
  if (submitted.has(HARNESS_REVIEWER)) return null;
  return (
    `review_consensus rejected: ${HARNESS_REVIEWER} review is missing. ` +
    `Harness targets changed (${harnessTargets.join(', ')}), so submit ${HARNESS_REVIEWER} ` +
    `with review_submit before calling review_consensus.`
  );
}

export class PassthroughReviewEngine {
  private sessions = new Map<string, ReviewSession>();
  private contextCollector = new ReviewContextCollector();
  private agentMatcher = new ReviewAgentMatcher();
  private reportGenerator = new ReviewReportGenerator();

  constructor(private eventStore?: EventStore) {}

  // ─── review_start ─────────────────────────────────────────────
  startReview(
    source:
      | { executeSession: ExecuteSession }
      | { changedFiles: string[]; repoRoot: string; prId?: string },
    roleAgents: AgentDefinition[],
    reviewAgents: AgentDefinition[],
    options: { sinceSha?: string } = {},
  ): Result<{ sessionId: string; reviewStartContext: ReviewStartContext }> {
    const { sinceSha } = options;
    let reviewContext: ReviewContext;
    let executeSessionId: string;
    let repoRoot: string | undefined;
    // 로컬 PR에서 시작한 리뷰만 prId를 갖는다. 나머지 둘은 undefined다.
    const prId = 'executeSession' in source ? undefined : source.prId;

    if ('executeSession' in source) {
      reviewContext = this.contextCollector.collect(
        source.executeSession.spec,
        source.executeSession.taskResults,
      );
      executeSessionId = source.executeSession.sessionId;
      repoRoot = source.executeSession.codeGraphRepoRoot;
    } else {
      reviewContext = this.contextCollector.collectFromFiles(source.changedFiles);
      // Sentinel: direct file review has no backing execute session
      executeSessionId = '';
      repoRoot = source.repoRoot;
    }

    // 내용이 필요한 판정(MCP 도구 등록부, 공개 패키지)은 레포를 알 때만 한다
    const readFile = repoRoot
      ? (relPath: string) => {
          try {
            return readFileSync(join(repoRoot, relPath), 'utf-8');
          } catch {
            return undefined;
          }
        }
      : undefined;
    reviewContext.harnessTargets = detectHarnessTargets(reviewContext.changedFiles, readFile);

    const matchContext = this.agentMatcher.generateMatchContext(
      reviewContext,
      roleAgents,
      reviewAgents,
    );

    const sessionId = randomUUID();
    const session: ReviewSession = {
      sessionId,
      executeSessionId,
      status: 'started',
      currentAttempt: 0,
      maxAttempts: MAX_REVIEW_ATTEMPTS,
      reviewContext,
      repoRoot,
      prId,
      ...(sinceSha ? { sinceSha } : {}),
      // 호출자가 매칭에서 필수 에이전트를 빼도 expectedCount에는 잡혀 있어야 누락이 드러난다
      matchedAgents: ensureRequiredAgents([], matchContext.requiredAgents, (agentName) => ({
        agentName,
      })).map((m) => m.agentName),
      reviewResults: [],
      reports: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(sessionId, session);

    logger.info('review.started', {
      module: 'review',
      sessionId,
      changedFiles: reviewContext.changedFiles.length,
      dependencyFiles: reviewContext.dependencyFiles.length,
      mode: 'executeSession' in source ? 'execute' : 'direct',
    });

    this.emitEvent(sessionId, EventType.REVIEW_STARTED, {
      executeSessionId,
      changedFiles: reviewContext.changedFiles.length,
      dependencyFiles: reviewContext.dependencyFiles.length,
      // 재리뷰 비율을 나중에 이벤트만으로 재려고 싣는다. 첫 리뷰에는 키가 없다.
      ...(sinceSha ? { sinceSha } : {}),
    });

    const systemPrompt = `You are a code reviewer in the Gestalt pipeline.
Your job is to review code changes from the perspective of the assigned agent role.

## Review Rules
1. Focus on your specific domain expertise
2. **Your agent definition wins.** If it names a rulebook or lists specific patterns you must report, apply those as written — they are more specific than the general guidance here
3. Classify each issue as: critical, high, or warning
4. Provide actionable suggestions with code examples when possible
5. Be specific about file and line number
6. Don't flag formatting a linter or formatter already handles (semicolons, quotes, indentation, import order). Comment hygiene, naming, and structure are not formatter concerns — review them

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

    const constraintsBlock =
      reviewContext.spec && reviewContext.spec.constraints.length > 0
        ? reviewContext.spec.constraints.map((c) => `  - ${c}`).join('\n')
        : '  (none)';

    const dependencyBlock =
      reviewContext.dependencyFiles.length > 0
        ? `\n**Dependency Context** (${reviewContext.dependencyFiles.length}):\n${reviewContext.dependencyFiles
            .map((f) => `  - ${f}`)
            .join('\n')}\n`
        : '';

    // 리뷰어 워크트리의 HEAD는 리뷰 대상 head가 아닐 수 있어 ..HEAD로 쓰지 않는다.
    const sinceBlock = sinceSha
      ? `\n\nSince last review: ${sinceSha}. Changes in this round are \`git diff ${sinceSha}..<reviewed head>\`; prioritize them.`
      : '';

    const reviewPrompt = `## Code Review

**Spec Goal**: ${reviewContext.spec?.goal ?? 'Direct file review'}

**Changed Files** (${reviewContext.changedFiles.length}):
${reviewContext.changedFiles.map((f) => `  - ${f}`).join('\n')}
${dependencyBlock}
**Constraints**:
${constraintsBlock}

Review the code changes from your assigned perspective. Focus on issues that matter, not nitpicks — but anything your agent rules explicitly require you to report is never a nitpick.

**Changed lines**: the file list above does not tell you which lines changed. Run \`git diff\` before judging any rule that only applies to new or modified lines.${sinceBlock}`;

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

    logger.info('review.submitted', {
      module: 'review',
      sessionId,
      agentName,
      issueCount: result.issues.length,
      approved: result.approved,
    });

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

  // ─── review_verify ────────────────────────────────────────────
  /**
   * 제안 검증 응답을 읽어 세션에 남긴다. 응답을 못 읽어도 거부하지 않는다 — 서브에이전트
   * 실패도 기록으로 남아야 review_publish가 정당한 생략으로 가를 수 있다. 다만 빈 응답은
   * 기록하지 않고 거부한다. 검증기를 안 띄우고 빈 문자열만 넘겨도 실패가 되면 그게 가장 싼
   * 건너뛰기 길이 된다.
   */
  submitVerification(sessionId: string, verifierOutput: string): Result<ReviewVerifierRecord> {
    const session = this.sessions.get(sessionId);
    if (!session) return err(new Error(`Review session not found: ${sessionId}`));
    if (!hasContent(stripCodeFences(verifierOutput))) {
      return err(
        new Error(
          '검증기 응답이 비었다. suggestion-verifier를 한 번 다시 띄워 그 응답을 넘긴다. ' +
            '두 번째도 비면 그 사실을 적은 글을 넘긴다. 실패로 기록되고 초안 그대로 게시된다.',
        ),
      );
    }

    const record = parseVerifierOutput(verifierOutput, session.reviewResults.length);
    session.verifier = record;
    session.updatedAt = new Date().toISOString();

    logger.info('review.verified', {
      module: 'review',
      sessionId,
      status: record.status,
      failure: record.failure,
      ...summarizeVerifierRecord(record),
    });

    return ok(record);
  }

  // ─── review_consensus ─────────────────────────────────────────
  submitConsensus(
    sessionId: string,
    input: ReviewConsensusInput,
    continuityVerdict?: ContinuityVerdict,
  ): Result<{
    approved: boolean;
    report: ReviewReport;
    needsFix: boolean;
    canFix: boolean;
    criticalHighCount: number;
    escalate: boolean;
    verification: VerificationStats;
  }> {
    const session = this.sessions.get(sessionId);
    if (!session) return err(new Error(`Review session not found: ${sessionId}`));

    // 세션을 덮어쓰기 전에 거른다. 거부된 호출이 앞서 받은 합의를 지우면 안 된다
    const missingProblem = checkMissingRequiredReviews(session);
    if (missingProblem) {
      logger.warn('review.consensus_rejected', {
        module: 'review',
        sessionId,
        reason: 'missing_required_review',
      });
      return err(new Error(missingProblem));
    }

    // 뺀 이슈 검사도 여기서 돈다. 빈 칸을 채우기 전에 원본으로 금지 여부부터 본다
    const resolved = resolveConsensusInput(input, session.reviewResults);
    if (!resolved.ok) {
      logger.warn('review.consensus_rejected', {
        module: 'review',
        sessionId,
        reason: 'unresolvable_input',
        droppedCount: input.droppedIssues?.length ?? 0,
      });
      return err(resolved.error);
    }

    const verifier = verifierAtConsensus(session);
    const verifierProblem = checkConsensusAgainstVerifier(verifier, resolved.value);
    if (verifierProblem) {
      logger.warn('review.consensus_rejected', {
        module: 'review',
        sessionId,
        reason: 'verifier_mismatch',
        verifier: verifier.status,
      });
      return err(new Error(verifierProblem));
    }

    // 두 심급을 합친 경계는 정책이 정한다. review_publish가 PR에 남길 판정도 같은
    // 함수를 부른다 — 따로 세면 파이프라인은 통과인데 PR은 리젝인 상태가 생긴다.
    // 입력의 overallApproved는 쓰지 않는다
    const approved = isConsensusApproved(resolved.value.mergedIssues, continuityVerdict);
    const consensus: ReviewConsensusResult = { ...resolved.value, overallApproved: approved };

    session.consensus = consensus;
    session.continuityVerdict = continuityVerdict;
    session.verifierAtConsensus = verifier;
    session.status = 'consensus';
    session.updatedAt = new Date().toISOString();

    const criticalHighIssues = consensus.mergedIssues.filter(
      (i) => i.severity === 'critical' || i.severity === 'high',
    );
    // 결함 심급: 국소 결함(critical/high) 유무.
    const defectApproved = criticalHighIssues.length === 0;
    const continuityBlocks = continuityVerdict ? !continuityVerdict.coherent : false;
    const escalate = continuityVerdict?.escalate ?? false;
    const needsFix = !approved;
    // review_fix 루프는 결함만 해결한다. 결함이 없고 정합 심급만 Block이면
    // 자동 수정 대상이 아니므로 canFix=false (escalate 신호로 라우팅).
    const canFix = !defectApproved && session.currentAttempt < session.maxAttempts;

    const report = this.reportGenerator.generate(
      consensus,
      session.currentAttempt + 1,
      continuityVerdict,
      session.repoRoot,
    );
    session.reports.push(report);

    const verification = verificationStats(consensus);

    this.emitEvent(sessionId, EventType.REVIEW_CONSENSUS_COMPLETED, {
      totalIssues: consensus.mergedIssues.length,
      criticalHighCount: criticalHighIssues.length,
      approved,
      approvedBy: consensus.approvedBy,
      blockedBy: consensus.blockedBy,
      continuityCoherent: continuityVerdict ? continuityVerdict.coherent : null,
      driftCount: continuityVerdict?.driftFindings.length ?? 0,
      escalate,
      // 제안 검증이 라운드 수를 줄였는지 나중에 재려고 남긴다
      verification,
      verifier: verifier.status,
    });

    if (approved) {
      session.status = 'passed';
      logger.info('review.passed', {
        module: 'review',
        sessionId,
        attempt: session.currentAttempt + 1,
        warningCount: consensus.mergedIssues.filter((i) => i.severity === 'warning').length,
      });
      this.emitEvent(sessionId, EventType.REVIEW_PASSED, {
        attempt: session.currentAttempt + 1,
        warningCount: consensus.mergedIssues.filter((i) => i.severity === 'warning').length,
      });
    } else if (continuityBlocks && escalate && defectApproved) {
      // 결함은 없고 정합 심급이 escalate만 걸었다 → 재설계 신호. fix 루프로 보내지 않는다.
      session.status = 'escalated';
      logger.warn('review.escalated', {
        module: 'review',
        sessionId,
        attempt: session.currentAttempt + 1,
        driftCount: continuityVerdict?.driftFindings.length ?? 0,
      });
      this.emitEvent(sessionId, EventType.REVIEW_ESCALATED, {
        attempt: session.currentAttempt + 1,
        driftCount: continuityVerdict?.driftFindings.length ?? 0,
        summary: continuityVerdict?.summary ?? '',
      });
    } else {
      logger.warn('review.blocked', {
        module: 'review',
        sessionId,
        criticalHighCount: criticalHighIssues.length,
        continuityBlocks,
        attempt: session.currentAttempt + 1,
        canFix,
      });
    }

    return ok({
      approved,
      report,
      needsFix,
      canFix,
      criticalHighCount: criticalHighIssues.length,
      escalate,
      verification,
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
        undefined,
        session.repoRoot,
      );
      session.reports.push(report);

      const remainingIssues = session.consensus.mergedIssues.filter(
        (i) => i.severity === 'critical' || i.severity === 'high',
      ).length;

      logger.warn('review.exhausted', {
        module: 'review',
        sessionId,
        attempt: session.currentAttempt,
        remainingIssues,
      });

      this.emitEvent(sessionId, EventType.REVIEW_FAILED, {
        attempt: session.currentAttempt,
        reason: 'max_attempts_exceeded',
        remainingIssues,
      });

      return ok({ report, exhausted: true as const });
    }

    session.status = 'fixing';

    const criticalHighIssues = session.consensus.mergedIssues.filter(
      (i) => i.severity === 'critical' || i.severity === 'high',
    );

    logger.info('review.fix_started', {
      module: 'review',
      sessionId,
      attempt: session.currentAttempt,
      issueCount: criticalHighIssues.length,
    });

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
      .map((i) => {
        const head = `- [${i.severity.toUpperCase()}] ${i.file}${i.line ? `:${i.line}` : ''}: ${i.message}\n  Suggestion: ${i.suggestion}`;
        // 제안 검증이 짚은 자리를 같이 안 고치면 다음 라운드에 그 자리가 새 이슈로 돌아온다
        const alsoCheck = i.verification?.alsoCheck ?? [];
        if (alsoCheck.length === 0) return head;
        return `${head}\n  Also update when applying this fix:\n${alsoCheck.map((spot) => `    - ${spot}`).join('\n')}`;
      })
      .join('\n');

    // 정합 심급이 Block했지만 escalate는 아닌 경우, 그 이탈 항목은 라인 수정으로
    // 해소 가능한 정합성 문제(예: 네이밍·패턴 불일치)다. 결함과 함께 고치도록 넘긴다.
    // escalate 항목은 재설계 신호이므로 fix 컨텍스트에 넣지 않는다.
    const fixableDrift: ContinuityDriftFinding[] =
      session.continuityVerdict &&
      !session.continuityVerdict.coherent &&
      !session.continuityVerdict.escalate
        ? session.continuityVerdict.driftFindings
        : [];

    const driftBlock =
      fixableDrift.length > 0
        ? `\n\n**Continuity findings to reconcile** (${fixableDrift.length}):\n` +
          fixableDrift
            .map((d) => `- [${d.axis}]${d.file ? ` ${d.file}` : ''}: ${d.message}`)
            .join('\n')
        : '';

    const fixPrompt = `## Fix Code Review Issues (Attempt ${session.currentAttempt}/${session.maxAttempts})

**Issues to fix** (${criticalHighIssues.length}):
${issueList}${driftBlock}

Fix these issues while maintaining code integrity. Run structural checks after fixing.`;

    return ok({
      systemPrompt,
      fixPrompt,
      issues: criticalHighIssues,
      driftFindings: fixableDrift,
      attempt: session.currentAttempt,
      maxAttempts: session.maxAttempts,
    });
  }

  submitFix(sessionId: string): Result<{ readyForReReview: boolean; attempt: number }> {
    const session = this.sessions.get(sessionId);
    if (!session) return err(new Error(`Review session not found: ${sessionId}`));

    // Reset for re-review — 두 심급 모두 초기화해 재리뷰에서 결함·정합을 새로 평가한다.
    session.reviewResults = [];
    session.consensus = undefined;
    session.continuityVerdict = undefined;
    session.verifier = undefined;
    session.verifierAtConsensus = undefined;
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
