import type {
  ReviewConsensusResult,
  ReviewSession,
  ReviewVerifierAtConsensus,
  ReviewVerifierRecord,
  ReviewVerifierVerdict,
} from '../core/types.js';
import { type Result, ok, err } from '../core/result.js';
import { norm } from './verification.js';

const VERDICTS = new Set(['keep', 'revise', 'drop']);

/**
 * 검증기 응답을 읽어 기록으로 만든다.
 *
 * 응답은 서브에이전트가 쓴 글이라 JSON 앞뒤에 말이 붙거나 코드펜스에 싸여 올 수 있다.
 * 통째로, 펜스 안, 첫 `{`부터 마지막 `}`까지 순서로 읽어 보고 처음 읽힌 것을 쓴다.
 * 하나도 못 읽으면 서브에이전트 실패로 본다. 원문은 남기지 않는다 — 판정과 개수만 쓰면
 * 되고 응답 문자열이 로그나 경로로 흘러갈 자리를 만들 이유가 없다.
 *
 * 판정은 프로토타입 없는 객체에 id를 norm으로 맞춰 담는다. 응답의 issueId가 `__proto__`여도
 * 판정으로 남고 `constructor` 같은 id를 찾을 때 상속된 값이 걸리지 않는다.
 */
export function parseVerifierOutput(raw: string, submitCount: number): ReviewVerifierRecord {
  const list = readVerificationList(raw.trim());
  if (!list) return { status: 'failed', failure: 'unparseable', submitCount, verdicts: {} };

  const verdicts: Record<string, ReviewVerifierVerdict> = Object.create(null);
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { issueId, verdict, evidence } = entry as Record<string, unknown>;
    if (typeof issueId !== 'string' || issueId.trim() === '') continue;
    if (typeof verdict !== 'string') continue;
    const normalized = verdict.trim().toLowerCase();
    if (!VERDICTS.has(normalized)) continue;
    verdicts[norm(issueId)] = {
      verdict: normalized as ReviewVerifierVerdict['verdict'],
      hasEvidence: typeof evidence === 'string' && evidence.trim() !== '',
    };
  }

  if (Object.keys(verdicts).length === 0) {
    return { status: 'failed', failure: 'no_verifications', submitCount, verdicts: {} };
  }
  return { status: 'ran', submitCount, verdicts };
}

function readVerificationList(text: string): unknown[] | null {
  const candidates = [text];
  for (const match of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) candidates.push(match[1]!);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'object' && parsed !== null) {
      const list = (parsed as Record<string, unknown>).verifications;
      if (Array.isArray(list)) return list;
    }
  }
  return null;
}

/**
 * 이슈 id로 판정을 찾는다. 세션을 JSON에서 되살리면 프로토타입이 붙은 객체가 되므로
 * 저장할 때와 상관없이 자기 키만 본다.
 */
function verdictOf(
  verdicts: Record<string, ReviewVerifierVerdict>,
  id: string,
): ReviewVerifierVerdict | undefined {
  const key = norm(id);
  return Object.hasOwn(verdicts, key) ? verdicts[key] : undefined;
}

/** 합의를 받는 지금 검증 기록이 어떤 상태인지 */
export function verifierAtConsensus(session: ReviewSession): ReviewVerifierAtConsensus {
  const record = session.verifier;
  if (!record) return { status: 'missing' };
  if (record.submitCount !== session.reviewResults.length) return { status: 'stale', record };
  return { status: record.status, record };
}

/**
 * 합의가 검증 기록과 어긋나는지 본다. 어긋나면 문제를 줄마다 적어 돌려준다.
 *
 * 기록이 없거나 낡았으면 여기서는 보지 않는다. GitHub에 올리는 리뷰와 PR 없는 리뷰도
 * 이 합의를 거치는데 거기까지 막으면 그 경로가 통째로 멈춘다. 게시를 막는 자리는
 * review_publish다.
 */
