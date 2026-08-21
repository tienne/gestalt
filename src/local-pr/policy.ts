import type { ReviewIssue, ContinuityVerdict } from '../core/types.js';
import type { Actor, PullRequest, ReviewVerdict } from './types.js';

/**
 * 로컬 PR의 판단 규칙.
 *
 * 표면이 셋(CLI, MCP, 웹)이고 이 규칙을 산문으로 옮겨 적는 스킬 문서가 셋 더 있다.
 * 규칙을 표면마다 다시 구현하면 하나가 반드시 뒤처진다 — 실제로 미해결 수를 스레드로
 * 고친 뒤에도 웹 UI만 옛 계산으로 남아 같은 PR이 CLI에서 2, 웹에서 4로 보였다.
 * 표면은 여기서 값을 가져다 쓰고 스스로 세지 않는다.
 */

/** `--force`로 지울 때 워크트리 전용 커밋을 붙잡아 둘 ref의 뿌리 */
export const CHECKOUT_REF_ROOT = 'refs/gestalt/pr-checkout';

/**
 * 아직 안 닫힌 스레드 수.
 *
 * 코멘트가 아니라 스레드를 센다. 코멘트를 세면 답글이 달릴수록 수가 늘어난다.
 * 지적 두 건에 답을 달았더니 "미해결 4"가 되는 일이 실제로 났다. 주고받을수록
 * 나빠 보이는 신호는 티키타카를 말린다.
 */
export function unresolvedCount(pr: PullRequest): number {
  const openThreads = new Set<string>();
  for (const comment of pr.comments) {
    if (!comment.resolved) openThreads.add(comment.threadId);
  }
  return openThreads.size;
}

/**
 * 누가 했는지.
 *
 * `--author`나 MCP 인자로 준 값이 먼저다. 없으면 `GESTALT_ACTOR` 환경변수를 본다.
 * 그것도 없으면 fallback이다. CLI와 MCP, 리뷰 게시가 각자 이 규칙을 적어두면
 * 기본값을 바꿀 때 한 곳이 남는다.
 */
export function resolveActor(explicit?: string, fallback: Actor = 'human:local'): Actor {
  return explicit ?? process.env['GESTALT_ACTOR'] ?? fallback;
}

/**
 * 리뷰 합의가 통과인가.
 *
 * 결함 심급은 critical과 high가 하나도 없어야 통과다. 정합 심급은 판정이 있고
 * `coherent: false`면 결함이 없어도 막는다.
 *
 * 리뷰 파이프라인의 `approved`와 PR에 남길 판정이 이 함수 하나에서 나온다. 두 곳이
 * 따로 세면 파이프라인은 통과인데 PR은 request_changes인 상태가 생긴다. 그때 어느
 * 쪽을 믿어야 하는지 알 방법이 없다.
 */
export function isConsensusApproved(
  issues: ReviewIssue[],
  continuityVerdict?: ContinuityVerdict,
): boolean {
  const hasDefect = issues.some((i) => i.severity === 'critical' || i.severity === 'high');
  const continuityBlocks = continuityVerdict ? !continuityVerdict.coherent : false;
  return !hasDefect && !continuityBlocks;
}

/** 합의를 PR 판정으로 옮긴다. 경계는 isConsensusApproved 하나가 정한다 */
export function consensusVerdict(
  issues: ReviewIssue[],
  continuityVerdict?: ContinuityVerdict,
): Extract<ReviewVerdict, 'approve' | 'request_changes'> {
  return isConsensusApproved(issues, continuityVerdict) ? 'approve' : 'request_changes';
}
