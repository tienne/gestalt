// CLI 출력을 패널과 상태 표시줄이 쓰는 꼴로 바꾼다. Node와 오르카 호스트를 모르는 순수 함수만 둔다.
import {
  TERMINAL_ORDER_STATUSES,
  type Bypass,
  type ConductorView,
  type GateView,
  type OrderView
} from './protocol'

/** `gestalt conductor status --json`의 주문 한 줄. 옛 CLI에는 뒤쪽 필드가 없다 */
export type RawOrder = {
  id: string
  status: string
  scope: string
  repo: string
  title: string
  updatedAt?: string
  worker?: string
  workerKind?: string
  workerStatus?: string
  workerHandle?: string
  worktreeName?: string
  pr?: string
  issue?: string
  parentOrderId?: string
  parentWorktree?: string
  baseBranch?: string
  bypasses: Bypass[]
}

export type RawStatus = {
  stateDir?: string
  lastTickAt: string | null
  orders: RawOrder[]
  unassignedBypasses: Bypass[]
  gates: GateView[]
}

export type Workspace = {
  id: string
  kind: string
  path: string
  branch?: string | null
  project?: string | null
}

/** CLI stdout에서 JSON 하나를 꺼낸다. 앞뒤에 다른 줄이 섞여도 바깥 중괄호 사이만 읽는다 */
export function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim()
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('CLI 출력에서 JSON을 못 찾았어요')
    return JSON.parse(text.slice(start, end + 1))
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function bypasses(v: unknown): Bypass[] {
  if (!Array.isArray(v)) return []
  return v.filter(isRecord).map((b) => ({
    need: str(b['need']) ?? '',
    action: str(b['action']) ?? '',
    at: str(b['at']) ?? ''
  }))
}

/** 꼴이 틀린 필드는 버리고 읽는다. 주문 id나 게이트 id가 없는 줄만 뺀다 */
export function parseStatus(value: unknown): RawStatus {
  if (!isRecord(value) || !Array.isArray(value['orders']) || !Array.isArray(value['gates']))
    throw new Error('status JSON 꼴이 달라요. gestalt 버전을 확인해 주세요')
  const orders: RawOrder[] = []
  for (const o of value['orders']) {
    if (!isRecord(o) || !str(o['id'])) continue
    const order: RawOrder = {
      id: str(o['id'])!,
      status: str(o['status']) ?? 'unknown',
      scope: str(o['scope']) ?? '',
      repo: str(o['repo']) ?? '',
      title: str(o['title']) ?? '',
      bypasses: bypasses(o['bypasses'])
    }
    for (const key of [
      'updatedAt',
      'worker',
      'workerKind',
      'workerStatus',
      'workerHandle',
      'worktreeName',
      'pr',
      'issue',
      'parentOrderId',
      'parentWorktree',
      'baseBranch'
    ] as const) {
      const v = str(o[key])
      if (v !== undefined) order[key] = v
    }
    orders.push(order)
  }
  const gates: GateView[] = []
  for (const g of value['gates']) {
    if (!isRecord(g) || !str(g['id'])) continue
    const gate: GateView = {
      id: str(g['id'])!,
      type: str(g['type']) ?? 'unknown',
      orderId: str(g['orderId']) ?? null,
      reason: str(g['reason']) ?? ''
    }
    const openedAt = str(g['openedAt'])
    if (openedAt) gate.openedAt = openedAt
    gates.push(gate)
  }
  const stateDir = str(value['stateDir'])
  return {
    ...(stateDir ? { stateDir } : {}),
    lastTickAt: str(value['lastTickAt']) ?? null,
    orders,
    unassignedBypasses: bypasses(value['unassignedBypasses']),
    gates
  }
}

export function samePath(a: string, b: string): boolean {
  const trim = (p: string) => p.replace(/[\\/]+$/, '')
  return trim(a) === trim(b)
}

export const lastSegment = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

/**
 * 주문을 맡은 워커의 오르카 워크스페이스를 찾는다. 서브에이전트는 워크트리가 없어 못 찾는다.
 * 오르카 워커는 컨덕터가 붙인 `<주문 id>-<회차>`가 디렉토리 이름이고 git 워크트리 워커는 handle이 경로다.
 */
export function findWorkspace(order: RawOrder, workspaces: readonly Workspace[]): Workspace | undefined {
  if (order.workerKind === 'orca-worktree' && order.worktreeName) {
    const name = order.worktreeName
    return workspaces.find((w) => w.kind === 'worktree' && lastSegment(w.path) === name)
  }
  if (order.workerKind === 'git-worktree' && order.workerHandle) {
    const handle = order.workerHandle
    return workspaces.find((w) => samePath(w.path, handle))
  }
  return undefined
}

