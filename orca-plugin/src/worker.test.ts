// 진짜 gestalt 대신 test/fake-gestalt.mjs를 부른다. 저장소도 임시 폴더라 실제 컨덕터 상태는 건드리지 않는다.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { request } from 'node:http'
import { join } from 'node:path'
import type { ConductorView } from './protocol'
import * as main from './worker'

const FAKE = decodeURIComponent(new URL('../test/fake-gestalt.mjs', import.meta.url).pathname)

type Call = { args: string[]; cwd: string }

function store(status?: unknown) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-plugin-')))
  if (status !== undefined) {
    writeFileSync(join(dir, 'events.jsonl'), '')
    writeFileSync(join(dir, 'fake-status.json'), JSON.stringify(status))
  }
  writeFileSync(join(dir, 'fake-calls.jsonl'), '')
  return {
    dir,
    calls: (): Call[] =>
      readFileSync(join(dir, 'fake-calls.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Call),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

const STATUS = {
  lastTickAt: '2026-11-12T01:00:00.000Z',
  orders: [
    {
      id: 'ord-a',
      status: 'running',
      scope: 'pr',
      repo: 'web',
      title: 'A',
      workerKind: 'orca-worktree',
      worktreeName: 'ord-a-2',
      bypasses: []
    },
    { id: 'ord-b', status: 'done', scope: 'merge', repo: 'api', title: 'B', bypasses: [] }
  ],
  unassignedBypasses: [],
  gates: [{ id: 'gate-1', type: 'merge', orderId: 'ord-a', reason: '머지 승인' }]
}

const WORKSPACES = {
  workspaces: [
    { id: 'ws-other', kind: 'worktree', name: 'x', path: '/w/ord-z-1', branch: 'x', hostId: 'local' },
    { id: 'ws-a', kind: 'worktree', name: 'a', path: '/w/ord-a-2', branch: 'a', hostId: 'local' }
  ],
  truncated: false
}

function host(dir: string, storage: Record<string, string[]> = {}, extra: Record<string, unknown> = {}) {
  return mockHost({
    settings: { gestaltPath: FAKE, stateDir: dir, ...extra },
    storage,
    results: { 'workspace.list': WORKSPACES, 'workspace.open': { opened: true } }
  })
}

async function run(
  s: ReturnType<typeof store>,
  h: ReturnType<typeof host>,
  body: (worker: Awaited<ReturnType<typeof mountWorker>>) => Promise<void>
) {
  const worker = await mountWorker(main, { host: h })
  try {
    await body(worker)
  } finally {
    await worker.deactivate()
    s.cleanup()
  }
}

const lastBar = (calls: unknown[]) => calls.at(-1) as { text: string; tone: string; tooltip: string }

test('저장소가 비었으면 CLI를 부르지 않고 저장소 없음을 띄운다', async () => {
  const s = store()
  const h = host(s.dir)
  await run(s, h, async (worker) => {
    const view = await worker.request('conductor.refresh')
    assert.equal(view.state, 'missing')
    assert.deepEqual(s.calls(), [])
    assert.equal(existsSync(join(s.dir, 'events.jsonl')), false)
    assert.deepEqual(lastBar(h.callsOf('statusBar.update')), {
      id: 'conductor',
      text: '컨덕터 저장소 없음',
      tone: 'danger',
      tooltip: `${s.dir}에 events.jsonl이 없어요`
    })
    assert.deepEqual(worker.refusals, [])
  })
})

test('status JSON을 읽어 워크트리를 잇고 확인 대기를 상태 표시줄과 알림으로 낸다', async () => {
  const s = store(STATUS)
  const h = host(s.dir)
  await run(s, h, async (worker) => {
    const view = await worker.request('conductor.refresh')
    assert.equal(view.state, 'ok')
    assert.equal(view.orders.find((o) => o.id === 'ord-a')?.workspaceId, 'ws-a')
    assert.equal(view.orders.find((o) => o.id === 'ord-b')?.workspaceId, undefined)

    const call = s.calls().at(-1)!
    assert.deepEqual(call.args, ['conductor', 'status', '--all', '--json', `--state-dir=${s.dir}`])
    // 워커 워크트리 안에서 부르면 gate resolve가 거절되므로 저장소 폴더에서 부르는지 본다
    assert.equal(realpathSync(call.cwd), s.dir)

    const bar = lastBar(h.callsOf('statusBar.update'))
    assert.equal(bar.text, '주문 1 · 확인 대기 1')
    assert.equal(bar.tone, 'warning')
    assert.equal(h.callsOf('notifications.show').length, 1)
    assert.deepEqual(h.data().storage['notifiedGates'], ['gate-1'])

    const posted = worker.posts.filter((p) => p.event === 'conductor.changed')
    assert.equal((posted.at(-1)?.payload as ConductorView).gates[0]?.id, 'gate-1')

    await worker.request('conductor.refresh')
    assert.equal(h.callsOf('notifications.show').length, 1, '같은 게이트를 두 번 알리지 않는다')
    assert.deepEqual(worker.refusals, [])
  })
})

test('워커가 다시 떠도 이미 알린 게이트는 다시 알리지 않는다', async () => {
  const s = store(STATUS)
  const h = host(s.dir, { notifiedGates: ['gate-1', 'gate-closed'] })
  await run(s, h, async (worker) => {
    await worker.request('conductor.refresh')
    assert.equal(h.callsOf('notifications.show').length, 0)
    assert.deepEqual(h.data().storage['notifiedGates'], ['gate-1'], '닫힌 게이트 id는 지운다')
  })
})

test('CLI가 실패하면 상태 표시줄을 danger로 바꾸고 이유를 툴팁에 싣는다', async () => {
  const s = store(STATUS)
  writeFileSync(join(s.dir, 'fake-fail'), 'error: 컨덕터 설정을 못 읽었어요\n')
  const h = host(s.dir)
  await run(s, h, async (worker) => {
    const view = await worker.request('conductor.refresh')
    assert.equal(view.state, 'error')
    const bar = lastBar(h.callsOf('statusBar.update'))
    assert.equal(bar.tone, 'danger')
    assert.equal(bar.tooltip, 'error: 컨덕터 설정을 못 읽었어요')
  })
})

test('gate.resolve는 결정과 답을 CLI 인자로 넘기고 hostActions와 errors를 그대로 돌려준다', async () => {
  const s = store(STATUS)
  const hostActions = [{ kind: 'send-to-worker', workerId: 'wkr-1', text: '머지 승인됨' }]
  writeFileSync(
    join(s.dir, 'fake-resolve.json'),
    JSON.stringify({ gate: { id: 'gate-1' }, hostActions, errors: ['jira 전이 실패'] })
  )
  await run(s, host(s.dir), async (worker) => {
    const out = await worker.request('gate.resolve', {
      gateId: 'gate-1',
      decision: 'approve',
      answer: '--reject'
  })
  assert.deepEqual(out, {
    ok: true,
    gateId: 'gate-1',
    decision: 'approve',
    hostActions,
    deferred: false,
    errors: ['jira 전이 실패']
  })
  const resolve = s.calls().find((c) => c.args[1] === 'gate')!
  assert.deepEqual(resolve.args, [
    'conductor',
    'gate',
    'resolve',
    'gate-1',
    '--approve',
    '--answer=--reject',
    '--defer-delivery',
    '--json',
    `--state-dir=${s.dir}`
  ])
  })
})

test('gate.resolve는 CLI가 전달을 tick에 넘겼다고 하면 deferred를 돌려준다', async () => {
  const s = store(STATUS)
  writeFileSync(
    join(s.dir, 'fake-resolve.json'),
    JSON.stringify({ gate: { id: 'gate-1', deliveryPending: true }, hostActions: [], errors: [], deferred: true })
  )
  await run(s, host(s.dir), async (worker) => {
    const out = await worker.request('gate.resolve', { gateId: 'gate-1', decision: 'reject' })
    assert.equal(out.ok, true)
    assert.equal(out.deferred, true)
    assert.deepEqual(out.hostActions, [])
  })
})

test('gate.resolve는 옛 CLI가 전달 미루기 플래그를 모르면 플래그 없이 한 번만 다시 부른다', async () => {
  const s = store(STATUS)
  const hostActions = [{ type: 'send', workerId: 'wkr-1', message: '거절됨' }]
  writeFileSync(join(s.dir, 'fake-no-defer'), '')
  writeFileSync(join(s.dir, 'fake-resolve.json'), JSON.stringify({ gate: { id: 'gate-1' }, hostActions, errors: [] }))
  await run(s, host(s.dir), async (worker) => {
    const out = await worker.request('gate.resolve', { gateId: 'gate-1', decision: 'reject' })
    assert.equal(out.ok, true)
    assert.equal(out.deferred, false)
    assert.deepEqual(out.hostActions, hostActions, '옛 CLI에서는 hostActions를 그대로 보여 준다')
    const calls = s.calls().filter((c) => c.args[1] === 'gate')
    assert.equal(calls.length, 2)
    assert.equal(calls[0]!.args.includes('--defer-delivery'), true)
    assert.equal(calls[1]!.args.includes('--defer-delivery'), false)
  })
})

test('gate.resolve는 옵션처럼 읽히는 게이트 id를 CLI에 넘기지 않는다', async () => {
  const s = store(STATUS)
  await run(s, host(s.dir), async (worker) => {
    const out = await worker.request('gate.resolve', { gateId: '--all', decision: 'reject' })
    assert.equal(out.ok, false)
    assert.equal(
      s.calls().some((c) => c.args[1] === 'gate'),
      false
    )
  })
})

test('order.remove는 겹친 id를 한 번만 넘기고 지운 주문과 남긴 이유를 돌려준다', async () => {
  const s = store(STATUS)
  writeFileSync(
    join(s.dir, 'fake-remove.json'),
    JSON.stringify({ removed: ['ord-b'], skipped: [{ id: 'ord-a', reason: '끝난 주문만 지울 수 있어요: ord-a(running)' }] })
  )
  await run(s, host(s.dir), async (worker) => {
    const out = await worker.request('order.remove', { orderIds: ['ord-b', 'ord-a', 'ord-b'] })
    assert.deepEqual(out, {
      ok: true,
      removed: ['ord-b'],
      skipped: [{ id: 'ord-a', reason: '끝난 주문만 지울 수 있어요: ord-a(running)' }]
    })
    const remove = s.calls().find((c) => c.args[1] === 'order')!
    assert.deepEqual(remove.args, ['conductor', 'order', 'remove', 'ord-b', 'ord-a', '--json', `--state-dir=${s.dir}`])
  })
})

test('order.remove는 빈 목록이나 옵션처럼 읽히는 id, 너무 많은 id를 CLI에 넘기지 않는다', async () => {
  const s = store(STATUS)
  await run(s, host(s.dir), async (worker) => {
    for (const orderIds of [[], ['--all'], ['ord-a', 'a b'], Array.from({ length: 201 }, (_, i) => `ord-${i}`)]) {
      const out = await worker.request('order.remove', { orderIds })
      assert.equal(out.ok, false, JSON.stringify(orderIds).slice(0, 40))
    }
    assert.equal(
      s.calls().some((c) => c.args[1] === 'order'),
      false
    )
  })
})

test('order.remove는 CLI가 하나도 못 지우면 stderr의 이유를 돌려준다', async () => {
  const s = store(STATUS)
  await run(s, host(s.dir), async (worker) => {
    writeFileSync(join(s.dir, 'fake-fail'), '열린 게이트가 있어서 못 지워요: ord-a\n')
    const out = await worker.request('order.remove', { orderIds: ['ord-a'] })
    assert.equal(out.ok, false)
    assert.match(out.error ?? '', /열린 게이트가 있어서 못 지워요/)
  })
})

test('order.remove는 CLI가 하나도 못 지우면 stdout에 남긴 주문별 이유를 돌려준다', async () => {
  const s = store(STATUS)
  await run(s, host(s.dir), async (worker) => {
    const skipped = Array.from({ length: 7 }, (_, i) => ({ id: `ord-${i}`, reason: `열린 게이트가 있어서 못 지워요: ord-${i}` }))
    writeFileSync(join(s.dir, 'fake-fail-stdout.json'), JSON.stringify({ removed: [], skipped }))
    writeFileSync(join(s.dir, 'fake-fail'), skipped.map((x) => x.reason).join('\n') + '\n')
    const out = await worker.request('order.remove', { orderIds: skipped.map((x) => x.id) })
    assert.equal(out.ok, false)
    assert.deepEqual(out.skipped, skipped, 'stderr 끝 몇 줄이 아니라 주문마다 이유를 다 받는다')
  })
})

test('CLI 실패 이유가 길면 잘랐다고 알린다', async () => {
  const s = store(STATUS)
  await run(s, host(s.dir), async (worker) => {
    writeFileSync(join(s.dir, 'fake-fail'), Array.from({ length: 7 }, (_, i) => `줄 ${i}`).join('\n') + '\n')
    const out = await worker.request('order.remove', { orderIds: ['ord-a'] })
    assert.match(out.error ?? '', /^…\(앞 2줄 생략\)\n줄 2\n/)
    assert.match(out.error ?? '', /줄 6$/)
  })
})

test('겹쳐 들어온 새로고침은 한 번 더 읽는 것으로 합친다', async () => {
  const s = store(STATUS)
  await run(s, host(s.dir), async (worker) => {
    await worker.request('conductor.status')
    const before = s.calls().filter((c) => c.args[1] === 'status').length
    await Promise.all([
      worker.request('conductor.refresh'),
      worker.request('conductor.refresh'),
      worker.request('conductor.refresh')
    ])
    const after = s.calls().filter((c) => c.args[1] === 'status').length
    assert.equal(after - before, 2, '처음 하나와 그사이 들어온 요청을 합친 하나')
  })
})

test('events.jsonl에 연달아 쓰면 디바운스로 한 번만 다시 읽는다', async () => {
  const s = store(STATUS)
  await run(s, host(s.dir), async (worker) => {
    await worker.request('conductor.status')
    await new Promise((r) => setTimeout(r, 400))
    const before = s.calls().filter((c) => c.args[1] === 'status').length
    for (let i = 0; i < 5; i++) {
      appendFileSync(join(s.dir, 'events.jsonl'), `{"n":${i}}\n`)
      await new Promise((r) => setTimeout(r, 20))
    }
    await new Promise((r) => setTimeout(r, 900))
    const after = s.calls().filter((c) => c.args[1] === 'status').length
    assert.equal(after - before, 1)
  })
})

test('worker.open은 주문의 워크트리를 찾아 연다', async () => {
  const s = store(STATUS)
  const h = host(s.dir)
  await run(s, h, async (worker) => {
    await worker.request('conductor.refresh')
    const opened = await worker.request('worker.open', { orderId: 'ord-a' })
    assert.deepEqual(opened, { opened: true }, JSON.stringify({ opened, refusals: worker.refusals }))
    assert.deepEqual(h.callsOf('workspace.open'), [{ workspaceId: 'ws-a' }])
    const missing = await worker.request('worker.open', { orderId: 'ord-b' })
    assert.equal(missing.opened, false)
  })
})

test('새로고침 명령은 상태 표시줄 문구를 돌려준다', async () => {
  const s = store(STATUS)
  await run(s, host(s.dir), async (worker) => {
    assert.equal(await worker.command('conductor.refresh'), '주문 1 · 확인 대기 1')
  })
})

function getStatus(port: number): Promise<number> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
      res.on('data', () => undefined)
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', () => resolve(0))
    req.end()
  })
}

test('mobilePort를 정하면 보기 전용 페이지를 열고 워커가 내려가면 닫는다', async () => {
  const s = store(STATUS)
  const port = 41000 + Math.floor(Math.random() * 2000)
  const worker = await mountWorker(main, { host: host(s.dir, {}, { mobilePort: port }) })
  try {
    await worker.request('conductor.refresh')
    assert.equal(await getStatus(port), 200)
  } finally {
    await worker.deactivate()
    s.cleanup()
  }
  assert.equal(await getStatus(port), 0)
})
