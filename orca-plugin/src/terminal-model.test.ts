import { assert, test } from 'orca/testing'
import type { ConductorView, OrderView } from './protocol'
import { chainChips, duration, metaOf, progressOf, stateLine, terminalModel } from './terminal-model'

const base: OrderView = { id: 'o1', status: 'running', scope: 'pr', repo: 'acme/web', title: 't', bypasses: [] }
const cp = (over: Partial<NonNullable<OrderView['checkpoint']>> = {}) => ({
  skill: 'ship',
  next: '',
  completedSkills: ['interview', 'spec'],
  savedAt: '2026-11-12T00:00:00.000Z',
  ...over
})

test('chainChips는 끝난 스킬, 지금 스킬과 단계, 남은 스킬로 가른다', () => {
  const o = { ...base, skillChain: ['interview', 'spec', 'ship', 'merge'], checkpoint: cp({ phase: 'copilot', round: 2 }) }
  assert.deepEqual(chainChips(o), [
    { text: 'interview', state: 'done' },
    { text: 'spec', state: 'done' },
    { text: 'ship · copilot r2', state: 'cur' },
    { text: 'merge', state: 'todo' }
  ])
  assert.equal(progressOf(o), 0.5)
})

test('chainChips는 체인에 없는 스킬을 돌면 끝난 칩 뒤에 끼우고 체크포인트가 없으면 전부 남은 스킬이다', () => {
  const o = { ...base, skillChain: ['solve', 'merge'], checkpoint: cp({ skill: 'review', completedSkills: ['solve'] }) }
  assert.deepEqual(
    chainChips(o).map((c) => `${c.state}:${c.text}`),
    ['done:solve', 'cur:review', 'todo:merge']
  )
  assert.deepEqual(chainChips({ ...base, skillChain: ['solve'] }), [{ text: 'solve', state: 'todo' }])
  assert.equal(progressOf(base), null)
})

test('stateLine은 한도, 게이트, 대기, 그 밖 순으로 고른다', () => {
  const now = Date.parse('2026-11-12T01:00:00.000Z')
  const gates = [{ id: 'g', type: 'merge', orderId: 'o1', reason: '', openedAt: '2026-11-12T00:42:00.000Z' }]
  const waiting = { reason: 'CI 대기', since: '2026-11-12T00:53:00.000Z' }
  assert.equal(stateLine({ ...base, rateLimitedAt: '2026-11-12T00:00:00.000Z', waiting }, gates, now).tone, 'limit')
  assert.deepEqual(stateLine({ ...base, waiting }, gates, now), { tone: 'gate', text: '머지 승인 대기', aside: '18분' })
  assert.deepEqual(stateLine({ ...base, waiting }, [], now), { tone: 'wait', text: 'CI 대기', aside: '7분' })
  assert.deepEqual(stateLine({ ...base, updatedAt: '2026-11-12T00:57:00.000Z' }, [], now), {
    tone: 'run',
    text: 'running',
    aside: '3분 전'
  })
  assert.equal(duration(null, now), '')
})

test('metaOf는 레포 이름, 지라 키, PR, 계정이나 서브에이전트, 기준 브랜치를 잇는다', () => {
  assert.deepEqual(metaOf({ ...base, issue: 'PROJ-12', account: 'work' }), ['web', 'PROJ-12', 'acct work'])
  assert.deepEqual(metaOf({ ...base, pr: 'api#48', workerKind: 'subagent' }), ['web', 'api#48', 'subagent'])
  assert.deepEqual(metaOf({ ...base, baseBranch: 'feat/search' }), ['web', '⤷ feat/search'])
})

test('terminalModel은 끝나지 않은 주문만 카드로 만들고 하위 주문은 부모 카드 안에 넣는다', () => {
  const view: ConductorView = {
    state: 'ok',
    stateDir: null,
    lastTickAt: null,
    orders: [
      { ...base, id: 'a', worker: 'w1', workerKind: 'orca-worktree' },
      { ...base, id: 'b', status: 'waiting-gate', worker: 'w2', workerKind: 'subagent', bypasses: [{ need: 'review', action: '로컬 리뷰 생략', at: '' }] },
      { ...base, id: 'c', status: 'queued', parentOrderId: 'a' },
      { ...base, id: 'd', status: 'done', worker: 'w4', workerKind: 'git-worktree' },
      { ...base, id: 'e', status: 'queued', parentOrderId: 'd' }
    ],
    gates: [],
    unassignedBypasses: [{ need: 'slack', action: 'x', at: '' }],
    conductor: { maxWorkers: 4, activeWorkers: 2, queuedOrders: 2 },
    refreshedAt: 0
  }
  const m = terminalModel(view, 0)
  assert.deepEqual(
    m.cards.map((c) => c.order.id),
    ['a', 'b', 'e']
  )
  assert.deepEqual(
    m.cards[0]!.children.map((c) => c.id),
    ['c']
  )
  assert.deepEqual(m.kinds, { orca: 1, git: 0, sub: 1 })
  assert.equal(m.cards[1]!.bypass, '로컬 리뷰 생략')
  assert.equal(m.bypasses, 1)
  assert.equal(m.maxWorkers, 4)
  assert.equal(m.activeWorkers, 2)
  assert.deepEqual(m.events, [])
})

test('terminalModel은 옛 CLI면 슬롯 최대값을 비우고 워커 수와 대기 주문을 주문에서 센다', () => {
  const view: ConductorView = {
    state: 'ok',
    stateDir: null,
    lastTickAt: null,
    orders: [
      { ...base, id: 'a', worker: 'w1', workerKind: 'orca-worktree' },
      { ...base, id: 'b', status: 'queued' }
    ],
    gates: [],
    unassignedBypasses: [],
    refreshedAt: 0
  }
  const m = terminalModel(view, 0)
  assert.equal(m.maxWorkers, undefined)
  assert.equal(m.activeWorkers, 1)
  assert.equal(m.queued, 1)
})
