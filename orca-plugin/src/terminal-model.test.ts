import { assert, test } from 'orca/testing'
import type { ConductorView, OrderView } from './protocol'
import { canReachWorker, chainChips, clock, duration, eventText, groupByRepo, laneOf, metaOf, progressOf, slotText, STALL_MS, stateLine, terminalModel, workerEnded } from './terminal-model'

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
})

test('canReachWorker는 워크트리가 있고 워커가 안 끝났고 주문이 안 닫힌 것만 고른다', () => {
  assert.equal(canReachWorker({ workspaceId: 'ws', workerStatus: 'running', status: 'running' }), true)
  assert.equal(canReachWorker({ workspaceId: 'ws', workerStatus: 'released', status: 'running' }), false)
  assert.equal(canReachWorker({ workerStatus: 'running', status: 'running' }), false)
  // 머지나 취소로 닫힌 주문은 워크트리가 남아 있어도 옮겨 가지 않는다
  assert.equal(canReachWorker({ workspaceId: 'ws', workerStatus: 'running', status: 'merged' }), false)
  assert.equal(canReachWorker({ workspaceId: 'ws', workerStatus: 'running', status: 'cancelled' }), false)
  assert.equal(canReachWorker({ workspaceId: 'ws', workerStatus: 'running', status: 'parked' }), true)
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
  // a는 진행, b(게이트 없는 waiting-gate)와 e(워커 없는 접수)는 대기다. 대기 칸은 상태 순서라 접수가 앞이다
  assert.deepEqual(
    m.cards.map((c) => c.order.id),
    ['a', 'e', 'b']
  )
  assert.deepEqual(m.running.map((c) => c.order.id), ['a'])
  assert.deepEqual(m.waiting.map((c) => c.order.id), ['e', 'b'])
  assert.deepEqual(
    m.cards[0]!.children.map((c) => c.id),
    ['c']
  )
  assert.deepEqual(m.kinds, { orca: 1, git: 0, sub: 1 })
  assert.equal(m.cards[2]!.bypass, '로컬 리뷰 생략')
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

const at = (minutes: number) => new Date(Date.parse('2026-11-25T06:00:00.000Z') - minutes * 60_000).toISOString()
const NOW_25 = Date.parse('2026-11-25T06:00:00.000Z')
const lanesView = (orders: OrderView[], gates: ConductorView['gates'] = []): ConductorView => ({
  state: 'ok',
  stateDir: null,
  lastTickAt: null,
  orders,
  gates,
  unassignedBypasses: [],
  refreshedAt: 0
})
const orcaWorker = (workerStatus: string): Partial<OrderView> => ({ worker: `w-${workerStatus}`, workerKind: 'orca-worktree', workerStatus })

test('끝난 워커는 워커 id가 남아 있어도 배지와 워커 수에서 빠지고 끝남 칸으로 간다', () => {
  const m = terminalModel(
    lanesView([
      { ...base, id: 'live', ...orcaWorker('running'), updatedAt: at(1) },
      { ...base, id: 'released', ...orcaWorker('released'), updatedAt: at(1) },
      { ...base, id: 'finished', status: 'escalated', ...orcaWorker('finished'), updatedAt: at(2) }
    ]),
    NOW_25
  )
  assert.deepEqual(m.ended.map((c) => c.order.id), ['released', 'finished'])
  assert.deepEqual(m.ended.map((c) => c.kind), ['none', 'none'])
  assert.deepEqual(m.kinds, { orca: 1, git: 0, sub: 0 })
  assert.equal(m.workers, 1)
  // 주문은 running으로 남아 있어도 끝남 칸에서는 돌고 있는 것처럼 그리지 않는다
  assert.equal(m.ended[0]!.state.tone, 'idle')
  assert.equal(m.ended[0]!.state.text, '워커 released · running')
})

test('게이트가 열린 주문은 하위 주문이라도 승인 칸에 오래 기다린 순으로 나온다', () => {
  const m = terminalModel(
    lanesView(
      [
        { ...base, id: 'parent', ...orcaWorker('running'), updatedAt: at(1) },
        { ...base, id: 'child', parentOrderId: 'parent', ...orcaWorker('running'), work: { activity: null, changedFiles: ['a', 'b', 'c'], overlapFiles: ['a', 'b'], tasks: null, subagents: null, recentTools: null, history: null } },
        { ...base, id: 'merge', status: 'waiting-gate', pr: 'acme/web#7', ...orcaWorker('running') }
      ],
      [
        { id: 'g1', type: 'file-overlap', orderId: 'child', reason: 'merge와 같은 파일 2개', openedAt: at(3) },
        { id: 'g2', type: 'merge', orderId: 'merge', reason: 'PR 머지', openedAt: at(12) },
        { id: 'g3', type: 'no-procedure', orderId: null, reason: '처리 절차 없음', openedAt: at(30), approverReady: false }
      ]
    ),
    NOW_25
  )
  assert.deepEqual(
    m.approval.map((e) => e.card?.order.id ?? `gate:${e.gates[0]!.gate.id}`),
    ['gate:g3', 'merge', 'child']
  )
  const [conductorGate, merge, overlap] = m.approval
  assert.deepEqual(merge!.gates.map(({ gate, ...rest }) => rest), [{ label: '머지 승인', waited: '12분', pr: 'acme/web#7' }])
  assert.deepEqual(overlap!.gates.map(({ gate, ...rest }) => rest), [{ label: '파일 겹침 확인', waited: '3분', overlapFiles: 2 }])
  // 서버가 approverReady를 주면 싣고 안 주면 칸을 만들지 않는다
  assert.equal(conductorGate!.gates[0]!.approverReady, false)
  assert.equal('approverReady' in merge!.gates[0]!, false)
  // 하위 주문은 부모 카드 안의 줄로도 남고 부모는 진행 칸에 그대로 있다
  assert.deepEqual(m.running.map((c) => c.order.id), ['parent'])
  assert.deepEqual(m.running[0]!.children.map((c) => c.id), ['child'])
  // 하위 주문 카드의 워커는 부모 카드가 이미 세서 두 번 세지 않는다
  assert.deepEqual(m.kinds, { orca: 2, git: 0, sub: 0 })
})

test('running이어도 대기 사유가 있거나 게이트 안 보이는 waiting-gate면 대기 칸으로 가고 한도는 진행 칸에 남는다', () => {
  const alive = orcaWorker('running')
  assert.equal(laneOf({ ...base, ...alive }), 'running')
  assert.equal(laneOf({ ...base, ...alive, workerStatus: 'starting' }), 'running')
  assert.equal(laneOf({ ...base, ...alive, waiting: { reason: 'ord-x 머지 대기', since: at(30) } }), 'waiting')
  assert.equal(laneOf({ ...base, ...alive, status: 'waiting-gate' }), 'waiting')
  assert.equal(laneOf({ ...base, ...alive, rateLimitedAt: at(5) }), 'running')
  assert.equal(laneOf({ ...base, status: 'queued' }), 'waiting')
  assert.equal(laneOf({ ...base, ...alive, workerStatus: 'released' }), 'ended')
  // workerStatus를 안 주는 옛 CLI는 워커가 붙어 있으면 돌고 있는 것으로 본다
  assert.equal(laneOf({ ...base, worker: 'w1' }), 'running')
})

test('부모가 대기나 끝남 칸이면 하위 주문은 부모 카드 안에 숨지 않고 제 칸에 나온다', () => {
  const m = terminalModel(
    lanesView([
      { ...base, id: 'waiting-parent', ...orcaWorker('running'), waiting: { reason: '하위 주문 대기', since: at(30) } },
      { ...base, id: 'child-a', parentOrderId: 'waiting-parent', ...orcaWorker('running') },
      { ...base, id: 'ended-parent', ...orcaWorker('released') },
      { ...base, id: 'child-b', parentOrderId: 'ended-parent', ...orcaWorker('running') }
    ]),
    NOW_25
  )
  assert.deepEqual(m.running.map((c) => c.order.id).sort(), ['child-a', 'child-b'])
  assert.deepEqual(m.waiting.map((c) => c.order.id), ['waiting-parent'])
  assert.deepEqual(m.ended.map((c) => c.order.id), ['ended-parent'])
  assert.deepEqual(m.kinds, { orca: 3, git: 0, sub: 0 })
})

test('화면에 없는 같은 주문의 게이트는 한 항목으로 묶고 주문 없는 게이트와 시각 없는 게이트는 따로 둔다', () => {
  const m = terminalModel(
    lanesView(
      [],
      [
        { id: 'g1', type: 'merge', orderId: 'gone', reason: 'a', openedAt: at(5) },
        { id: 'g2', type: 'slack-post', orderId: 'gone', reason: 'b', openedAt: at(9) },
        { id: 'g3', type: 'no-procedure', orderId: null, reason: 'c' },
        { id: 'g4', type: 'no-procedure', orderId: null, reason: 'd' },
        { id: 'g5', type: 'no-procedure', orderId: null, reason: 'e', openedAt: at(1) }
      ]
    ),
    NOW_25
  )
  assert.deepEqual(m.approval.map((e) => e.gates.map((g) => g.gate.id)), [['g1', 'g2'], ['g5'], ['g3'], ['g4']])
})

test('진행 칸 카드는 마지막 활동이 STALL_MS를 넘으면 멈춤 표시를 단다', () => {
  const work = (minutes: number): OrderView['work'] => ({ activity: { tool: 'Bash', at: at(minutes) }, changedFiles: [], overlapFiles: [], tasks: null, subagents: null, recentTools: null, history: null })
  assert.equal(STALL_MS, 10 * 60_000)
  const m = terminalModel(
    lanesView([
      { ...base, id: 'busy', ...orcaWorker('running'), work: work(3), updatedAt: at(40) },
      { ...base, id: 'quiet', ...orcaWorker('running'), work: work(25), updatedAt: at(1) },
      // 작업 내용이 없는 CLI면 체크포인트와 주문 갱신 중 늦은 쪽을 본다
      { ...base, id: 'old-cli', ...orcaWorker('running'), checkpoint: cp({ savedAt: at(15) }), updatedAt: at(12) },
      { ...base, id: 'waiting', ...orcaWorker('running'), work: work(60), waiting: { reason: 'CI', since: at(60) } }
    ]),
    NOW_25
  )
  const stalled = Object.fromEntries([...m.running, ...m.waiting].map((c) => [c.order.id, c.stalled]))
  assert.deepEqual(stalled, { busy: undefined, quiet: '25분', 'old-cli': '12분', waiting: undefined })
})

test('폰 화면은 칸과 숫자는 그대로 두고 워커가 쓴 글과 계정 이름을 뺀다', () => {
  const v = lanesView(
    [
      { ...base, id: 'run', ...orcaWorker('running'), account: 'work-acct', checkpoint: cp({ next: 'cat ~/.npmrc' }) },
      { ...base, id: 'wait', ...orcaWorker('running'), waiting: { reason: 'ghp_TOKEN 만료', since: at(5) } },
      { ...base, id: 'gate', status: 'waiting-gate', ...orcaWorker('running') }
    ],
    [{ id: 'g', type: 'merge', orderId: 'gate', reason: 'PR 머지', openedAt: at(2) }]
  )
  const phone = terminalModel(v, NOW_25, false)
  const desk = terminalModel(v, NOW_25, true)
  for (const m of [phone, desk]) assert.deepEqual([m.approval.length, m.running.length, m.waiting.length], [1, 1, 1])
  assert.equal(phone.running[0]!.next, undefined)
  assert.equal(phone.running[0]!.meta.some((r) => r.label === '계정'), false)
  assert.equal(phone.waiting[0]!.state.text, '대기')
  assert.equal(desk.running[0]!.next, 'cat ~/.npmrc')
  assert.equal(desk.waiting[0]!.state.text, 'ghp_TOKEN 만료')
})

test('terminalModel은 유형별 사용량을 조회, 리뷰, 작업 순으로 싣고 카드에 유형 이름표를 단다', () => {
  const view: ConductorView = {
    state: 'ok',
    stateDir: null,
    lastTickAt: null,
    orders: [
      { ...base, id: 'a', worker: 'w1', workerKind: 'orca-worktree', workClass: 'work' },
      { ...base, id: 'b', worker: 'w2', workerKind: 'subagent', workClass: 'review' }
    ],
    gates: [],
    unassignedBypasses: [],
    refreshedAt: 0,
    conductor: { maxWorkers: 20, workerSlots: { work: { active: 1, limit: 10 }, lookup: { active: 0, limit: 5 }, review: { active: 1, limit: 5 } } }
  }
  const m = terminalModel(view, 0)
  assert.deepEqual(m.slots, [
    { label: '조회', active: 0, limit: 5 },
    { label: '리뷰', active: 1, limit: 5 },
    { label: '작업', active: 1, limit: 10 }
  ])
  assert.equal(slotText(m.slots!), '조회 0/5 · 리뷰 1/5 · 작업 1/10')
  assert.deepEqual(m.cards.map((c) => c.workLabel), ['작업', '리뷰'])
})

test('유형을 안 주는 옛 CLI면 유형별 사용량과 이름표가 없고 전체 슬롯만 남는다', () => {
  const view: ConductorView = {
    state: 'ok',
    stateDir: null,
    lastTickAt: null,
    orders: [{ ...base, id: 'a', worker: 'w1', workerKind: 'orca-worktree' }],
    gates: [],
    unassignedBypasses: [],
    refreshedAt: 0,
    conductor: { maxWorkers: 4 }
  }
  const m = terminalModel(view, 0)
  assert.equal(m.slots, undefined)
  assert.equal(m.maxWorkers, 4)
  assert.equal(m.cards[0]!.workLabel, undefined)
})
