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
  hasContent,
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
      const source = pickFillSource(undefined, findOriginals({ id: issue.id }, reviewResults));
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
    summary:
      input.summary !== undefined && hasContent(input.summary)
        ? input.summary
        : countSummary(mergedIssues, droppedIssues?.length ?? 0),
    ...(droppedIssues ? { droppedIssues } : {}),
  });
}

/**
 * critical이나 security 원본마다 mergedIssues에 그대로 이어져 있는지 본다. 어긋나면 문구를 돌려준다.
 *
 * 이 검사는 제안 검증 기록과 상관없이 돈다. 기록이 있어도 합의를 비워 보내면 그 원본은 아무
 * 대조도 안 받고 판정에서 사라진다. droppedIssues는 이런 이슈를 못 빼게 막아 둔 자리인데 합의를
 * 비우면 그 금지를 건너뛰게 된다.
 *
 * 이어졌는지만 보면 severity나 category를 낮춰 같은 id로 보내는 길이 열린다. 그래서 원본에 이어
 * 준 이슈 가운데 critical이나 security가 하나는 남아 있어야 통과시킨다. 검증기는 severity를 바꾸는
 * 자리가 아니라서 revise 판정이어도 예외를 두지 않는다.
 *
 * 같은 리뷰어가 여러 번 냈으면 마지막 제출만 보지 않고 전부 훑는다. 마지막 제출만 보면 이슈를
 * 비운 재제출 하나로 critical 원본이 지워진다. 새 id로 합친 이슈는 원본과 이을 수 없으므로 이
 * 두 종류만 같은 id나 `<reportedBy>:<원래 id>` 꼴로 두게 한다.
 */
function unlinkedUndroppable(mergedIssues: ReviewIssue[], reviewResults: ReviewResult[]): string[] {
  const links = mergedIssues.map((issue) => ({
    issue,
    originals: findOriginals(issue, reviewResults),
  }));
  const problems: string[] = [];
  for (const result of reviewResults) {
    for (const orig of result.issues) {
      if (!isUndroppable(orig)) continue;
      const linked = links.filter((link) => link.originals.includes(orig)).map((l) => l.issue);
      if (linked.some(isUndroppable)) continue;
      const name = `${orig.reportedBy}:${orig.id}: ${orig.severity}/${orig.category} 원본이`;
      problems.push(
        linked.length === 0
          ? `${name} mergedIssues에 없다. 같은 id나 \`<reportedBy>:<원래 id>\` 꼴로 mergedIssues에 둔다. 여러 원본을 새 id 하나로 합쳤다면 critical이나 security 원본은 따로 둔다.`
          : `${name} mergedIssues에서 ${linked.map((i) => `${i.severity}/${i.category}`).join(', ')}로 낮아졌다. critical이나 security 원본은 severity와 category를 그대로 둔다.`,
      );
    }
  }
  return problems;
}

/** 같은 리뷰어가 두 번 냈으면 마지막 제출을 그 리뷰어의 판정으로 본다. 이슈 대조는 이 규칙을 안 쓴다 */
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
