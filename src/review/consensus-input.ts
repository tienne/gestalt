import type {
  ReviewConsensusInput,
  ReviewConsensusResult,
  ReviewIssue,
  ReviewResult,
} from '../core/types.js';
import { type Result, ok, err } from '../core/result.js';
import {
  ambiguousSourceMessage,
  findOriginals,
  givenReportedBy,
  isUndroppable,
  pickFillSource,
  resolveDroppedIssues,
} from './verification.js';

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
    let reportedBy = givenReportedBy(issue.reportedBy);
    if (reportedBy === undefined) {
      const source = pickFillSource(undefined, findOriginals(issue, reviewResults));
      if (source === 'ambiguous') {
        problems.push(`mergedIssues의 ${ambiguousSourceMessage(issue.id)}.`);
        continue;
      }
      reportedBy = source?.reportedBy;
    }
    if (reportedBy === undefined) {
      problems.push(
        `mergedIssues의 ${issue.id}: reportedBy가 비었는데 같은 id나 \`<reportedBy>:<원래 id>\` 꼴의 review_submit 원본이 없어 채울 수 없다. 그 의견을 낸 에이전트 이름 하나를 적는다.`,
      );
      continue;
    }
    mergedIssues.push({ ...issue, reportedBy });
  }
  problems.push(...unlinkedUndroppable(mergedIssues, reviewResults));

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

/**
 * critical이나 security 원본이 mergedIssues에 이어져 있는지 본다. 없으면 문구를 돌려준다.
 *
 * 이 검사는 제안 검증 기록과 상관없이 돈다. 기록이 있어도 합의를 비워 보내면 그 원본은 아무
 * 대조도 안 받고 판정에서 사라지는데, droppedIssues는 이런 이슈를 못 빼게 막아 둔 자리라 그
 * 금지를 통째로 피하는 길이 된다. 새 id로 합친 이슈는 원본과 이을 수 없으므로 이 두 종류만
 * 같은 id나 `<reportedBy>:<원래 id>` 꼴로 두게 한다.
 */
function unlinkedUndroppable(mergedIssues: ReviewIssue[], reviewResults: ReviewResult[]): string[] {
  const linked = new Set<ReviewIssue>();
  for (const issue of mergedIssues) {
    for (const orig of findOriginals(issue, reviewResults)) linked.add(orig);
  }
  const problems: string[] = [];
  for (const result of reviewResults) {
    for (const orig of result.issues) {
      if (!isUndroppable(orig) || linked.has(orig)) continue;
      problems.push(
        `${orig.reportedBy}:${orig.id}: ${orig.severity}/${orig.category} 원본이 mergedIssues에 없다. 같은 id나 \`<reportedBy>:<원래 id>\` 꼴로 mergedIssues에 둔다. 여러 원본을 새 id 하나로 합쳤다면 critical이나 security 원본은 따로 둔다.`,
      );
    }
  }
  return problems;
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
