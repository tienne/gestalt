import { assert, test } from 'orca/testing'
import { buildHierarchy, findNode, pruneHierarchy, type HierarchyNode } from './hierarchy'
import { summarize } from './model'
import type { ConductorView, OrderView } from './protocol'

const order = (id: string, extra: Partial<OrderView> = {}): OrderView => ({
  id,
  status: 'running',
  scope: 'pr',
  repo: 'web',
  title: id,
  bypasses: [],
  ...extra
})

const shape = (nodes: readonly HierarchyNode[]): unknown[] =>
  nodes.map((n) => (n.children.length > 0 ? { [n.key]: shape(n.children) } : n.key))

test('하위 주문은 상위 주문 밑에, 부모 워크트리는 그 워크트리를 맡은 주문 밑에 둔다', () => {
  const roots = buildHierarchy([
    order('a', { worktreePath: '/w/a-1' }),
    order('b', { parentOrderId: 'a' }),
    order('c', { parentWorktree: '/w/a-1/' }),
    order('d')
  ])
  assert.deepEqual(shape(roots), [{ 'order:a': ['order:b', 'order:c'] }, 'order:d'])
})

test('맡은 주문이 없는 부모 워크트리는 워크트리 노드로 묶고 브랜치를 붙인다', () => {
  const roots = buildHierarchy([
    order('a', { parentWorktree: '/w/feat-table', parentBranch: 'feat/table' }),
    order('b', { parentWorktree: '/w/feat-table' }),
    order('c', { parentOrderId: 'gone', parentWorktree: '/w/other', baseBranch: 'main' })
  ])
  assert.deepEqual(shape(roots), [
    { 'wt:/w/feat-table': ['order:a', 'order:b'] },
    { 'wt:/w/other': ['order:c'] }
  ])
  const wt = roots[0]!
  assert.equal(wt.kind === 'worktree' && wt.label, 'feat-table')
  assert.equal(wt.kind === 'worktree' && wt.branch, 'feat/table')
  assert.equal(roots[1]!.kind === 'worktree' && roots[1]!.branch, 'main', '부모 브랜치를 모르면 기준 브랜치를 쓴다')
})

test('고리가 생겨도 멈추고 모든 주문을 한 번씩만 그린다', () => {
  const roots = buildHierarchy([
    order('a', { parentOrderId: 'b' }),
    order('b', { parentOrderId: 'a' }),
    order('c', { parentOrderId: 'c' })
  ])
  assert.deepEqual(shape(roots), [{ 'order:a': ['order:b'] }, 'order:c'])
})

test('끝난 주문을 숨겨도 진행 중인 하위 주문의 조상은 남긴다', () => {
  const roots = buildHierarchy([
    order('a', { status: 'done' }),
    order('b', { parentOrderId: 'a' }),
    order('c', { status: 'done' })
  ])
  const kept = pruneHierarchy(roots, (o) => o.status !== 'done')
  assert.deepEqual(shape(kept), [{ 'order:a': ['order:b'] }])
  assert.equal(findNode(roots, 'order:b')?.kind, 'order')
})

test('레포 요약은 같은 레포 안에서 위계에 걸린 주문 수를 센다', () => {
  const v: ConductorView = {
    state: 'ok',
    stateDir: '/s',
    lastTickAt: null,
    orders: [
      order('a'),
      order('b', { parentOrderId: 'a' }),
      order('x', { repo: 'api', parentOrderId: 'a' })
    ],
    gates: [],
    unassignedBypasses: [],
    refreshedAt: 0
  }
  const repos = summarize(v).repos
  assert.equal(repos.find((s) => s.repo === 'web')?.nested, 1)
  assert.equal(repos.find((s) => s.repo === 'api')?.nested, 0, '다른 레포의 상위 주문은 뿌리로 그린다')
})
