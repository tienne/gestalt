// 사이드 패널과 에디터 보드가 함께 쓰는 계산. 오르카 런타임을 모르는 순수 함수만 둔다.
import {
  ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
  type ConductorView,
  type GateView,
  type OrderView
} from './protocol'
import { parentOf } from './hierarchy'

export const ms = (iso?: string | null): number | null => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? null : t
}

export function ago(at: number | null, now = Date.now()): string {
  if (at === null) return ''
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return '방금'
  if (s < 3600) return `${Math.round(s / 60)}분 전`
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`
  return `${Math.round(s / 86400)}일 전`
}

export const STATUS_LABEL: Record<string, string> = {
  queued: '대기',
  running: '진행',
  'waiting-gate': '확인 대기',
  merged: '머지됨',
  done: '끝남',
  failed: '실패',
  escalated: '사람 결정 필요',
  cancelled: '취소'
}

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

export const STATUS_TONE: Record<string, Tone> = {
  queued: 'neutral',
  running: 'accent',
  'waiting-gate': 'warning',
  merged: 'success',
  done: 'neutral',
  failed: 'danger',
  escalated: 'warning',
  cancelled: 'neutral'
}

export const isTerminal = (status: string) => TERMINAL_ORDER_STATUSES.includes(status)

export function groupOrders(orders: readonly OrderView[]): [string, OrderView[]][] {
  const known: readonly string[] = ORDER_STATUSES
  const groups = new Map<string, OrderView[]>()
  for (const o of orders) groups.set(o.status, [...(groups.get(o.status) ?? []), o])
  // 모르는 status도 버리지 않고 뒤에 붙인다. CLI가 앞서 나가도 주문이 사라져 보이지 않게
  const order = [...known, ...[...groups.keys()].filter((s) => !known.includes(s))]
  return order.filter((s) => groups.has(s)).map((s) => [s, groups.get(s)!])
}

export function countByStatus(orders: readonly OrderView[]): [string, number][] {
  return groupOrders(orders).map(([status, list]) => [status, list.length])
}

export type RepoSummary = {
  repo: string
  /** 오르카 프로젝트 이름. 레포 이름과 같거나 못 찾았으면 null이라 화면에 한 번만 나온다 */
  project: string | null
  orders: OrderView[]
  gates: GateView[]
  active: number
  needsPerson: number
  /** 같은 레포 안에서 상위 주문이나 부모 워크트리 밑에 걸린 주문 수 */
  nested: number
  lastAt: number
}

export const NO_REPO = '(레포 없음)'

export function summarize(v: ConductorView): { repos: RepoSummary[]; orphanGates: GateView[] } {
  const byRepo = new Map<string, RepoSummary>()
  const repoOf = new Map<string, string>()
  for (const o of v.orders) {
    const repo = o.repo || NO_REPO
    repoOf.set(o.id, repo)
    const s = byRepo.get(repo) ?? {
      repo,
      project: projectLabel(repo, v.projects?.[repo]),
      orders: [],
      gates: [],
      active: 0,
      needsPerson: 0,
      nested: 0,
      lastAt: 0
    }
    s.orders.push(o)
    if (!isTerminal(o.status)) s.active++
    if (o.status === 'escalated') s.needsPerson++
    s.lastAt = Math.max(s.lastAt, ms(o.updatedAt) ?? 0)
    byRepo.set(repo, s)
  }
  for (const s of byRepo.values()) {
    const parents = parentOf(s.orders)
    s.nested = s.orders.filter((o) => parents.get(o.id) !== null).length
  }
  const orphanGates: GateView[] = []
  for (const g of v.gates) {
    const s = g.orderId ? byRepo.get(repoOf.get(g.orderId) ?? '') : undefined
    if (s) {
      s.gates.push(g)
      s.needsPerson++
    } else orphanGates.push(g)
  }
  // 사람 손이 필요한 레포, 굴러가는 레포, 최근에 움직인 레포 순으로 앞에 둔다
  const repos = [...byRepo.values()].sort(
    (a, b) =>
      b.needsPerson - a.needsPerson ||
      Number(b.active > 0) - Number(a.active > 0) ||
      b.lastAt - a.lastAt ||
      a.repo.localeCompare(b.repo)
  )
  return { repos, orphanGates }
}

function projectLabel(repo: string, project: string | undefined): string | null {
  const p = project?.trim()
  return p && p.toLowerCase() !== splitRepo(repo).name.toLowerCase() ? p : null
}

export function splitRepo(repo: string): { name: string; owner: string | null } {
  const i = repo.lastIndexOf('/')
  return i < 0 ? { name: repo, owner: null } : { name: repo.slice(i + 1), owner: repo.slice(0, i) }
}

const searchWords = (query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean)

const hits = (words: readonly string[], fields: readonly (string | null | undefined)[]) => {
  const hay = fields.filter(Boolean).join('\n').toLowerCase()
  return words.every((w) => hay.includes(w))
}

/**
 * 레포 상세에 남길 주문. 검색어를 공백으로 나눠 조각이 전부 레포 이름, 프로젝트, 그 주문의 제목이나 id 가운데 들어 있어야 남는다.
 * 레포 이름으로 맞았으면 주문이 전부 남고 주문 제목으로 맞았으면 그 주문만 남는다
 */
export function filterOrders(s: RepoSummary, query: string): OrderView[] {
  const words = searchWords(query)
  if (words.length === 0) return s.orders
  return s.orders.filter((o) => hits(words, [s.repo, s.project, o.title, o.id]))
}

/** 지도에 남길 레포. 레포 자체가 맞거나 맞는 주문이 하나라도 있으면 남는다. 상세에 들어가면 빈 목록이 안 나오게 filterOrders와 같은 기준을 쓴다 */
export function matchRepo(s: RepoSummary, query: string): boolean {
  const words = searchWords(query)
  return words.length === 0 || hits(words, [s.repo, s.project]) || filterOrders(s, query).length > 0
}
