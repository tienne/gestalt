import { assert, test } from 'orca/testing'
import type { ConductorView, OrderView } from './protocol'
import { canReachWorker, chainChips, clock, duration, eventText, groupByRepo, metaOf, progressOf, stateLine, terminalModel, workerEnded } from './terminal-model'

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

test('머지됐거나 끝난 주문은 체크포인트와 상관없이 체인을 다 돈 것으로 그린다', () => {
  // 워커가 머지 직전 체크포인트만 남기고 끝나서 끝남 체크포인트가 없다
  const stale = cp({ skill: 'gestalt:ship', completedSkills: [] })
  for (const status of ['merged', 'done']) {
    const o = { ...base, status, skillChain: ['solve', 'ship'], checkpoint: stale }
    assert.deepEqual(chainChips(o), [
      { text: 'solve', state: 'done' },
      { text: 'ship', state: 'done' }
    ])
    assert.equal(progressOf(o), 1)
  }
  // 배포를 기다리는 주문도 배포는 체인의 스킬이 아니라 체인은 다 돈 것이다
  const deploying = { ...base, status: 'merged', awaitingDeploy: true, skillChain: ['solve', 'ship'], checkpoint: stale }
  assert.deepEqual(chainChips(deploying).map((c) => c.state), ['done', 'done'])
  assert.equal(progressOf(deploying), 1)
  assert.deepEqual(chainChips({ ...base, status: 'merged', skillChain: [] }), [])
  assert.equal(progressOf({ ...base, status: 'merged', skillChain: [] }), null)
})

test('체크포인트 스킬과 끝난 스킬은 gestalt: 접두를 떼고 체인과 맞춘다', () => {
  const o = { ...base, skillChain: ['solve', 'ship'], checkpoint: cp({ skill: 'gestalt:ship', phase: 'copilot', completedSkills: ['gestalt:solve'] }) }
  assert.deepEqual(
    chainChips(o).map((c) => `${c.state}:${c.text}`),
    ['done:solve', 'cur:ship · copilot']
  )
  assert.equal(progressOf(o), 0.5)
})

test('workerEnded는 해제됐거나 끝난 워커만 고른다', () => {
  assert.equal(workerEnded({ workerStatus: 'released' }), true)
  assert.equal(workerEnded({ workerStatus: 'finished' }), true)
  assert.equal(workerEnded({ workerStatus: 'running' }), false)
  assert.equal(workerEnded({}), false)
  assert.equal(canReachWorker({ workspaceId: 'ws', workerStatus: 'running' }), true)
  assert.equal(canReachWorker({ workspaceId: 'ws', workerStatus: 'released' }), false)
  assert.equal(canReachWorker({ workerStatus: 'running' }), false)
})

test('stateLine은 한도, 게이트, 대기, 그 밖 순으로 고른다', () => {
  const now = Date.parse('2026-11-12T01:00:00.000Z')
  const gates = [{ id: 'g', type: 'merge', orderId: 'o1', reason: '', openedAt: '2026-11-12T00:42:00.000Z' }]
  const waiting = { reason: 'CI 대기', since: '2026-11-12T00:53:00.000Z' }
  assert.equal(stateLine({ ...base, rateLimitedAt: '2026-11-12T00:00:00.000Z', waiting }, gates, now).tone, 'limit')
  assert.deepEqual(stateLine({ ...base, waiting }, gates, now), { tone: 'gate', text: '머지 승인 대기', aside: '18분' })
  assert.deepEqual(stateLine({ ...base, waiting }, [], now), { tone: 'wait', text: 'CI 대기', aside: '7분' })
  assert.deepEqual(stateLine({ ...base, waiting }, [], now, false), { tone: 'wait', text: '대기', aside: '7분' }, '폰 페이지에는 대기 사유를 안 싣는다')
  assert.deepEqual(stateLine({ ...base, updatedAt: '2026-11-12T00:57:00.000Z' }, [], now), {
    tone: 'run',
    text: 'running',
    aside: '3분 전'
  })
  assert.deepEqual(stateLine({ ...base, status: 'merged', awaitingDeploy: true }, [], now), {
    tone: 'deploy',
    text: '배포 대기',
    aside: ''
  })
  assert.deepEqual(stateLine({ ...base, status: 'merged' }, [], now), { tone: 'idle', text: 'merged', aside: '' }, '옛 CLI 주문은 그대로다')
  assert.equal(duration(null, now), '')
})

