// 컨덕터가 이미 남기는 관계(하위 주문, 부모 워크트리)만으로 주문 위계를 세운다. 의존성을 새로 추측하지 않는다.
import type { OrderView } from './protocol'

export type OrderNode = { kind: 'order'; key: string; order: OrderView; children: HierarchyNode[] }
export type WorktreeNode = {
  kind: 'worktree'
  key: string
  path: string
  label: string
  branch?: string
  children: HierarchyNode[]
}
export type HierarchyNode = OrderNode | WorktreeNode

const trim = (p: string) => p.replace(/[\\/]+$/, '')
const lastSegment = (p: string) => trim(p).split(/[\\/]/).pop() || p

export const orderKey = (id: string) => `order:${id}`
export const worktreeKey = (path: string) => `wt:${trim(path)}`

/**
 * 주문마다 부모 노드 key를 정한다. 뿌리면 null이다.
 * 하위 주문은 상위 주문 밑에 둔다. 부모 워크트리는 그 워크트리를 맡은 주문이 목록에 있으면 그 주문 밑에,
 * 없으면 워크트리 노드 밑에 둔다. 상위 주문이 목록에 없으면(다른 레포, 지난 주문) 부모 워크트리로 내려간다.
 */
export function parentOf(orders: readonly OrderView[]): Map<string, string | null> {
  const ids = new Set(orders.map((o) => o.id))
  const byPath = new Map<string, string>()
  for (const o of orders) if (o.worktreePath && !byPath.has(trim(o.worktreePath))) byPath.set(trim(o.worktreePath), o.id)

  const parent = new Map<string, string | null>()
  for (const o of orders) {
    let key: string | null = null
    if (o.parentOrderId && o.parentOrderId !== o.id && ids.has(o.parentOrderId)) key = orderKey(o.parentOrderId)
    else if (o.parentWorktree) {
      const owner = byPath.get(trim(o.parentWorktree))
      key = owner && owner !== o.id ? orderKey(owner) : worktreeKey(o.parentWorktree)
    }
    parent.set(o.id, key)
  }

  // 저장소가 꼬여 고리가 생겨도 무한히 돌지 않게 고리 안의 간선 하나만 끊는다.
  // 고리 밖에서 고리로 들어오는 주문은 그대로 두고, 배열 순서와 상관없이 고리에서 id가 가장 작은 주문을 뿌리로 올린다.
  for (const o of orders) {
    const path = [o.id]
    let cur = parent.get(o.id)
    while (cur?.startsWith('order:')) {
      const id = cur.slice('order:'.length)
      const at = path.indexOf(id)
      if (at !== -1) {
        const cycle = path.slice(at)
        parent.set(cycle.reduce((a, b) => (b < a ? b : a)), null)
        break
      }
      path.push(id)
      cur = parent.get(id)
    }
  }
  return parent
}

export function buildHierarchy(orders: readonly OrderView[]): HierarchyNode[] {
  const parent = parentOf(orders)
  const nodes = new Map<string, HierarchyNode>()
  for (const o of orders) nodes.set(orderKey(o.id), { kind: 'order', key: orderKey(o.id), order: o, children: [] })

  const roots: HierarchyNode[] = []
  for (const o of orders) {
    const node = nodes.get(orderKey(o.id))!
    const key = parent.get(o.id) ?? null
    if (key === null) {
      roots.push(node)
      continue
    }
    let host = nodes.get(key)
    if (!host) {
      const path = o.parentWorktree!
      const branch = o.parentBranch ?? o.baseBranch
      host = { kind: 'worktree', key, path: trim(path), label: lastSegment(path), ...(branch ? { branch } : {}), children: [] }
      nodes.set(key, host)
      roots.push(host)
    }
    host.children.push(node)
  }
  return roots
}

/** 남길 주문이 하나도 없는 가지를 걷어 낸다. 남길 주문의 조상은 숨길 주문이어도 남긴다 */
export function pruneHierarchy(
  nodes: readonly HierarchyNode[],
  keep: (o: OrderView) => boolean
): HierarchyNode[] {
  const out: HierarchyNode[] = []
  for (const n of nodes) {
    const children = pruneHierarchy(n.children, keep)
    if (children.length > 0 || (n.kind === 'order' && keep(n.order))) out.push({ ...n, children })
  }
  return out
}

export function hasNesting(nodes: readonly HierarchyNode[]): boolean {
  return nodes.some((n) => n.children.length > 0)
}

export function findNode(nodes: readonly HierarchyNode[], key: string): HierarchyNode | undefined {
  for (const n of nodes) {
    if (n.key === key) return n
    const hit = findNode(n.children, key)
    if (hit) return hit
  }
  return undefined
}
