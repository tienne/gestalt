/** GraphQL `reviewThreads` 가 돌려주는 스레드에서 판정에 쓰는 부분만. */
export interface ReviewThread {
  isResolved: boolean;
  isOutdated: boolean;
  comments: { nodes: Array<{ author: { login: string } | null }> };
}

/**
 * 내가 열어둔 스레드 중 작성자가 아직 손대지 않은 수.
 *
 * 이 수가 0 이어야 승인이 나간다. 그래서 셀 수 없는 상태는 0 이 아니라 예외로 답한다 —
 * 셸 스크립트로 적던 때는 로그인이 빈 문자열이면 어떤 스레드와도 안 맞아 0 과 종료
 * 코드 0 이 함께 나왔다. 그 값이 승인 게이트를 그대로 통과했다.
 *
 * 대응으로 세는 건 셋이다. 스레드가 닫혔거나, 코드가 바뀌어 outdated 가 됐거나,
 * 마지막 코멘트가 내 것이 아니거나 — 마지막은 작성자가 답을 달았다는 뜻이다.
 */
export function countPending(threads: readonly ReviewThread[], me: string): number {
  if (!me.trim()) {
    throw new Error('내 로그인이 비었다 — 집계하지 않는다');
  }
  return threads.filter((t) => isPending(t, me)).length;
}

function isPending(thread: ReviewThread, me: string): boolean {
  if (thread.isResolved) return false;
  if (thread.isOutdated) return false;

  const nodes = thread.comments.nodes;
  const opener = nodes[0]?.author?.login;
  // 내가 안 연 스레드는 이 루프가 판정할 자리가 아니다 — 그건 그 사람이 닫는다
  if (opener !== me) return false;

  const last = nodes[nodes.length - 1]?.author?.login;
  return last === me;
}
