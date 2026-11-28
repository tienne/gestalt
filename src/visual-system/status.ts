/** 상태 역할. info는 진행 중이라는 뜻이고 강조색과 다르다 */
export type StatusRole = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/**
 * 컨덕터 주문 상태별 상태 역할. 결과 웹 배지와 Orca 패널, 보드, 모바일이 이 표를 같이 따른다.
 * 사람이 손대야 하는 상태는 warning, 끝까지 간 상태는 success, 멈추거나 거둔 상태는 neutral이다
 */
export const ORDER_STATUS_ROLE: Readonly<Record<string, StatusRole>> = {
  queued: 'neutral',
  running: 'info',
  'waiting-gate': 'warning',
  'awaiting-deploy': 'info',
  merged: 'success',
  done: 'success',
  failed: 'danger',
  escalated: 'warning',
  cancelled: 'neutral',
  'human-owned': 'info',
  parked: 'neutral',
};

/** Orca 컴포넌트와 상태줄이 받는 tone */
export type OrcaTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

// Orca tone에는 info가 없어서 진행 중 상태는 호스트의 accent로 그린다
export const orcaTone = (role: StatusRole): OrcaTone => (role === 'info' ? 'accent' : role);
