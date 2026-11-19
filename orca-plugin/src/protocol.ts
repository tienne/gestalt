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
  'cancelled',
  'human-owned',
  'parked'
] as const

/** tick이 더 손대지 않는 주문. 상태 표시줄의 주문 수에서 뺀다 */
export const TERMINAL_ORDER_STATUSES: readonly string[] = ['done', 'failed', 'cancelled', 'parked']

export type Bypass = { need: string; action: string; at: string }

/** 주문의 마지막 체크포인트. 워커가 어느 스킬의 어느 단계에 있는지 */
export type CheckpointView = {
  skill: string
  phase?: string
  round?: number
  next: string
  completedSkills: string[]
  savedAt: string
}

/** 워커가 status waiting으로 알린 대기 */
export type WaitingView = { reason: string; since: string; until?: string }

/** 컨덕터 칸에 쓰는 값. 컨덕터가 안 주는 칸은 비어 있고 화면도 그 칸을 뺀다 */
export type ConductorInfo = {
  pollIntervalSec?: number
  maxWorkers?: number
  activeWorkers?: number
  queuedOrders?: number
  prWatchRepos?: string[]
  disconnectedWorkers?: number
  compactions?: number
}

/** CLI가 이벤트 로그에서 고른 한 줄. summary에 바깥에서 온 글이 섞여 있으니 텍스트로만 그린다 */
export type EventView = { at: string; type: string; orderId?: string; summary: string; until?: string }

export type OrderView = {
  id: string
  status: string
  scope: string
  repo: string
  title: string
  updatedAt?: string
  worker?: string
  workerKind?: string
  workerStatus?: string
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
  /** 아래는 컨덕터 터미널 화면이 쓴다. 옛 CLI에는 없다 */
  skillChain?: string[]
  checkpoint?: CheckpointView
  waiting?: WaitingView
  account?: string
  rateLimitedAt?: string
  rateLimitResetsAt?: string
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
  /** 워커가 붙은 주문에 workerKind가 없다. 워크트리를 못 이어 주문을 눌러도 워커로 못 가는 옛 CLI다 */
  outdatedCli?: boolean
  /** 옛 CLI에는 없다 */
  conductor?: ConductorInfo
  recentEvents?: EventView[]
  refreshedAt: number
}

export type GateDecision = 'approve' | 'reject'

export type GateResolveInput = { gateId: string; decision: GateDecision; answer?: string }

export type GateResolveResult = {
  ok: boolean
  gateId: string
  decision: GateDecision
  /** 컨덕터 세션이 처리할 일. 플러그인은 실행하지 않고 보여 주기만 한다. 전달을 tick에 넘기지 못하는 옛 CLI에서만 찬다 */
  hostActions: unknown[]
  /** 이 워커에는 결정을 바로 못 전해서 컨덕터 세션의 다음 tick에 넘겼다 */
  deferred?: boolean
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

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

/**
 * 데스크톱 터미널 화면에서 카드를 펼치면 워커가 오르카에서 읽어 오는 것.
 * 터미널 출력에는 토큰이나 경로가 섞일 수 있어서 인증 없는 폰 페이지에는 싣지 않는다
 */
export type WorkerLive = {
  /** 주문의 워크트리를 오르카에서 찾았는지 */
  found: boolean
  agent?: { kind: string | null; title: string | null; state: AgentState; since: number; task: string | null }
  terminalId?: string
  /** 워커 터미널의 마지막 줄들. 오래된 줄부터 */
  lines?: string[]
  /** 일부를 못 읽었으면 그 이유 */
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
    /** 주문을 맡은 워커의 터미널로 간다. 터미널을 못 찾으면 워크트리만 연다 */
    'worker.open': { input: { orderId: string }; output: { opened: boolean; error?: string } }
    /** 주문을 맡은 워커의 에이전트 상태와 터미널 마지막 줄을 읽는다 */
    'worker.detail': { input: { orderId: string }; output: WorkerLive }
  }
  interface PluginPanelEvents {
    'conductor.changed': ConductorView
  }
}
