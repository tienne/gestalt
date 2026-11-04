import type {
  ReviewConsensusInput,
  ReviewConsensusResult,
  ReviewIssue,
  ReviewResult,
} from '../core/types.js';
import { type Result, ok, err } from '../core/result.js';
import { findOriginals, resolveDroppedIssues } from './verification.js';

/**
 * review_consensus 입력의 빈 칸을 세션에 남은 review_submit 기록으로 채운다.
 *
 * 메인이 빠뜨리기 쉬운 칸은 대부분 엔진이 이미 아는 값이다. 그걸 이유로 호출을 거부하면 같은
 * 내용을 한 번 더 보내는 왕복만 생긴다. 판정에 쓰이는 값(mergedIssues의 severity, 뺀 이슈의
 * 원본)은 여기서 만들지 않는다. overallApproved는 엔진이 판정한 뒤 따로 넣는다.
 */
export function resolveConsensusInput(
  input: ReviewConsensusInput,
  reviewResults: ReviewResult[],
): Result<Omit<ReviewConsensusResult, 'overallApproved'>> {
  const problems: string[] = [];

  const mergedIssues: ReviewIssue[] = [];
  for (const issue of input.mergedIssues) {
    const reportedBy = issue.reportedBy ?? findOriginals(issue, reviewResults)[0]?.reportedBy;
    if (reportedBy === undefined) {
      problems.push(
        `mergedIssues의 ${issue.id}: reportedBy가 비었는데 같은 id나 \`<reportedBy>:<원래 id>\` 꼴의 review_submit 원본이 없어 채울 수 없다. 그 의견을 낸 에이전트 이름 하나를 적는다.`,
      );
      continue;
    }
    mergedIssues.push({ ...issue, reportedBy });
  }

  const dropped = resolveDroppedIssues(input, reviewResults);
  if (!dropped.ok) problems.push(dropped.error.message);
  if (problems.length > 0) return err(new Error(problems.join('\n\n')));

  const votes = lastVotes(reviewResults);
  const droppedIssues = dropped.ok ? dropped.value : undefined;
  return ok({
    mergedIssues,
    approvedBy: input.approvedBy ?? votes.filter((v) => v.approved).map((v) => v.agentName),
    blockedBy: input.blockedBy ?? votes.filter((v) => !v.approved).map((v) => v.agentName),
    summary: input.summary ?? countSummary(mergedIssues, droppedIssues?.length ?? 0),
    ...(droppedIssues ? { droppedIssues } : {}),
  });
}

/** 같은 리뷰어가 두 번 냈으면 마지막 제출을 그 리뷰어의 판정으로 본다 */
function lastVotes(reviewResults: ReviewResult[]): { agentName: string; approved: boolean }[] {
  const votes = new Map<string, boolean>();
  for (const result of reviewResults) votes.set(result.agentName, result.approved);
  return [...votes].map(([agentName, approved]) => ({ agentName, approved }));
}

function countSummary(issues: ReviewIssue[], droppedCount: number): string {
  const count = (severity: ReviewIssue['severity']) =>
    issues.filter((i) => i.severity === severity).length;
  const dropped = droppedCount > 0 ? `, 뺀 이슈 ${droppedCount}개` : '';
  return `이슈 ${issues.length}개(critical ${count('critical')}, high ${count('high')}, warning ${count('warning')})${dropped}. 요약이 비어 엔진이 이슈 수로 채웠다.`;
}