test('metaOf는 레포 이름, 지라 키, PR, 계정이나 서브에이전트, 기준 브랜치를 이름표와 함께 낸다', () => {
  const rows = (o: Parameters<typeof metaOf>[0], show?: boolean) => metaOf(o, show).map((r) => `${r.label}=${r.value}`)
  assert.deepEqual(rows({ ...base, issue: 'PROJ-12', account: 'work' }), ['레포=web', '티켓=PROJ-12', '계정=work'])
  assert.deepEqual(rows({ ...base, pr: 'api#48', workerKind: 'subagent' }), ['레포=web', 'PR=api#48', '워커=subagent'])
  assert.deepEqual(rows({ ...base, baseBranch: 'feat/search' }), ['레포=web', '기준 브랜치=feat/search'])
  assert.deepEqual(rows({ ...base, issue: 'PROJ-12', account: 'work' }, false), ['레포=web', '티켓=PROJ-12'], '폰 페이지에는 계정 이름을 안 싣는다')
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

test('같은 대기면 카드 상태줄과 이벤트 로그가 같은 로컬 시각을 적는다', () => {
  const until = '2026-11-12T02:10:00.000Z'
  const o: OrderView = { ...base, waiting: { reason: 'CI 대기', since: '2026-11-12T01:51:00.000Z', until } }
  const card = stateLine(o, [], Date.parse('2026-11-12T01:58:00.000Z')).text
  const row = eventText({ at: '2026-11-12T01:51:00.000Z', type: 'waiting', orderId: 'o1', summary: 'CI 대기', until })
  const at = clock(until)
  assert.equal(card, `CI 대기 ~${at}`)
  assert.equal(row, `o1 CI 대기 · ~${at}`)
  // 기한을 문장에 굳혀 보내던 옛 CLI 줄은 손대지 않는다
  assert.equal(eventText({ at: 't', type: 'waiting', summary: 'CI 대기 · ~11:10' }), 'CI 대기 · ~11:10')
})

test('terminalModel은 배포 대기 카드를 머지됨 카드보다 앞에 둔다', () => {
  const view: ConductorView = {
    state: 'ok',
    stateDir: null,
    lastTickAt: null,
    orders: [
      { ...base, id: 'm', status: 'merged', updatedAt: '2026-11-12T00:59:00.000Z' },
      { ...base, id: 'd', status: 'merged', awaitingDeploy: true, updatedAt: '2026-11-12T00:00:00.000Z' }
    ],
    gates: [],
    unassignedBypasses: [],
    refreshedAt: 0
  }
  assert.deepEqual(
    terminalModel(view, 0).cards.map((c) => c.order.id),
    ['d', 'm']
  )
})

test('groupByRepo는 레포가 처음 나온 순서로 묶고 프로젝트 이름, 레포 이름, 레포 없음 순으로 이름을 고른다', () => {
  const card = (id: string, repo: string) => ({ order: { id, repo } }) as unknown as Parameters<typeof groupByRepo>[0][number]
  const groups = groupByRepo([card('a', 'acme/api'), card('b', 'acme/web'), card('c', 'acme/api'), card('d', '')], { 'acme/web': '웹' })
  assert.deepEqual(
    groups.map((g) => `${g.label}:${g.cards.map((c) => c.order.id).join('')}`),
    ['api:ac', '웹:b', '레포 없음:d']
  )
})
