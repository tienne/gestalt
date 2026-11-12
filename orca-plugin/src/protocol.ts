// 패널과 워커가 함께 읽는 약속. 값의 꼴은 `gestalt conductor status --all --json` 출력을 따른다.

/** `src/conductor/types.ts`의 ORDER_STATUSES와 같은 순서. 레포 테스트가 둘을 맞춰 본다 */
export const ORDER_STATUSES = [
  'queued',
  'running',
  'waiting-gate',
  'merged',
  'done',
  'failed',
  'escalated',
  'cancelled'
] as const

/** tick이 더 손대지 않는 주문. 상태 표시줄의 주문 수에서 뺀다 */
export const TERMINAL_ORDER_STATUSES: readonly string[] = ['done', 'failed', 'cancelled']

export type Bypass = { need: string; action: string; at: string }

export type OrderView = {
  id: string
  status: string
  scope: string
  repo: string
  title: string
  updatedAt?: string
  worker?: string
  workerKind?: string
  pr?: string
  issue?: string
  bypasses: Bypass[]
  /** 워커가 만든 하위 주문이면 그 워커의 주문 */
  parentOrderId?: string
  /** 오르카 워커가 하위 워크트리로 뜬 자리. 절대 경로다 */
  parentWorktree?: string
  /** 부모 워크트리를 오르카에서 찾았을 때 그 브랜치 */
  parentBranch?: string
  baseBranch?: string
  /** 아래 셋은 워커 워크트리를 오르카에서 찾았을 때만 있다 */
  workspaceId?: string
  worktreePath?: string
  branch?: string
}

export type GateView = {
  id: string
  type: string
  orderId: string | null
  reason: string
  openedAt?: string
}

export type ConductorView = {
  /** ok: 읽었다, missing: 저장소에 events.jsonl이 없다, error: CLI가 실패했다 */
  state: 'ok' | 'missing' | 'error'
  stateDir: string | null
  error?: string
  lastTickAt: string | null
  orders: OrderView[]
  gates: GateView[]
  unassignedBypasses: Bypass[]
  /** 컨덕터 레포(owner/name)마다 찾은 오르카 프로젝트 이름. 못 찾은 레포는 빠진다 */
  projects?: Record<string, string>
  refreshedAt: number
}

export type GateDecision = 'approve' | 'reject'

export type GateResolveInput = { gateId: string; decision: GateDecision; answer?: string }

export type GateResolveResult = {
  ok: boolean
  gateId: string
  decision: GateDecision
  /** 컨덕터 세션이 처리할 일. 플러그인은 실행하지 않고 보여 주기만 한다 */
  hostActions: unknown[]
  errors: string[]
  error?: string
}

export type OrderRemoveResult = {
  ok: boolean
  removed: string[]
  /** 컨덕터가 거절한 주문과 이유. 그새 다시 돌기 시작했거나 게이트가 열린 경우다 */
  skipped: { id: string; reason: string }[]
  error?: string
}

declare module 'orca' {
  interface PluginRequests {
    /** 워커가 마지막으로 읽은 상태. 아직 없으면 지금 읽는다 */
    'conductor.status': { output: ConductorView }
    /** 지금 다시 읽는다 */
    'conductor.refresh': { output: ConductorView }
    /** `gestalt conductor gate resolve`를 부른다. 패널이 확인 단계를 거친 뒤에만 보낸다 */
    'gate.resolve': { input: GateResolveInput; output: GateResolveResult }
    /** `gestalt conductor order remove`로 끝난 주문을 지운다. 패널이 확인 단계를 거친 뒤에만 보낸다 */
    'order.remove': { input: { orderIds: string[] }; output: OrderRemoveResult }
    /** 주문을 맡은 워커의 오르카 워크트리를 연다 */
    'worker.open': { input: { orderId: string }; output: { opened: boolean; error?: string } }
  }
  interface PluginPanelEvents {
    'conductor.changed': ConductorView
  }
}