/**
 * 컨덕터 레포마다 오르카 프로젝트 이름을 찾는다. 컨덕터는 레포를 owner/name으로만 알고 오르카는 사람이 붙인 이름으로 부른다.
 * 주문을 맡은 워크트리가 있으면 그 워크트리의 프로젝트를 쓰고, 없으면 디렉토리 이름이 레포 이름과 같은 워크스페이스를 본다.
 * 후보가 둘 이상 갈리면 틀린 이름을 붙이느니 비워 둔다.
 */
export function projectsOf(orders: readonly RawOrder[], workspaces: readonly Workspace[]): Record<string, string> {
  const fromOrders = new Map<string, Set<string>>()
  for (const o of orders) {
    const project = findWorkspace(o, workspaces)?.project?.trim()
    if (!o.repo || !project) continue
    const set = fromOrders.get(o.repo) ?? new Set<string>()
    set.add(project)
    fromOrders.set(o.repo, set)
  }
  const out: Record<string, string> = {}
  for (const repo of new Set(orders.map((o) => o.repo).filter(Boolean))) {
    let found = fromOrders.get(repo)
    if (!found) {
      const name = lastSegment(repo).toLowerCase()
      found = new Set(
        workspaces
          .filter((w) => w.project?.trim() && lastSegment(w.path).toLowerCase() === name)
          .map((w) => w.project!.trim())
      )
    }
    if (found.size === 1) out[repo] = [...found][0]!
  }
  return out
}

export function toView(
  raw: RawStatus,
  stateDir: string | null,
  workspaces: readonly Workspace[],
  now: number
): ConductorView {
  return {
    state: 'ok',
    stateDir,
    lastTickAt: raw.lastTickAt,
    orders: raw.orders.map((o): OrderView => {
      const ws = findWorkspace(o, workspaces)
      const parent = o.parentWorktree
        ? workspaces.find((w) => samePath(w.path, o.parentWorktree!))
        : undefined
      return {
        id: o.id,
        status: o.status,
        scope: o.scope,
        repo: o.repo,
        title: o.title,
        bypasses: o.bypasses,
        ...(o.updatedAt ? { updatedAt: o.updatedAt } : {}),
        ...(o.worker ? { worker: o.worker } : {}),
        ...(o.workerKind ? { workerKind: o.workerKind } : {}),
        ...(o.pr ? { pr: o.pr } : {}),
        ...(o.issue ? { issue: o.issue } : {}),
        ...(o.parentOrderId ? { parentOrderId: o.parentOrderId } : {}),
        ...(o.parentWorktree ? { parentWorktree: o.parentWorktree } : {}),
        ...(parent?.branch ? { parentBranch: parent.branch } : {}),
        ...(o.baseBranch ? { baseBranch: o.baseBranch } : {}),
        ...(ws ? { workspaceId: ws.id, worktreePath: ws.path } : {}),
        ...(ws?.branch ? { branch: ws.branch } : {})
      }
    }),
    gates: raw.gates,
    unassignedBypasses: raw.unassignedBypasses,
    projects: projectsOf(raw.orders, workspaces),
    refreshedAt: now
  }
}

export function emptyView(
  state: 'missing' | 'error',
  stateDir: string | null,
  now: number,
  error?: string
): ConductorView {
  return {
    state,
    stateDir,
    ...(error ? { error } : {}),
    lastTickAt: null,
    orders: [],
    gates: [],
    unassignedBypasses: [],
    refreshedAt: now
  }
}

export type StatusBarState = {
  text: string
  tone: 'neutral' | 'warning' | 'danger'
  tooltip: string
}

export function activeOrderCount(view: ConductorView): number {
  return view.orders.filter((o) => !TERMINAL_ORDER_STATUSES.includes(o.status)).length
}

export function statusBarOf(view: ConductorView): StatusBarState {
  if (view.state === 'missing')
    return {
      text: '컨덕터 저장소 없음',
      tone: 'danger',
      tooltip: `${view.stateDir ?? '컨덕터 저장소'}에 events.jsonl이 없어요`
    }
  if (view.state === 'error')
    return { text: '컨덕터 오류', tone: 'danger', tooltip: view.error ?? 'CLI가 실패했어요' }
  const orders = activeOrderCount(view)
  const gates = view.gates.length
  return {
    text: `주문 ${orders} · 확인 대기 ${gates}`,
    tone: gates > 0 ? 'warning' : 'neutral',
    tooltip: `진행 중인 주문 ${orders}개, 사람 확인을 기다리는 게이트 ${gates}개`
  }
}

/** 처음 보는 게이트만 고른다. 알린 목록은 지금 열린 게이트로 줄여 저장소가 끝없이 자라지 않게 한다 */
export function diffGates(
  gates: readonly GateView[],
  notified: readonly string[]
): { fresh: GateView[]; keep: string[] } {
  const seen = new Set(notified)
  return {
    fresh: gates.filter((g) => !seen.has(g.id)),
    keep: gates.map((g) => g.id)
  }
}

/** CLI 인자로 넘기는 값이라 옵션처럼 읽히는 꼴을 막는다 */
export function isSafeId(v: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v)
}