export function checkConsensusAgainstVerifier(
  at: ReviewVerifierAtConsensus,
  consensus: Pick<ReviewConsensusResult, 'mergedIssues' | 'droppedIssues'>,
): string | null {
  const dropped = consensus.droppedIssues ?? [];

  if (at.status === 'failed') {
    const judged = consensus.mergedIssues.filter((i) => i.verification).map((i) => i.id);
    if (dropped.length === 0 && judged.length === 0) return null;
    const ids = [...dropped.map((i) => i.id), ...judged].join(', ');
    return (
      `검증기가 돌려준 응답에서 판정을 못 읽었는데 판정이 붙은 이슈가 있다: ${ids}. ` +
      '검증기가 실패했으면 droppedIssues와 verification 없이 초안 그대로 보낸다. ' +
      '검증기를 다시 돌렸으면 그 응답을 review_verify로 먼저 넘긴다.'
    );
  }
  if (at.status !== 'ran') return null;

  const { verdicts } = at.record;
  const ids = [...consensus.mergedIssues, ...dropped].map((i) => i.id);
  if (ids.length > 0 && !ids.some((id) => verdictOf(verdicts, id))) {
    return (
      '검증기가 돌려준 응답의 issueId가 이번 이슈 id와 하나도 안 맞는다. ' +
      '검증기에 넘긴 초안의 id를 그대로 쓰거나 지금 초안으로 검증을 다시 돌린다.'
    );
  }

  const problems: string[] = [];
  for (const issue of dropped) {
    const judged = verdictOf(verdicts, issue.id);
    if (!judged) {
      problems.push(`- ${issue.id}: 검증기 응답에 없는 이슈라 뺄 수 없다`);
    } else if (judged.verdict !== 'drop') {
      problems.push(
        `- ${issue.id}: 검증기 응답에서 ${judged.verdict}였다. drop으로 낸 이슈만 뺀다`,
      );
    } else if (!judged.hasEvidence) {
      problems.push(`- ${issue.id}: 검증기가 근거 없이 drop을 냈다. keep으로 mergedIssues에 둔다`);
    }
  }
  if (problems.length === 0) return null;
  return [
    'droppedIssues가 검증기 응답과 어긋난다. 해당 이슈를 mergedIssues로 되돌려 다시 부른다.',
    ...problems,
  ].join('\n');
}

export type PublishVerifierStatus = 'ran' | 'failed' | 'no_drafts';

/**
 * 게시 전에 3.7단계 기록을 확인한다.
 *
 * 건너뛰어도 되는 경우는 엔진이 세션으로 가른다. 이슈 초안이 하나도 없었거나(review_submit
 * 이슈도 합의 이슈도 없다) 검증기 응답을 못 읽었을 때다. 초안 수를 합의만으로 세면 이슈를
 * 전부 빼고 보낸 합의가 초안 0개로 통과하므로 review_submit 원본도 함께 센다. 부르는 쪽이
 * 사유를 적어 보낼 자리는 두지 않는다.
 */
export function checkVerifierBeforePublish(
  session: ReviewSession,
  consensus: ReviewConsensusResult,
): Result<PublishVerifierStatus> {
  const submitted = session.reviewResults.reduce((n, r) => n + r.issues.length, 0);
  const draftCount = Math.max(
    submitted,
    consensus.mergedIssues.length + (consensus.droppedIssues?.length ?? 0),
  );
  if (draftCount === 0) return ok('no_drafts');

  const at = session.verifierAtConsensus ?? { status: 'missing' as const };
  if (at.status === 'ran' || at.status === 'failed') return ok(at.status);

  const latest = session.verifier;
  const cameAfterConsensus =
    latest !== undefined &&
    (at.status === 'missing' || latest !== at.record) &&
    latest.submitCount === session.reviewResults.length;
  if (cameAfterConsensus) {
    return err(
      new Error(
        'review_verify가 review_consensus 뒤에 들어와 지금 합의에는 제안 검증이 반영되지 않았다. ' +
          '검증 결과를 반영해 review_consensus를 다시 부른 뒤 게시한다.',
      ),
    );
  }

  if (at.status === 'stale') {
    const added = session.reviewResults.length - at.record.submitCount;
    return err(
      new Error(
        `제안 검증 뒤에 review_submit이 ${added}개 더 들어와 그 기록으로는 게시하지 않는다. ` +
          '늘어난 초안까지 다시 검증해 review_verify로 넘기고 review_consensus를 다시 부른다.',
      ),
    );
  }

  return err(
    new Error(
      `제안 검증(3.7단계) 기록이 없어 게시하지 않는다. 이슈 ${draftCount}개를 suggestion-verifier로 ` +
        '검증하고 그 응답을 review_verify로 넘긴 뒤 review_consensus를 다시 부른다. ' +
        '서브에이전트가 실패했으면 돌아온 응답을 그대로 넘긴다. 응답이 비었으면 검증기를 한 번 다시 띄운다.',
    ),
  );
}
