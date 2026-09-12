/** 코멘트 하나. 삭제된 계정이면 author 가 null 로 온다 */
interface Comment {
  author: { login: string } | null;
}

/**
 * GraphQL `reviewThreads` 가 돌려주는 스레드에서 판정에 쓰는 부분만.
 *
 * 개설자와 마지막 코멘트를 별칭으로 따로 받는다. 코멘트를 한 덩어리로 받으면 긴
 * 스레드에서 잘려, 마지막이라고 읽은 게 실제 마지막이 아니게 된다 — 그 값이
 * "작성자가 답했는지"를 정하므로 판정이 양방향으로 뒤집힌다.
 */
export interface ReviewThread {
  isResolved: boolean;
  isOutdated: boolean;
  opener: { nodes: Comment[] };
  latest: { nodes: Comment[] };
}

/**
 * 내가 열어둔 스레드 중 작성자가 아직 손대지 않은 수.
 *
 * 이 수가 0이어야 승인이 나간다. 그래서 셀 수 없는 상태는 0이 아니라 예외로 답한다 —
 * 셸 스크립트로 적던 때는 로그인이 빈 문자열이면 어떤 스레드와도 안 맞아 0과 종료
 * 코드 0이 함께 나왔다. 그 값이 승인 게이트를 그대로 통과했다.
 *
 * 대응으로 세는 건 셋이다. 스레드가 닫혔거나, 코드가 바뀌어 outdated 가 됐거나,
 * 마지막 코멘트가 내 것이 아니거나 — 마지막은 작성자가 답을 달았다는 뜻이다.
 */
export function countPending(threads: readonly ReviewThread[], me: string): number {
  const login = me.trim().toLowerCase();
  if (!login) {
    throw new Error('내 로그인이 비었다 — 집계하지 않는다');
  }
  // GitHub 로그인은 대소문자를 안 가린다. 그대로 비교하면 캐시에 적힌 철자가 API 응답과
  // 한 글자만 달라도 어떤 스레드와도 안 맞아 미대응이 0이 되고 승인이 열린다
  return threads.filter((t) => isPending(t, login)).length;
}

/** me 는 소문자로 정규화된 로그인이다 */
function isPending(thread: ReviewThread, me: string): boolean {
  if (thread.isResolved) return false;
  if (thread.isOutdated) return false;

  const opener = thread.opener.nodes[0]?.author?.login?.toLowerCase();
  // 내가 안 연 스레드는 이 루프가 판정할 자리가 아니다 — 그건 그 사람이 닫는다
  if (opener !== me) return false;

  const last = thread.latest.nodes[0]?.author?.login?.toLowerCase();
  return last === me;
}
