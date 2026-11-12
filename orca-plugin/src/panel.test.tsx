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
      }
    }
  })
  return { host, resolved, opened }
}

test('저장소가 없으면 저장소 없음 안내를 띄운다', async () => {
  const { host } = setup({ ...base, state: 'missing', orders: [], gates: [] })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: '컨덕터 저장소 없음' }))
  assert.equal(view.find({ text: '승인' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('승인은 두 번째 누름에서만 보내고 hostActions와 errors를 그대로 보여 준다', async () => {
  const { host, resolved } = setup()
  const view = await mount(panel, { host })
  const card = view.findAll({ text: /머지 승인이 필요해요/ })
  assert.ok(card.length > 0)

  await view.press(view.findAll({ text: '승인' })[0]!)
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
  await view.press(view.findAll({ text: '거절' })[0]!)
  await view.press({ text: '취소' })
  assert.deepEqual(resolved, [])
  assert.equal(view.find({ text: '거절 확정' }), null)
  await view.unmount()
})

test('인터뷰 게이트는 적은 답을 함께 보낸다', async () => {
  const { host, resolved } = setup()
  const view = await mount(panel, { host })
  await view.type({ label: '답' }, '켜 두세요')
  await view.press(view.findAll({ text: '승인' })[1]!)
  await view.press({ text: '승인 확정' })
  assert.deepEqual(resolved, [{ gateId: 'gate-i', decision: 'approve', answer: '켜 두세요' }])
  await view.unmount()
})

test('주문을 상태별로 묶고 워크트리가 있는 주문에만 열기 버튼을 단다', async () => {
  const { host, opened } = setup()
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: /검색 문구 정리/ }))
  assert.ok(view.find({ text: /PR api#48/ }))
  const buttons = view.findAll({ label: '워크트리 열기' })
  assert.equal(buttons.length, 1)
  await view.press(buttons[0]!)
  assert.deepEqual(opened, ['ord-a'])
  await view.unmount()
})

test('워커가 알린 변경을 바로 그린다', async () => {
  const { host } = setup()
  const view = await mount(panel, { host })
  await view.post('conductor.changed', { ...base, state: 'error', error: 'gestalt 실행 파일을 못 찾았어요' })
  assert.ok(view.find({ text: /gestalt 실행 파일을 못 찾았어요/ }))
  await view.unmount()
})

test('bypass 보고는 접어 두고 펼치면 주문별로 보인다', async () => {
  const { host } = setup({
    ...base,
    unassignedBypasses: [{ need: 'slack', action: '슬랙 게시 생략', at: '' }]
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: '로컬 리뷰 생략' }), null)
  await view.toggle({ type: 'Collapsible', text: /bypass 사후 보고 2건/ })
  assert.ok(view.find({ text: '로컬 리뷰 생략' }))
  assert.ok(view.find({ text: '슬랙 게시 생략' }))
  await view.unmount()
})
