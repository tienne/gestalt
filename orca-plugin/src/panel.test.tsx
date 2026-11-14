import { assert, mockHost, mount, test } from 'orca/testing'
import type { ConductorView, GateResolveInput } from './protocol'
import * as panel from './panel'

const base: ConductorView = {
  state: 'ok',
  stateDir: '/state',
  lastTickAt: '2026-11-12T01:00:00.000Z',
  orders: [
    {
      id: 'ord-a',
      status: 'running',
      scope: 'pr',
      repo: 'web',
      title: '검색 문구 정리',
      updatedAt: '2026-11-12T00:59:00.000Z',
      issue: 'PROJ-1',
      bypasses: [],
      workspaceId: 'ws-a'
    },
    {
      id: 'ord-b',
      status: 'waiting-gate',
      scope: 'merge',
      repo: 'api',
      title: '취소 사유 추가',
      pr: 'api#48',
      bypasses: [{ need: 'review', action: '로컬 리뷰 생략', at: '2026-11-12T00:30:00.000Z' }]
    }
  ],
  gates: [
    { id: 'gate-m', type: 'merge', orderId: 'ord-b', reason: '머지 승인이 필요해요' },
    { id: 'gate-i', type: 'interview', orderId: 'ord-a', reason: '기본값을 켜둘까요?' }
  ],
  unassignedBypasses: [],
  refreshedAt: 0
}

function setup(view: ConductorView = base) {
  const resolved: GateResolveInput[] = []
  const opened: string[] = []
  const removed: string[][] = []
  const host = mockHost({
    requests: {
      'conductor.status': () => view,
      'conductor.refresh': () => view,
      'gate.resolve': (input) => {
        resolved.push(input)
        return {
          ok: true,
          gateId: input.gateId,
          decision: input.decision,
          hostActions: [{ kind: 'send-to-worker', workerId: 'wkr-1' }],
          errors: ['jira 전이 실패']
        }
      },
      'worker.open': (input) => {
        opened.push(input.orderId)
        return { opened: true }
      },
      'order.remove': (input) => {
        removed.push(input.orderIds)
        const [first, ...rest] = input.orderIds
        return {
          ok: true,
          removed: first ? [first] : [],
          skipped: rest.map((id) => ({ id, reason: `열린 게이트가 있어서 못 지워요: ${id}` }))
        }
      }
    }
  })
  return { host, resolved, opened, removed }
}

