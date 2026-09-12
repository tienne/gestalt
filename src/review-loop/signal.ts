/**
 * 대응 모니터링이 읽어낸 PR 상태. 조회 결과와 라운드 상태를 합쳐 만든 판정 입력이다 —
 * `changed` 는 조회한 head 를 지난 라운드에 리뷰한 sha 와 비교한 값이고 나머지 셋도
 * 원시 응답이 아니라 거기서 뽑아낸 것이다.
 */
export interface LoopState {
  /** PR 이 아직 열려 있는지. GraphQL `state` 가 OPEN 일 때만 참 */
  open: boolean;
  /** 내가 연 열린 스레드 중 미대응 수 */
  pending: number;
  /** head 가 지난 라운드에 리뷰한 커밋과 다른지 */
  changed: boolean;
  /** 리뷰 요청 목록에 내 로그인이 다시 들어왔는지 */
  rerequested: boolean;
}

export type LoopSignal = 'CLOSED' | 'REREVIEW_REQUESTED' | 'READY' | 'REPLIES_ONLY' | 'WAITING';

/**
 * 네 값에서 다음에 할 일을 정한다.
 *
 * 이 도출이 문서에 없던 자리다. 감시 모드를 미루며 폴링 스크립트를 지울 때 규칙이
 * 그 안에 있다가 함께 사라졌다. 재리뷰 판정 표는 만들어지지 않는 이름으로 분기하고
 * 있었다. 여기 두면 네 값의 곱집합이 전부 어느 한 쪽으로 간다.
 *
 * 순서가 규칙의 일부다. 닫힌 PR 은 나머지를 볼 것도 없다. 작성자가 명시적으로 다시
 * 봐달라고 눌렀으면 미대응이 남아 있어도 그 뜻을 따른다.
 */
export function deriveSignal(state: LoopState): LoopSignal {
  if (!state.open) return 'CLOSED';
  if (state.rerequested) return 'REREVIEW_REQUESTED';
  if (state.pending > 0) return 'WAITING';
  return state.changed ? 'READY' : 'REPLIES_ONLY';
}

/**
 * 신호마다 루프가 다음에 하는 일.
 *
 * 문서의 재리뷰 판정 표가 이 문자열을 그대로 싣는다. 테스트가 표 행과 이 값을 대조하므로
 * 한쪽만 고치면 게이트에서 걸린다.
 */
export const SIGNAL_ACTION: Record<LoopSignal, string> = {
  CLOSED: '루프를 끝낸다',
  REREVIEW_REQUESTED: '재리뷰한다 — 미대응이 남아 있어도 간다',
  READY: '재리뷰한다',
  REPLIES_ONLY: '재리뷰하지 않고 사람에게 넘긴다',
  WAITING: '지금 상태를 알리고 끝낸다. 다음에 부르면 이어서 돈다',
};
