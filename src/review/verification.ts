import type { ReviewConsensusResult, ReviewIssue, ReviewResult } from '../core/types.js';

/**
 * 제안 검증이 판정에서 뺄 수 없는 이슈인가.
 *
 * 검증 단계가 "이미 확인했다"는 말로 진짜 결함을 덮는 통로가 되면 안 된다. 보안과 critical은
 * 전제가 틀렸다는 판단이 맞더라도 사람이 보고 지우는 쪽이 싸다.
 * category에 `secur`나 `appsec`이 들어 있으면 자리와 구분자와 상관없이 security로 본다.
 * 접두만 보면 `app-security`, 콜론만 보면 `security/xss`처럼 모양만 바꾼 이슈가 빠져나간다.
 * 넓게 막는 쪽이 싸다.
 */
export function isUndroppable(issue: Pick<ReviewIssue, 'severity' | 'category'>): boolean {
  if (issue.severity === 'critical') return true;
  return /secur|appsec/.test(issue.category.toLowerCase());
}

export interface VerificationStats {
  keep: number;
  revise: number;
  drop: number;
  /** 검증 없이 넘어온 critical/high. 검증을 건너뛴 라운드가 숫자로 드러나게 센다 */
  unverifiedCriticalHigh: number;
}

/** 엔진 이벤트와 consensus 응답, 리포트가 같은 수를 쓰도록 한 자리에서 센다 */
export function verificationStats(
  consensus: Pick<ReviewConsensusResult, 'mergedIssues' | 'droppedIssues'>,
): VerificationStats {
  const stats: VerificationStats = {
    keep: 0,
    revise: 0,
    drop: consensus.droppedIssues?.length ?? 0,
    unverifiedCriticalHigh: 0,
  };
  for (const issue of consensus.mergedIssues) {
    const verdict = issue.verification?.verdict;
    if (verdict === 'keep') stats.keep++;
    else if (verdict === 'revise') stats.revise++;
    else if (issue.severity === 'critical' || issue.severity === 'high') {
      stats.unverifiedCriticalHigh++;
    }
  }
  return stats;
}

/** id와 reportedBy는 대소문자와 앞뒤 공백을 빼고 비교한다. 표기만 바꿔 대조를 피하지 못하게 */
function norm(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 뺀 이슈의 review_submit 원본 후보를 찾는다.
 *
 * 메인이 id를 고유화하는 꼴(`<reportedBy>:<원래 id>`)과 맞는 원본이 있으면 그것을 본다.
 * 그 접두와 뺀 이슈의 reportedBy가 어긋나면 reportedBy 쪽 리뷰어의 같은 id 원본도 후보에 넣는다.
 * 어느 쪽이 맞는지 가릴 수 없으면 둘 다 보는 게 안전해서다.
 * 접두 꼴 원본이 없으면 id가 같은 원본을 reportedBy와 상관없이 전부 후보로 둔다. 병합하면서 대표
 * reportedBy를 바꾸는 일이 흔해서 reportedBy까지 맞추라고 하면 그 자리로 금지를 피할 수 있다.
 */
function findOriginals(dropped: ReviewIssue, reviewResults: ReviewResult[]): ReviewIssue[] {
  const all = reviewResults.flatMap((result) => result.issues);
  const id = norm(dropped.id);
  const by = norm(dropped.reportedBy);
  const prefixed = all.filter((orig) => norm(`${orig.reportedBy}:${orig.id}`) === id);
  if (prefixed.length === 0) return all.filter((orig) => norm(orig.id) === id);
  if (prefixed.every((orig) => norm(orig.reportedBy) === by)) return prefixed;
  const suffixes = new Set(prefixed.map((orig) => norm(orig.id)));
  const sameReporter = all.filter(
    (orig) => norm(orig.reportedBy) === by && suffixes.has(norm(orig.id)),
  );
  return [...prefixed, ...sameReporter];
}

/** 공백과 제로폭 문자만 있는 값은 이유나 증거로 치지 않는다 */
function hasContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * droppedIssues가 우회로로 쓰이지 않았는지 본다. 문제가 없으면 null이다.
 *
 * 애매하면 거부한다. 후보 원본 중 하나라도 금지 대상이면 막는다.
 * 병합하면서 severity나 category를 바꿔 금지를 피하는 길도 막으려고 review_submit 원본과
 * 대조한다. 원본 후보가 하나도 없을 때만 통과시킨다. 메인이 id를 다른 꼴로 바꿨을 수도 있는데
 * 그걸로 정상 호출까지 막으면 이 검사를 끄자는 쪽으로 가게 된다.
 */
export function checkDroppedIssues(
  consensus: Pick<ReviewConsensusResult, 'mergedIssues' | 'droppedIssues'>,
  reviewResults: ReviewResult[],
): string | null {
  const dropped = consensus.droppedIssues ?? [];
  if (dropped.length === 0) return null;

  const mergedIds = new Set(consensus.mergedIssues.map((issue) => norm(issue.id)));
  const seenDropped = new Set<string>();
  const problems: string[] = [];

  for (const issue of dropped) {
    if (seenDropped.has(norm(issue.id))) {
      problems.push(`${issue.id}: droppedIssues 안에 같은 id가 두 번 있다`);
      continue;
    }
    seenDropped.add(norm(issue.id));
    if (isUndroppable(issue)) {
      problems.push(`${issue.id}: security category이거나 critical이라 뺄 수 없다`);
      continue;
    }
    const undroppableOriginal = findOriginals(issue, reviewResults).find(isUndroppable);
    if (undroppableOriginal) {
      problems.push(
        `${issue.id}: review_submit 원본이 ${undroppableOriginal.severity}/${undroppableOriginal.category}라 뺄 수 없다`,
      );
      continue;
    }
    if (!hasContent(issue.dropReason) || !hasContent(issue.dropEvidence)) {
      problems.push(`${issue.id}: dropReason과 dropEvidence가 둘 다 있어야 뺄 수 있다`);
      continue;
    }
    if (mergedIds.has(norm(issue.id))) {
      problems.push(`${issue.id}: mergedIssues에도 같은 id가 있다. 어느 한쪽에만 둔다`);
    }
  }

  if (problems.length === 0) return null;
  return [
    'droppedIssues를 받을 수 없다. 걸린 이슈를 mergedIssues로 되돌려 keep이나 revise로 다시 부른다.',
    ...problems.map((p) => `- ${p}`),
  ].join('\n');
}