test('저장소가 없으면 저장소 없음 안내를 띄운다', async () => {
  const { host } = setup({ ...base, state: 'missing', orders: [], gates: [] })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: '컨덕터 저장소 없음' }))
  assert.equal(view.find({ text: '승인' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('지도는 레포마다 타일을 두고 확인 대기가 있는 레포를 앞에 둔다', async () => {
  const { host } = setup({
    ...base,
    orders: [
      ...base.orders,
      { id: 'ord-c', status: 'done', scope: 'pr', repo: 'acme/docs', title: '오탈자', bypasses: [] }
    ],
    gates: [base.gates[0]!]
  })
  const view = await mount(panel, { host })
  const tiles = view
    .findAll({ type: 'ListItem' })
    .map((b) => (b.key ?? '').replace(/^tile:(acme\/)?/, ''))
  assert.deepEqual(tiles, ['api', 'web', 'docs'])
  assert.ok(view.find({ text: 'acme' }))
  // 위 요약 배지 하나, api 타일 하나. 타일 안에서 게이트 배지와 상태 배지가 겹치면 셋이 된다
  assert.equal(view.findAll({ text: '확인 대기 1' }).length, 2)
  assert.equal(view.find({ text: '승인' }), null, '게이트 카드는 레포 상세에서만 그린다')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('지도 검색은 레포 이름과 프로젝트, 주문 제목으로 타일을 거른다', async () => {
  const { host } = setup({
    ...base,
    orders: [...base.orders, { id: 'ord-c', status: 'done', scope: 'pr', repo: 'acme/docs', title: '오탈자', bypasses: [] }]
  })
  const view = await mount(panel, { host })
  const tiles = () =>
    view.findAll({ type: 'ListItem' }).map((b) => (b.key ?? '').replace(/^tile:/, ''))

  await view.type({ label: '레포 검색' }, 'ACME')
  assert.deepEqual(tiles(), ['acme/docs'], '대소문자를 안 가린다')
  assert.ok(view.find({ text: '레포 3곳 중 1곳' }))

  await view.type({ label: '레포 검색' }, '취소 사유', { replace: true })
  assert.deepEqual(tiles(), ['api'], '주문 제목으로도 찾는다')

  await view.type({ label: '레포 검색' }, '없는레포', { replace: true })
  assert.deepEqual(tiles(), [])
  assert.ok(view.summary().some((l) => l.includes('맞는 레포가 없어요')), view.summary().join(' / '))

  await view.type({ label: '레포 검색' }, '', { replace: true })
  assert.equal(tiles().length, 3)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('지도에서 검색한 말이 레포 상세의 주문까지 이어진다', async () => {
  const { host } = setup({
    ...base,
    orders: [
      ...base.orders,
      { id: 'ord-b2', status: 'running', scope: 'pr', repo: 'api', title: '정산 배치 수정', bypasses: [] },
      { id: 'ord-b3', status: 'done', scope: 'pr', repo: 'api', title: '취소 사유 문구', bypasses: [] }
    ]
  })
  const view = await mount(panel, { host })
  const has = (text: string) => view.find({ text }) !== null

  await view.type({ label: '레포 검색' }, '취소 사유')
  await view.press({ testId: 'tile:api' })
  assert.equal(view.find({ label: '주문 검색' })?.props.value, '취소 사유', '상세 검색창에 같은 말이 들어 있다')
  assert.ok(has('취소 사유 추가'))
  assert.ok(view.find({ type: 'Collapsible', label: '끝남 1' }), '끝난 주문은 접힌 묶음에 남는다')
  assert.ok(!has('정산 배치 수정'), '안 맞는 주문은 가린다')
  assert.ok(has('주문 3개 중 2개'))
  assert.ok(has('끝난 주문 1개 지우기'))

  await view.type({ label: '주문 검색' }, '정산', { replace: true })
  assert.ok(has('정산 배치 수정'))
  assert.ok(!has('취소 사유 추가'))
  assert.ok(has('주문 3개 중 1개, 확인 대기 1개는 검색으로 가려졌어요'), '가려진 확인 대기를 알린다')
  assert.ok(!has('끝난 주문 1개 지우기'), '안 보이는 주문은 지우기에 안 넣는다')

  await view.type({ label: '주문 검색' }, 'api', { replace: true })
  assert.ok(has('정산 배치 수정') && has('취소 사유 추가'), '레포 이름으로 맞으면 주문이 다 보인다')

  await view.type({ label: '주문 검색' }, '없는주문', { replace: true })
  assert.ok(view.summary().some((l) => l.includes('맞는 주문이 없어요')), view.summary().join(' / '))

  await view.press({ text: '← 지도' })
  assert.equal(view.find({ label: '레포 검색' })?.props.value, '없는주문', '지도로 돌아와도 검색어가 남는다')
  await view.type({ label: '레포 검색' }, '', { replace: true })
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('옛 CLI면 주문을 눌러도 워커로 못 간다고 알린다', async () => {
  const { host } = setup({ ...base, outdatedCli: true })
  const view = await mount(panel, { host })
  const icon = view.find({ label: '주문을 눌러도 워커로 못 가요' })
  assert.equal(icon?.type, 'IconButton', '지도를 밀어내지 않게 아이콘으로만 둔다')
  assert.match(String(icon?.props.tooltip), /gestalt 실행 파일/)
  await view.unmount()
  const fresh = await mount(panel, { host: setup().host })
  assert.equal(fresh.find({ label: '주문을 눌러도 워커로 못 가요' }), null)
  await fresh.unmount()
})

test('타일을 누르면 그 레포의 주문만 보이고 지도로 돌아갈 수 있다', async () => {
  const { host, opened } = setup()
  const view = await mount(panel, { host })
  await view.press({ testId: 'tile:web' })
  assert.ok(view.find({ text: /검색 문구 정리/ }))
  assert.equal(view.find({ text: /취소 사유 추가/ }), null)
  await view.press({ testId: 'order:ord-a' })
  assert.deepEqual(opened, ['ord-a'], '주문 카드 어디를 눌러도 그 워커로 간다')

  await view.press({ text: '← 지도' })
  await view.press({ testId: 'tile:api' })
  assert.ok(view.find({ text: /PR api#48/ }))
  assert.equal(view.findAll({ type: 'ListItem' }).filter((i) => (i.key ?? '').startsWith('order:')).length, 0, '워크트리가 없는 주문은 누를 수 없다')
  await view.unmount()
})

test('승인은 두 번째 누름에서만 보내고 hostActions와 errors를 그대로 보여 준다', async () => {
  const { host, resolved } = setup()
  const view = await mount(panel, { host })
  await view.press({ testId: 'tile:api' })
  assert.ok(view.findAll({ text: /머지 승인이 필요해요/ }).length > 0)

  await view.press({ text: '승인' })
  assert.deepEqual(resolved, [], '첫 누름은 확인만 묻는다')
  assert.ok(view.find({ label: '정말 승인할까요?' }) ?? view.find({ text: /정말 승인할까요/ }))

  await view.press({ text: '승인 확정' })
  assert.deepEqual(resolved, [{ gateId: 'gate-m', decision: 'approve' }])
  assert.ok(view.find({ text: /컨덕터 세션에서 처리할 일/ }))
  assert.ok(view.find({ text: /send-to-worker/ }))
  assert.ok(view.find({ text: /jira 전이 실패/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('거절도 취소하면 보내지 않는다', async () => {
  const { host, resolved } = setup()
  const view = await mount(panel, { host })
  await view.press({ testId: 'tile:api' })
  await view.press({ text: '거절' })
  await view.press({ text: '취소' })
  assert.deepEqual(resolved, [])
  assert.equal(view.find({ text: '거절 확정' }), null)
  await view.unmount()
})

test('지도로 나갔다 오면 띄워 둔 게이트 확인 칸이 걷힌다', async () => {
  const { host, resolved } = setup()
  const view = await mount(panel, { host })
  await view.press({ testId: 'tile:api' })
  await view.press({ text: '승인' })
  assert.ok(view.find({ text: '승인 확정' }))
  await view.press({ text: '← 지도' })
  await view.press({ testId: 'tile:api' })
  assert.equal(view.find({ text: '승인 확정' }), null)
  assert.deepEqual(resolved, [])
  await view.unmount()
})

test('인터뷰 게이트는 적은 답을 함께 보낸다', async () => {
  const { host, resolved } = setup()
  const view = await mount(panel, { host })
  await view.press({ testId: 'tile:web' })
  await view.type({ label: '답' }, '켜 두세요')
  await view.press({ text: '승인' })
  await view.press({ text: '승인 확정' })
  assert.deepEqual(resolved, [{ gateId: 'gate-i', decision: 'approve', answer: '켜 두세요' }])
  await view.unmount()
})

test('주문 없는 게이트는 지도 위에 바로 그린다', async () => {
  const { host } = setup({
    ...base,
    gates: [{ id: 'gate-x', type: 'merge', orderId: null, reason: '주문 없이 열린 게이트' }]
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: '주문 없는 확인 대기' }))
  assert.ok(view.find({ text: /주문 없이 열린 게이트/ }))
  await view.unmount()
})

test('워커가 알린 변경을 바로 그린다', async () => {
  const { host } = setup()
  const view = await mount(panel, { host })
  await view.post('conductor.changed', { ...base, state: 'error', error: 'gestalt 실행 파일을 못 찾았어요' })
  assert.ok(view.find({ text: /gestalt 실행 파일을 못 찾았어요/ }))
  await view.unmount()
})

test('bypass 보고는 접어 두고 레포 상세와 지도에 나눠 보인다', async () => {
  const { host } = setup({
    ...base,
    unassignedBypasses: [{ need: 'slack', action: '슬랙 게시 생략', at: '' }]
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: '슬랙 게시 생략' }), null)
  await view.toggle({ type: 'Collapsible', text: /주문 없는 bypass 1개/ })
  assert.ok(view.find({ text: '슬랙 게시 생략' }))

  await view.press({ testId: 'tile:api' })
  assert.equal(view.find({ text: '로컬 리뷰 생략' }), null)
  await view.toggle({ type: 'Collapsible', text: /bypass 사후 보고 1개/ })
  assert.ok(view.find({ text: '로컬 리뷰 생략' }))
  await view.unmount()
})

test('레포 상세는 하위 주문과 부모 워크트리를 위계 트리로 그리고 Enter로 워크트리를 연다', async () => {
  const { host, opened } = setup({
    ...base,
    orders: [
      ...base.orders,
      { id: 'ord-s', status: 'queued', scope: 'pr', repo: 'web', title: '하위 작업', parentOrderId: 'ord-a', bypasses: [] },
      {
        id: 'ord-w',
        status: 'running',
        scope: 'pr',
        repo: 'web',
        title: '곁가지',
        parentWorktree: '/w/feat',
        parentBranch: 'feat/table',
        bypasses: []
      }
    ]
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: '하위 2' }), '타일에 위계에 걸린 주문 수를 붙인다')
  await view.press({ testId: 'tile:web' })
  const tree = view.find({ type: 'Tree' })!
  assert.ok(tree)
  assert.deepEqual(view.expandedOf({ type: 'Tree' }), ['order:ord-a', 'wt:/w/feat'])
  const items = tree.props['items'] as { key: string; children?: { key: string }[] }[]
  assert.deepEqual(
    items.map((i) => [i.key, (i.children ?? []).map((c) => c.key)]),
    [
      ['order:ord-a', ['order:ord-s']],
      ['wt:/w/feat', ['order:ord-w']]
    ]
  )
  await view.activateItem({ type: 'Tree' }, 'order:ord-a')
  assert.deepEqual(opened, ['ord-a'])
  await view.activateItem({ type: 'Tree' }, 'wt:/w/feat')
  assert.deepEqual(opened, ['ord-a'], '워크트리 노드는 열 주문이 없다')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('위계가 없는 레포에는 트리를 그리지 않는다', async () => {
  const { host } = setup()
  const view = await mount(panel, { host })
  await view.press({ testId: 'tile:web' })
  assert.equal(view.find({ type: 'Tree' }), null)
  await view.unmount()
})

test('끝난 주문은 두 번째 누름에서만 지우고 남긴 주문은 이유와 함께 보여 준다', async () => {
  const finished: ConductorView = {
    ...base,
    orders: [
      ...base.orders,
      { id: 'ord-d1', status: 'done', scope: 'pr', repo: 'web', title: '끝난 일', bypasses: [] },
      { id: 'ord-d2', status: 'cancelled', scope: 'pr', repo: 'web', title: '취소한 일', bypasses: [] }
    ]
  }
  const { host, removed } = setup(finished)
  const view = await mount(panel, { host })
  await view.press({ testId: 'tile:web' })
  assert.equal(view.findAll({ label: '주문 지우기' }).length, 0, '끝난 주문 그룹은 접혀 있다')
  await view.toggle({ type: 'Collapsible', label: '끝남 1' })
  await view.toggle({ type: 'Collapsible', label: '취소 1' })
  assert.equal(view.findAll({ label: '주문 지우기' }).length, 2, '진행 중인 주문에는 지우기가 없다')

  await view.press({ text: '끝난 주문 2개 지우기' })
  assert.deepEqual(removed, [], '첫 누름은 확인만 묻는다')
  assert.ok(view.find({ text: /끝난 주문 2개를 지울까요/ }))
  await view.press({ text: '취소' })
  assert.equal(view.find({ text: '지우기 확정' }), null)

  await view.press({ text: '끝난 주문 2개 지우기' })
  await view.press({ text: '지우기 확정' })
  assert.deepEqual(removed, [['ord-d1', 'ord-d2']])
  assert.ok(view.find({ text: /주문 1개를 지웠어요/ }))
  assert.ok(view.find({ text: /열린 게이트가 있어서 못 지워요: ord-d2/ }))

  await view.press(view.findAll({ label: '주문 지우기' })[0]!)
  assert.ok(view.find({ text: /이 주문을 지울까요/ }))
  await view.press({ text: '지우기 확정' })
  assert.deepEqual(removed.at(-1), ['ord-d1'])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
