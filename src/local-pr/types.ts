/**
 * 로컬 PR 리뷰의 도메인 타입.
 *
 * 원격 GitHub PR은 사람에게 넘기는 자리다. 여기는 에이전트가 쪼갠 작업을 다른
 * 에이전트에게 리뷰받고 주고받는 자리다. 한 작업 단위가 PR 하나다.
 */

/** 이벤트 저장소에서 이 도메인을 가리키는 이름 */
export const PR_AGGREGATE = 'local-pr';

export type PrStatus = 'open' | 'changes_requested' | 'merged' | 'closed';

export type ReviewVerdict = 'approve' | 'request_changes' | 'comment';

/**
 * 누가 했는지.
 *
 * `claude-code:main`, `codex:worker-2`, `human:tienne` 같은 형태다. 에이전트끼리
 * 주고받는 자리라 작성자와 리뷰어가 갈려야 "누가 짚었고 누가 답했나"가 남는다.
 */
export type Actor = string;

export interface PullRequest {
  id: string;
  title: string;
  body: string;
  author: Actor;
  /** 갈라져 나온 지점. merge-base로 잡는다 */
  baseSha: string;
  /** 지금 리뷰 대상인 커밋. update로 옮겨간다 */
  headSha: string;
  /** head를 만들어낸 브랜치 이름. 지워질 수 있어 참고용이다 */
  headRef: string | null;
  baseRef: string | null;
  status: PrStatus;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  reviews: Review[];
  rounds: Round[];
}

export interface Comment {
  id: string;
  author: Actor;
  path: string;
  /** head 기준 라인. 파일 전반이면 null */
  line: number | null;
  body: string;
  /** 스레드의 첫 코멘트 id. 자기 자신이면 스레드의 뿌리다 */
  threadId: string;
  resolved: boolean;
  /** 이 코멘트가 달린 시점의 head. 이후 update로 라인이 밀렸는지 가린다 */
  headSha: string;
  createdAt: string;
  /**
   * 이 코멘트를 붙인 자동화가 남긴 자국.
   *
   * 사람이 읽을 내용이 아니라 본문 밖에 둔다. 본문에 실으면 CLI가 평문으로 찍고
   * 웹은 이스케이프해서 화면에 그대로 내보낸다 — 리뷰 코멘트마다 읽을 이유가 없는
   * 해시 줄이 붙는다. 손으로 단 코멘트에는 없다.
   */
  marker?: string;
}

export interface Review {
  id: string;
  reviewer: Actor;
  verdict: ReviewVerdict;
  summary: string;
  /** 이 판정이 속한 라운드 번호 */
  round: number;
  headSha: string;
  createdAt: string;
}

/**
 * 리뷰 한 바퀴.
 *
 * 리젝이 새 PR을 만들지 않고 같은 PR에서 라운드를 늘린다. 3차에서 다시 열린 코멘트가
 * 어느 라운드에서 났고 어디서 닫혔는지가 이 단위로 보인다.
 */
export interface Round {
  number: number;
  openedAt: string;
  /** 이 라운드를 닫은 판정. 아직 안 닫혔으면 null */
  verdict: ReviewVerdict | null;
  /** 이 라운드에서 새로 달린 코멘트 수 */
  commentCount: number;
}

// ─── 이벤트 페이로드 ─────────────────────────────────────────

export interface PrCreatedPayload {
  title: string;
  body: string;
  author: Actor;
  baseSha: string;
  headSha: string;
  headRef: string | null;
  baseRef: string | null;
}

export interface PrUpdatedPayload {
  headSha: string;
  headRef: string | null;
}

export interface CommentAddedPayload {
  commentId: string;
  author: Actor;
  path: string;
  line: number | null;
  body: string;
  threadId: string;
  headSha: string;
  /** 자동화가 남긴 자국. 사람이 단 코멘트에는 없다 */
  marker?: string;
}

export interface CommentResolvedPayload {
  commentId: string;
  by: Actor;
}

export interface ReviewSubmittedPayload {
  reviewId: string;
  reviewer: Actor;
  verdict: ReviewVerdict;
  summary: string;
  headSha: string;
}

export interface PrMergedPayload {
  by: Actor;
  mergeSha: string;
  /**
   * 머지한 시점의 미해결 스레드 수.
   *
   * 코멘트가 아니라 스레드를 센다 — 답글이 달릴수록 수가 늘면 주고받을수록 나빠
   * 보이는 신호가 된다. 계산은 `policy.unresolvedCount` 하나에서 나온다.
   *
   * 승인 게이트가 없어서 막지는 않는다. 대신 "스레드 세 개 남은 채 머지됨"이
   * 이력에 남아야 나중에 그 판단을 되짚을 수 있다.
   */
  unresolvedCount: number;
}

export interface PrClosedPayload {
  by: Actor;
  reason: string;
}

/**
 * 본문(과 제목)을 고친 기록.
 *
 * `PrUpdatedPayload`와 갈라 둔다. head를 옮기는 건 "고쳐서 다시 올렸다"는 뜻이라
 * 리뷰 판정을 되돌리지만 본문 오타를 고친 건 리뷰 대상 코드에 손을 안 댄 것이다.
 * 한 이벤트로 합치면 오타 수정이 `changes_requested`를 `open`으로 풀어 버린다.
 *
 * 안 고친 항목은 아예 안 싣는다. `undefined`가 "그대로 둬라"고, 빈 문자열이
 * "본문을 비워라"다 — 둘을 같은 값으로 두면 본문을 못 지운다.
 */
export interface PrEditedPayload {
  by: Actor;
  title?: string;
  body?: string;
}
