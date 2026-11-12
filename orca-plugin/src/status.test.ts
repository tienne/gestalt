import { assert, test } from 'orca/testing'
import type { ConductorView } from './protocol'
import {
  diffGates,
  emptyView,
  findWorkspace,
  isSafeId,
  parseJsonOutput,
  parseStatus,
  statusBarOf,
  toView
} from './status'

test('parseJsonOutput은 앞뒤에 섞인 줄을 걷고 JSON만 읽는다', () => {
  assert.deepEqual(parseJsonOutput('warn: old node\n{"a":1}\n'), { a: 1 })
  assert.throws(() => parseJsonOutput('nothing'))
})

test('parseStatus는 옛 CLI 출력도 읽고 꼴이 틀린 줄은 버린다', () => {
  const raw = parseStatus({
    lastTickAt: null,
    orders: [
      { id: 'o1', status: 'queued', scope: 'pr', repo: 'r', title: 't', bypasses: [{ need: 'n', action: 'a', at: 'x' }] },
      { status: 'running' },
      'junk'
    ],
    gates: [{ id: 'g1', type: 'merge', orderId: null, reason: 'r' }, { type: 'merge' }]
  })
  assert.equal(raw.stateDir, undefined)
  assert.deepEqual(
    raw.orders.map((o) => o.id),
    ['o1']
  )
  assert.deepEqual(raw.unassignedBypasses, [])
  assert.deepEqual(raw.gates, [{ id: 'g1', type: 'merge', orderId: null, reason: 'r' }])
  assert.throws(() => parseStatus({ orders: [] }), /gestalt 버전/)
})

test('findWorkspace는 오르카 워크트리는 디렉토리 이름으로, git 워크트리는 경로로 찾는다', () => {
  const ws = [
    { id: 'w1', kind: 'worktree', path: '/r/o1-2/' },
    { id: 'w2', kind: 'folder', path: '/r/o1-3' },
    { id: 'w3', kind: 'worktree', path: '/tmp/wt/o2' }
  ]
  const order = { id: 'o1', status: 'running', scope: 'pr', repo: 'r', title: 't', bypasses: [] }
  assert.equal(findWorkspace({ ...order, workerKind: 'orca-worktree', worktreeName: 'o1-2' }, ws), 'w1')
  assert.equal(findWorkspace({ ...order, workerKind: 'orca-worktree', worktreeName: 'o1-3' }, ws), undefined)
  assert.equal(findWorkspace({ ...order, workerKind: 'git-worktree', workerHandle: '/tmp/wt/o2/' }, ws), 'w3')
  assert.equal(findWorkspace({ ...order, workerKind: 'subagent', workerHandle: 'subagent:x' }, ws), undefined)
})

test('statusBarOf는 확인 대기가 있으면 warning, 저장소가 없거나 CLI가 실패하면 danger다', () => {
  const raw = parseStatus({
    lastTickAt: null,
    orders: [
      { id: 'a', status: 'running' },
      { id: 'b', status: 'escalated' },
      { id: 'c', status: 'done' },
      { id: 'd', status: 'cancelled' }
    ],
    gates: []
  })
  const quiet = toView(raw, '/s', [], 0)
  assert.deepEqual(statusBarOf(quiet), {
    text: '주문 2 · 확인 대기 0',
    tone: 'neutral',
    tooltip: '진행 중인 주문 2개, 사람 확인을 기다리는 게이트 0개'
  })
  const busy: ConductorView = { ...quiet, gates: [{ id: 'g', type: 'merge', orderId: 'a', reason: '' }] }
  assert.equal(statusBarOf(busy).tone, 'warning')
  assert.equal(statusBarOf(busy).text, '주문 2 · 확인 대기 1')
  assert.equal(statusBarOf(emptyView('missing', '/s', 0)).text, '컨덕터 저장소 없음')
  assert.equal(statusBarOf(emptyView('missing', '/s', 0)).tone, 'danger')
  assert.deepEqual(statusBarOf(emptyView('error', null, 0, 'boom')), {
    text: '컨덕터 오류',
    tone: 'danger',
    tooltip: 'boom'
  })
})

test('diffGates는 처음 보는 게이트만 고르고 알린 목록을 열린 게이트로 줄인다', () => {
  const gates = [
    { id: 'g1', type: 'merge', orderId: null, reason: '' },
    { id: 'g2', type: 'merge', orderId: null, reason: '' }
  ]
  const out = diffGates(gates, ['g1', 'g0'])
  assert.deepEqual(
    out.fresh.map((g) => g.id),
    ['g2']
  )
  assert.deepEqual(out.keep, ['g1', 'g2'])
})

test('isSafeId는 옵션처럼 읽히는 값을 막는다', () => {
  assert.equal(isSafeId('gate-1a2b3c4d'), true)
  assert.equal(isSafeId('--approve'), false)
  assert.equal(isSafeId('a b'), false)
  assert.equal(isSafeId(''), false)
})
