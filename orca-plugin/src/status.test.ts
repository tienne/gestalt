import { assert, test } from 'orca/testing'
import type { ConductorView } from './protocol'
import {
  diffGates,
  emptyView,
  findWorkspace,
  isSafeId,
  projectsOf,
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
  assert.equal(findWorkspace({ ...order, workerKind: 'orca-worktree', worktreeName: 'o1-2' }, ws)?.id, 'w1')
  assert.equal(findWorkspace({ ...order, workerKind: 'orca-worktree', worktreeName: 'o1-3' }, ws), undefined)
  assert.equal(findWorkspace({ ...order, workerKind: 'git-worktree', workerHandle: '/tmp/wt/o2/' }, ws)?.id, 'w3')
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

test('toView는 위계 필드를 싣고 워커와 부모 워크트리의 오르카 경로와 브랜치를 붙인다', () => {
  const raw = parseStatus({
    lastTickAt: null,
    orders: [
      {
        id: 'p',
        status: 'running',
        workerKind: 'orca-worktree',
        worktreeName: 'p-1',
        parentWorktree: '/w/feat',
        baseBranch: 'feat/table'
      },
      { id: 'c', status: 'queued', parentOrderId: 'p', parentWorktree: 7 }
    ],
    gates: []
  })
  const ws = [
    { id: 'w-feat', kind: 'worktree', path: '/w/feat/', branch: 'feat/table' },
    { id: 'w-p', kind: 'worktree', path: '/w/feat/p-1', branch: 'gestalt/p' }
  ]
  const [p, c] = toView(raw, '/s', ws, 0).orders
  assert.equal(p?.workspaceId, 'w-p')
  assert.equal(p?.worktreePath, '/w/feat/p-1')
  assert.equal(p?.branch, 'gestalt/p')
  assert.equal(p?.parentWorktree, '/w/feat')
  assert.equal(p?.parentBranch, 'feat/table')
  assert.equal(p?.baseBranch, 'feat/table')
  assert.equal(c?.parentOrderId, 'p')
  assert.equal(c?.parentWorktree, undefined, '꼴이 틀린 값은 버린다')
})

test('레포마다 오르카 프로젝트 이름을 맡은 워크트리에서 먼저 찾고 없으면 디렉토리 이름으로 찾는다', () => {
  const raw = parseStatus({
    lastTickAt: null,
    orders: [
      { id: 'a', repo: 'Acme/web', workerKind: 'orca-worktree', worktreeName: 'ord-a-1' },
      { id: 'b', repo: 'Acme/lib' },
      { id: 'c', repo: 'Acme/twin' },
      { id: 'd', repo: 'Acme/nowhere' }
    ],
    gates: []
  })
  const ws = [
    { id: '1', kind: 'worktree', path: '/o/web-x/ord-a-1', project: '웹' },
    { id: '2', kind: 'worktree', path: '/src/web', project: '다른 이름' },
    { id: '3', kind: 'worktree', path: '/src/LIB/', project: '공통 라이브러리' },
    { id: '4', kind: 'worktree', path: '/a/twin', project: '하나' },
    { id: '5', kind: 'worktree', path: '/b/twin', project: '둘' }
  ]
  assert.deepEqual(projectsOf(raw.orders, ws), { 'Acme/web': '웹', 'Acme/lib': '공통 라이브러리' })
  assert.deepEqual(toView(raw, '/s', ws, 0).projects, { 'Acme/web': '웹', 'Acme/lib': '공통 라이브러리' })
})
