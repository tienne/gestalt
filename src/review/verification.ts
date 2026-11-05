import type {
  DroppedReviewIssue,
  DroppedReviewIssueInput,
  ReviewConsensusInput,
  ReviewConsensusResult,
  ReviewIssue,
  ReviewResult,
} from '../core/types.js';
import { type Result, ok, err } from '../core/result.js';

/**
 * 제안 검증이 판정에서 뺄 수 없는 이슈인가.
 *
 * 검증 단계가 "이미 확인했다"는 말로 진짜 결함을 덮는 통로가 되면 안 된다. 보안과 critical은
 * 전제가 틀렸다는 판단이 맞더라도 사람이 보고 지우는 쪽이 싸다.
 * category에 `secur`나 `appsec`이 들어 있으면 자리와 구분자와 상관없이 security로 본다.
 * 접두만 보면 `app-security`, 콜론만 보면 `security/xss`처럼 모양만 바꾼 이슈가 빠져나간다.
 * 넓게 막는 쪽이 싸다.
 * 비어 있는 칸은 금지 근거가 못 된다. 그 자리는 review_submit 원본 대조가 맡는다.
 */
export function isUndroppable(issue: Partial<Pick<ReviewIssue, 'severity' | 'category'>>): boolean {
  if (issue.severity === 'critical') return true;
  return /secur|appsec/.test((issue.category ?? '').toLowerCase());
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
export function norm(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 이슈의 review_submit 원본 후보를 찾는다. 앞에 올수록 더 확실한 후보다.
 *
 * 메인이 id를 고유화하는 꼴(`<reportedBy>:<원래 id>`)과 맞는 원본이 있으면 그것을 본다.
 * 그 접두와 이슈의 reportedBy가 어긋나면 reportedBy 쪽 리뷰어의 같은 id 원본도 후보에 넣는다.
 * 어느 쪽이 맞는지 가릴 수 없으면 둘 다 보는 게 안전해서다.
 * 접두 꼴 원본이 없으면 id가 같은 원본을 reportedBy와 상관없이 전부 후보로 둔다. 병합하면서 대표
 * reportedBy를 바꾸는 일이 흔해서 reportedBy까지 맞추라고 하면 그 자리로 금지를 피할 수 있다.
 */
export function findOriginals(
  issue: Pick<ReviewIssue, 'id'> & { reportedBy?: string },
  reviewResults: ReviewResult[],
): ReviewIssue[] {
  const all = reviewResults.flatMap((result) => result.issues);
  const id = norm(issue.id);
  const prefixed = all.filter((orig) => norm(`${orig.reportedBy}:${orig.id}`) === id);
  if (prefixed.length === 0) return all.filter((orig) => norm(orig.id) === id);
  if (issue.reportedBy === undefined) return prefixed;
  const by = norm(issue.reportedBy);
  if (prefixed.every((orig) => norm(orig.reportedBy) === by)) return prefixed;
  const suffixes = new Set(prefixed.map((orig) => norm(orig.id)));
  const sameReporter = all.filter(
    (orig) => norm(orig.reportedBy) === by && suffixes.has(norm(orig.id)),
  );
  return [...prefixed, ...sameReporter];
}

/** 공백과 제로폭 문자만 있는 값은 이유나 증거로 치지 않는다 */
export function hasContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/** 뺀 이슈가 비워 보내도 원본에서 채우는 칸 */
const FILLABLE_DROP_FIELDS = ['severity', 'category', 'file', 'message', 'suggestion'] as const;

function missingFieldsOf(issue: DroppedReviewIssueInput): string[] {
  const fields: string[] = FILLABLE_DROP_FIELDS.filter((field) => issue[field] === undefined);
  if (issue.reportedBy === undefined) fields.push('reportedBy');
  return fields;
}

/**
 * 빈 칸을 채울 review_submit 원본 하나를 고른다.
 *
 * reportedBy를 적었으면 그 리뷰어의 원본만 쓴다. 비웠는데 후보가 여러 리뷰어에 걸쳐 있으면
 * 고르지 않는다. 리뷰어마다 `issue-1` 같은 흔한 id를 쓰면 첫 후보로 채운 작성자와 본문이 다른
 * 리뷰어 것이 된다. 금지 판단은 여기와 상관없이 후보 전체로 한다.
 */
export function pickFillSource(
  reportedBy: string | undefined,
  originals: ReviewIssue[],
): ReviewIssue | 'ambiguous' | undefined {
  if (reportedBy !== undefined) {
    const by = norm(reportedBy);
    return originals.find((orig) => norm(orig.reportedBy) === by);
  }
  const reporters = new Set(originals.map((orig) => norm(orig.reportedBy)));
  return reporters.size > 1 ? 'ambiguous' : originals[0];
}

/** 같은 id의 원본이 여러 리뷰어에게 있어 채울 원본을 못 고를 때의 안내 */
export function ambiguousSourceMessage(id: string): string {
  return `${id}: 같은 id의 review_submit 원본이 여러 리뷰어에게 있어 어느 쪽으로 채울지 고를 수 없다. reportedBy를 직접 적는다`;
}

/**
 * 빈 칸을 원본에서 채운다. 채울 수 없으면 거부 문구를 돌려준다.
 * 적어 보낸 값은 그대로 둔다. 뺄 수 있는지는 이 결과가 아니라 원본 후보 전체로 판단한다.
 */
function fillDropped(
  issue: DroppedReviewIssueInput,
  originals: ReviewIssue[],
): DroppedReviewIssue | string {
  const missing = missingFieldsOf(issue);
  if (missing.length === 0) return issue as DroppedReviewIssue;
  const source = pickFillSource(issue.reportedBy, originals);
  if (source === 'ambiguous') return ambiguousSourceMessage(issue.id);
  if (!source) {
    const owner = issue.reportedBy === undefined ? '' : `${issue.reportedBy}가 낸 `;
    return `${issue.id}: ${missing.join(', ')}가 비었는데 ${owner}같은 id의 review_submit 원본이 없어 채울 수 없다. 그 칸을 적거나 원본 id를 그대로 쓴다`;
  }
  return {
    ...issue,
    severity: issue.severity ?? source.severity,
    category: issue.category ?? source.category,
    file: issue.file ?? source.file,
    message: issue.message ?? source.message,
    suggestion: issue.suggestion ?? source.suggestion,
    reportedBy: issue.reportedBy ?? source.reportedBy,
  };
}

/**
 * droppedIssues의 빈 칸을 원본에서 채우고 우회로로 쓰이지 않았는지 본다.
 *
 * 애매하면 거부한다. 후보 원본 중 하나라도 금지 대상이면 막는다.
 * 병합하면서 severity나 category를 바꾸거나 비워 금지를 피하는 길도 막으려고 review_submit
 * 원본과 대조한다. 원본 후보가 하나도 없으면 적어 보낸 값으로만 판단한다. 그때 빈 칸이 있으면
 * 채울 근거가 없으니 거부한다. 메인이 id를 다른 꼴로 바꿨을 수도 있는데 칸을 다 적은 정상
 * 호출까지 막으면 이 검사를 끄자는 쪽으로 가게 된다.
 */
export function resolveDroppedIssues(
  consensus: Pick<ReviewConsensusInput, 'mergedIssues' | 'droppedIssues'>,
  reviewResults: ReviewResult[],
): Result<DroppedReviewIssue[] | undefined> {
  const dropped = consensus.droppedIssues;
  if (dropped === undefined) return ok(undefined);
  if (dropped.length === 0) return ok([]);

  const mergedIds = new Set(consensus.mergedIssues.map((issue) => norm(issue.id)));
  const seenDropped = new Set<string>();
  const problems: string[] = [];
  const resolved: DroppedReviewIssue[] = [];

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
    const originals = findOriginals(issue, reviewResults);
    const undroppableOriginal = originals.find(isUndroppable);
    if (undroppableOriginal) {
      problems.push(
        `${issue.id}: review_submit 원본이 ${undroppableOriginal.severity}/${undroppableOriginal.category}라 뺄 수 없다`,
      );
      continue;
    }
    // 금지 판단이 끝난 뒤에 채운다. 채우는 값은 위에서 이미 걸러진 원본에서만 온다
    const filled = fillDropped(issue, originals);
    if (typeof filled === 'string') {
      problems.push(filled);
      continue;
    }
    if (!hasContent(issue.dropReason) || !hasContent(issue.dropEvidence)) {
      problems.push(`${issue.id}: dropReason과 dropEvidence가 둘 다 있어야 뺄 수 있다`);
      continue;
    }
    if (mergedIds.has(norm(issue.id))) {
      problems.push(`${issue.id}: mergedIssues에도 같은 id가 있다. 어느 한쪽에만 둔다`);
      continue;
    }
    resolved.push(filled);
  }

  if (problems.length === 0) return ok(resolved);
  return err(
    new Error(
      [
        'droppedIssues를 받을 수 없다. 뺄 수 없는 이슈는 mergedIssues로 되돌려 keep이나 revise로 다시 부르고 나머지는 줄마다 적힌 대로 고친다.',
        ...problems.map((p) => `- ${p}`),
      ].join('\n'),
    ),
  );
}

/** droppedIssues가 우회로로 쓰이지 않았는지 본다. 문제가 없으면 null이다 */
export function checkDroppedIssues(
  consensus: Pick<ReviewConsensusInput, 'mergedIssues' | 'droppedIssues'>,
  reviewResults: ReviewResult[],
): string | null {
  const result = resolveDroppedIssues(consensus, reviewResults);
  return result.ok ? null : result.error.message;
}
