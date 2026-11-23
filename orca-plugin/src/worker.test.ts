// 진짜 gestalt 대신 test/fake-gestalt.mjs를 부른다. 저장소도 임시 폴더라 실제 컨덕터 상태는 건드리지 않는다.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { request } from 'node:http'
import { join } from 'node:path'
import type { ConductorView } from './protocol'
import * as main from './worker'

const FAKE = decodeURIComponent(new URL('../test/fake-gestalt.mjs', import.meta.url).pathname)

type Call = { args: string[]; cwd: string; via: string }

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

type Stored = Parameters<typeof mockHost>[0] extends infer O ? (O extends { storage?: infer S } ? S : never) : never

// 결과 뷰어 미리 띄우기는 따로 시험한다. 다른 테스트의 gestalt 호출 수가 흔들리지 않게 기본은 끈다
function host(dir: string, storage: Stored = {}, extra: Record<string, unknown> = {}) {
  return mockHost({
    settings: { gestaltPath: FAKE, stateDir: dir, viewerOnStart: false, ...extra },
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
    assert.deepEqual(call.args, ['conductor', 'status', '--all', '--json', '--with-activity', `--state-dir=${s.dir}`])
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
    assert.deepEqual(h.data().storage['notifiedGates'], ['gate-1'], '종료된 게이트 id는 지운다')
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

test('order.remove는 지우기 명령이 없는 옛 CLI면 무엇을 바꿀지 알려 준다', async () => {
  const s = store(STATUS)
  await run(s, host(s.dir), async (worker) => {
    writeFileSync(join(s.dir, 'fake-fail'), "error: unknown command 'remove'\n")
    const out = await worker.request('order.remove', { orderIds: ['ord-a'] })
    assert.equal(out.ok, false)
    assert.match(out.error ?? '', /주문 지우기 명령\(conductor order remove\)이 없어요/)
    assert.match(out.error ?? '', /gestalt 실행 파일/)
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

const VIEWER_URL = /^http:\/\/127\.0\.0\.1:\d+$/
const browseCalls = (s: ReturnType<typeof store>) => s.calls().filter((c) => c.args[1] === 'browse')

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('기다리던 상태가 안 됐어요')
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('order.browse는 결과 뷰어를 한 번만 띄우고 작업 내용 탭 주소를 준다', async () => {
  const s = store(STATUS)
  await run(s, host(s.dir), async (worker) => {
    const first = await worker.request('order.browse', { orderId: 'ord-a' })
    assert.equal(first.ok, true)
    const base = first.ok ? first.url.replace(/\/#order\/ord-a\/work$/, '') : ''
    assert.match(base, VIEWER_URL)
    const second = await worker.request('order.browse', { orderId: 'ord-b' })
    assert.deepEqual(second, { ok: true, url: `${base}/#order/ord-b/work` })
    const browse = browseCalls(s)
    assert.equal(browse.length, 1)
    assert.deepEqual(browse[0]!.args, ['conductor', 'browse', '--no-open', `--state-dir=${s.dir}`])
    const bad = await worker.request('order.browse', { orderId: '--all' })
    assert.equal(bad.ok, false)
  })
})

test('결과 페이지 열기는 떠 있는 뷰어를 다시 쓰고 작업 내용 보기와 같은 뷰어를 쓴다', async () => {
  const s = store(STATUS)
  const h = host(s.dir)
  await run(s, h, async (worker) => {
    const first = await worker.request('viewer.open')
    assert.equal(first.ok, true)
    const url = first.ok ? first.url : ''
    assert.match(url, VIEWER_URL)
    assert.deepEqual(await worker.request('viewer.open'), { ok: true, url })
    const work = await worker.request('order.browse', { orderId: 'ord-a' })
    assert.deepEqual(work, { ok: true, url: `${url}/#order/ord-a/work` })
    assert.equal(browseCalls(s).length, 1)
    const rec = h.data().storage['resultsViewer'] as { pid: number; url: string }
    assert.equal(rec.url, url, '다음 워커가 이어받게 뷰어 주소를 남긴다')
    assert.equal(pidAlive(rec.pid), true)
  })
})

test('워커가 내려가면 띄운 결과 뷰어를 끄고 기록을 지운다', async () => {
  const s = store(STATUS)
  const h = host(s.dir)
  const worker = await mountWorker(main, { host: h })
  let pid = 0
  try {
    const out = await worker.request('viewer.open')
    assert.equal(out.ok, true)
    pid = (h.data().storage['resultsViewer'] as { pid: number }).pid
  } finally {
    await worker.deactivate()
  }
  try {
    await until(() => !pidAlive(pid))
    assert.equal(h.data().storage['resultsViewer'], undefined)
  } finally {
    s.cleanup()
  }
})

test('지난 워커가 남긴 결과 뷰어가 살아 있으면 새로 띄우지 않고 이어받는다', async () => {
  const s = store(STATUS)
  // 워커가 비정상으로 죽어 고아로 남은 뷰어를 흉내 낸다
  const orphan = spawn(process.execPath, [FAKE, 'conductor', 'browse', '--no-open', `--state-dir=${s.dir}`], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  try {
    const url = await new Promise<string>((resolve) => {
      let out = ''
      orphan.stdout?.on('data', (d) => {
        out += d.toString()
        const m = /http:\/\/127\.0\.0\.1:\d+/.exec(out)
        if (m) resolve(m[0])
      })
    })
    const before = browseCalls(s).length
    const h = host(s.dir, { resultsViewer: { pid: orphan.pid!, url, key: JSON.stringify([FAKE, s.dir]) } })
    await run(s, h, async (worker) => {
      assert.deepEqual(await worker.request('viewer.open'), { ok: true, url })
      assert.equal(browseCalls(s).length, before, '같은 저장소에 뷰어를 하나 더 띄우지 않는다')
    })
    await until(() => orphan.exitCode !== null || orphan.signalCode !== null)
  } finally {
    orphan.kill()
  }
})

test('남은 뷰어 기록의 프로세스가 없으면 새로 띄우고 기록을 바꾼다', async () => {
  const s = store(STATUS)
  const h = host(s.dir, { resultsViewer: { pid: 999_999, url: 'http://127.0.0.1:1', key: JSON.stringify([FAKE, s.dir]) } })
  await run(s, h, async (worker) => {
    const out = await worker.request('viewer.open')
    assert.equal(out.ok, true)
    assert.equal(browseCalls(s).length, 1)
    const rec = h.data().storage['resultsViewer'] as { pid: number; url: string }
    assert.notEqual(rec.pid, 999_999)
    assert.equal(out.ok && rec.url === out.url, true)
  })
})

/** 고아로 남은 프로세스를 흉내 낸다. 찍은 주소를 받을 때까지 기다린다 */
async function orphanOf(args: string[]) {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'ignore'] })
  const url = await new Promise<string>((resolve, reject) => {
    let out = ''
    child.stdout?.on('data', (d) => {
      out += d.toString()
      const m = /http:\/\/127\.0\.0\.1:\d+/.exec(out)
      if (m) resolve(m[0])
    })
    child.once('exit', (code) => reject(new Error(`주소를 찍기 전에 끝났어요(${String(code)})`)))
  })
  return { child, url }
}

// 첫 화면 HTML만 주고 주문 목록 API는 없는 다른 로컬 서버
const PLAIN_SERVER = `require('node:http').createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>other</p>')
}).listen(0, '127.0.0.1', function () { console.log('http://127.0.0.1:' + this.address().port) })`

test('설정이 바뀐 뒤의 기록이 실제 결과 뷰어면 그 뷰어를 끄고 새로 띄운다', async () => {
  const s = store(STATUS)
  const orphan = await orphanOf([FAKE, 'conductor', 'browse', '--no-open', `--state-dir=${s.dir}`])
  try {
    const before = browseCalls(s).length
    const h = host(s.dir, { resultsViewer: { pid: orphan.child.pid!, url: orphan.url, key: JSON.stringify([FAKE, '/elsewhere']) } })
    await run(s, h, async (worker) => {
      const out = await worker.request('viewer.open')
      assert.equal(out.ok, true)
      assert.notEqual(out.ok ? out.url : '', orphan.url)
      assert.equal(browseCalls(s).length, before + 1)
      await until(() => orphan.child.exitCode !== null || orphan.child.signalCode !== null)
    })
  } finally {
    orphan.child.kill()
  }
})

test('저장소 설정이 비고 CLI도 저장소를 못 알려 주면 뷰어를 띄우지도 기록을 건드리지도 않는다', async () => {
  const s = store(STATUS)
  const orphan = await orphanOf([FAKE, 'conductor', 'browse', '--no-open', `--state-dir=${s.dir}`])
  try {
    // 가짜 CLI는 --state-dir 없이는 status에 실패해 저장소를 알려 주지 않는다
    const before = browseCalls(s).length
    const rec = { pid: orphan.child.pid!, url: orphan.url, key: JSON.stringify([FAKE, s.dir]) }
    const h = host('', { resultsViewer: rec })
    await run(s, h, async (worker) => {
      const out = await worker.request('viewer.open')
      assert.equal(out.ok, false)
      assert.match(out.ok ? '' : out.error, /저장소를 아직 몰라요/)
      assert.equal(browseCalls(s).length, before)
      assert.deepEqual(h.data().storage['resultsViewer'], rec)
    })
    assert.equal(pidAlive(orphan.child.pid!), true, '저장소를 모를 때는 남은 뷰어를 끄지 않는다')
  } finally {
    orphan.child.kill()
  }
})

test('기록의 pid가 결과 뷰어가 아닌 서버면 이어받지도 끄지도 않고 기록만 바꾼다', async () => {
  const s = store(STATUS)
  const other = await orphanOf(['-e', PLAIN_SERVER])
  try {
    const pid = other.child.pid!
    const h = host(s.dir, { resultsViewer: { pid, url: other.url, key: JSON.stringify([FAKE, s.dir]) } })
    await run(s, h, async (worker) => {
      const out = await worker.request('viewer.open')
      assert.equal(out.ok, true)
      assert.notEqual(out.ok ? out.url : '', other.url, '다른 서버를 결과 뷰어로 이어받지 않는다')
      assert.equal(browseCalls(s).length, 1)
      const rec = h.data().storage['resultsViewer'] as { pid: number }
      assert.notEqual(rec.pid, pid)
    })
    assert.equal(pidAlive(pid), true, '결과 뷰어가 아닌 프로세스는 끄지 않는다')
  } finally {
    other.child.kill()
  }
})

test('설정이 바뀐 뒤의 기록이 응답 없는 프로세스면 끄지 않는다', async () => {
  const s = store(STATUS)
  const other = await orphanOf(['-e', PLAIN_SERVER])
  try {
    const pid = other.child.pid!
    const h = host(s.dir, { resultsViewer: { pid, url: 'http://127.0.0.1:1', key: JSON.stringify([FAKE, '/elsewhere']) } })
    await run(s, h, async (worker) => {
      assert.equal((await worker.request('viewer.open')).ok, true)
    })
    assert.equal(pidAlive(pid), true)
  } finally {
    other.child.kill()
  }
})

test('결과 뷰어를 못 띄우면 이유를 돌려준다', async () => {
  const s = store(STATUS)
  writeFileSync(join(s.dir, 'fake-browse-fail'), '결과 뷰어를 못 띄웠어요: listen EADDRINUSE 127.0.0.1:7894\n')
  await run(s, host(s.dir), async (worker) => {
    const out = await worker.request('viewer.open')
    assert.equal(out.ok, false)
    assert.match(out.ok ? '' : out.error, /EADDRINUSE/)
  })
})

test('gestalt를 못 찾으면 결과 뷰어 대신 그 이유를 돌려준다', async () => {
  const s = store(STATUS)
  await run(s, host(s.dir, {}, { gestaltPath: join(s.dir, 'no-such-gestalt') }), async (worker) => {
    const out = await worker.request('viewer.open')
    assert.equal(out.ok, false)
    assert.match(out.ok ? '' : out.error, /결과 뷰어를 못 띄웠어요/)
  })
})

test('켜 두면 플러그인이 뜰 때 저장소가 있으면 결과 뷰어를 미리 띄운다', async () => {
  const s = store(STATUS)
  await run(s, host(s.dir, {}, { viewerOnStart: true }), async (worker) => {
    await until(() => browseCalls(s).length === 1)
    const out = await worker.request('viewer.open')
    assert.equal(out.ok, true)
    assert.equal(browseCalls(s).length, 1, '미리 띄운 뷰어를 버튼이 그대로 쓴다')
  })
})

test('저장소가 없으면 결과 뷰어를 미리 띄우지 않는다', async () => {
  const s = store()
  await run(s, host(s.dir, {}, { viewerOnStart: true }), async (worker) => {
    const view = await worker.request('conductor.status')
    assert.equal(view.state, 'missing')
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(browseCalls(s).length, 0)
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
    assert.equal(opened.opened, true, JSON.stringify({ opened, refusals: worker.refusals }))
    assert.equal(opened.worktreeOnly, true, '터미널로는 못 갔으니 워크트리만 열었다고 알린다')
    assert.deepEqual(h.callsOf('workspace.open'), [{ workspaceId: 'ws-a' }])
    const missing = await worker.request('worker.open', { orderId: 'ord-b' })
    assert.equal(missing.opened, false)
  })
})

function liveHost(dir: string, results: Record<string, unknown>, capabilities?: string[]) {
  return mockHost({
    settings: { gestaltPath: FAKE, stateDir: dir },
    ...(capabilities ? { capabilities } : {}),
    results: { 'workspace.list': WORKSPACES, 'workspace.open': { opened: true }, ...results }
  })
}

const AGENTS = {
  agents: [
    { terminalId: 'term-shell', title: 'zsh', agent: null, state: 'done', stateStartedAt: 5 },
    { terminalId: 'term-worker', title: 'ord-a', agent: 'claude', state: 'working', stateStartedAt: 1, task: { title: 'ord-a 검색 문구' } }
  ]
}

test('worker.open은 워커 에이전트의 터미널로 바로 간다', async () => {
  const s = store(STATUS)
  const h = liveHost(s.dir, { 'agents.list': AGENTS, 'terminal.focus': { focused: true } })
  await run(s, h, async (worker) => {
    await worker.request('conductor.refresh')
    assert.deepEqual(await worker.request('worker.open', { orderId: 'ord-a' }), { opened: true })
    assert.deepEqual(h.callsOf('agents.list'), [{ workspaceId: 'ws-a' }])
    assert.deepEqual(h.callsOf('terminal.focus'), [{ terminalId: 'term-worker' }])
    assert.deepEqual(h.callsOf('workspace.open'), [])
  })
})

test('agent:read를 승인하지 않았으면 워크트리 첫 터미널로 가고 그것도 안 되면 워크트리만 연다', async () => {
  const s = store(STATUS)
  const h = liveHost(
    s.dir,
    { 'terminal.list': { terminals: [{ id: 'term-1' }], truncated: false }, 'terminal.focus': { focused: false } },
    ['notifications:show', 'workspace:read', 'workspace:write', 'settings:own', 'storage:own']
  )
  await run(s, h, async (worker) => {
    await worker.request('conductor.refresh')
    assert.deepEqual(await worker.request('worker.open', { orderId: 'ord-a' }), {
      opened: true,
      worktreeOnly: true,
      error: '에이전트 상태를 못 읽었어요(agents.list needs the agent:read capability). 터미널로 못 옮겨 갔어요. 워크트리만 열었어요.'
    })
    assert.deepEqual(h.callsOf('terminal.focus'), [{ terminalId: 'term-1' }])
    assert.deepEqual(h.callsOf('workspace.open'), [{ workspaceId: 'ws-a' }])
  })
})

test('worker.detail은 에이전트 상태와 터미널 마지막 줄을 읽는다', async () => {
  const s = store(STATUS)
  const lines = [...Array.from({ length: 30 }, (_, i) => `line ${i}`), 'x'.repeat(500), '', '  ']
  const h = liveHost(s.dir, { 'agents.list': AGENTS, 'terminal.read': { lines, truncated: false } })
  await run(s, h, async (worker) => {
    await worker.request('conductor.refresh')
    const live = await worker.request('worker.detail', { orderId: 'ord-a' })
    assert.equal(live.found, true)
    assert.deepEqual(live.agent, { kind: 'claude', title: 'ord-a', state: 'working', since: 1, task: 'ord-a 검색 문구' })
    assert.equal(live.terminalId, 'term-worker')
    assert.equal(live.lines?.length, 24)
    assert.equal(live.lines?.[0], 'line 7')
    assert.equal(live.lines?.at(-1), `${'x'.repeat(400)}…`)
    assert.deepEqual(h.callsOf('terminal.read'), [{ terminalId: 'term-worker', maxLines: 80 }])
    assert.equal((await worker.request('worker.detail', { orderId: 'ord-b' })).found, false)
  })
})

test('worker.detail은 터미널을 못 읽어도 읽은 데까지 돌려준다', async () => {
  const s = store(STATUS)
  const h = liveHost(s.dir, { 'agents.list': AGENTS }, ['notifications:show', 'workspace:read', 'workspace:write', 'settings:own', 'storage:own', 'agent:read'])
  await run(s, h, async (worker) => {
    await worker.request('conductor.refresh')
    const live = await worker.request('worker.detail', { orderId: 'ord-a' })
    assert.equal(live.agent?.state, 'working')
    assert.equal(live.lines, undefined)
    assert.match(live.error ?? '', /터미널을 못 읽었어요/)
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

/** has()가 false인 옛 오르카를 흉내 낸다. mockHost는 메서드가 늘 있다고 답해서 따로 만든다 */
function oldHost(methods: string[], results: Record<string, unknown>) {
  const calls: string[] = []
  const host = {
    has: (m: string) => methods.includes(m),
    call: async (m: string) => {
      calls.push(m)
      if (!(m in results)) throw new Error(`${m} 실패`)
      return results[m]
    }
  } as unknown as Parameters<typeof main.workerTerminal>[0]
  return { host, calls }
}

test('workerTerminal은 옛 오르카에 없는 기능을 이유로 남기고 부르지 않는다', async () => {
  const none = oldHost([], {})
  assert.deepEqual(await main.workerTerminal(none.host, 'ws-a', { firstTerminal: true }), {
    fallback: false,
    errors: ['이 오르카는 에이전트 상태를 읽는 기능을 지원하지 않아요.', '이 오르카는 터미널 목록을 읽는 기능을 지원하지 않아요.']
  })
  assert.deepEqual(none.calls, [])

  const listOnly = oldHost(['terminal.list'], { 'terminal.list': { terminals: [{ id: 'term-1' }] } })
  const out = await main.workerTerminal(listOnly.host, 'ws-a', { firstTerminal: true })
  assert.equal(out.terminalId, 'term-1')
  assert.equal(out.fallback, true, '에이전트 없이 고른 첫 터미널은 fallback으로 표시한다')
})

test('workerTerminal은 워크트리에 터미널이 하나도 없으면 그 이유를 남긴다', async () => {
  const h = oldHost(['agents.list', 'terminal.list'], { 'agents.list': { agents: [] }, 'terminal.list': { terminals: [] } })
  assert.deepEqual(await main.workerTerminal(h.host, 'ws-a', { firstTerminal: true }), {
    fallback: false,
    errors: ['워크트리에 열린 터미널이 없어요.']
  })
})

test('workerTerminal은 firstTerminal 없이는 첫 터미널로 물러나지 않는다', async () => {
  const h = oldHost(['agents.list', 'terminal.list'], { 'agents.list': { agents: [] }, 'terminal.list': { terminals: [{ id: 'term-1' }] } })
  assert.deepEqual(await main.workerTerminal(h.host, 'ws-a'), { fallback: false, errors: [] })
  assert.deepEqual(h.calls, ['agents.list'])
})

test('workerTerminal은 에이전트 터미널을 찾으면 터미널 목록을 안 읽는다', async () => {
  const h = oldHost(['agents.list', 'terminal.list'], { 'agents.list': AGENTS, 'terminal.list': { terminals: [{ id: 'term-1' }] } })
  const out = await main.workerTerminal(h.host, 'ws-a')
  assert.equal(out.terminalId, 'term-worker')
  assert.equal(out.fallback, false)
  assert.deepEqual(h.calls, ['agents.list'])
})

test('worker.open은 terminal.focus가 실패하면 그 이유를 싣고 워크트리만 연다', async () => {
  const s = store(STATUS)
  const h = liveHost(s.dir, {
    'agents.list': AGENTS,
    'terminal.focus': () => {
      throw new Error('터미널이 닫혔어요')
    }
  })
  await run(s, h, async (worker) => {
    await worker.request('conductor.refresh')
    const out = await worker.request('worker.open', { orderId: 'ord-a' })
    assert.equal(out.opened, true)
    assert.equal(out.worktreeOnly, true)
    assert.match(out.error ?? '', /터미널로 못 옮겨 갔어요/)
    assert.deepEqual(h.callsOf('workspace.open'), [{ workspaceId: 'ws-a' }])
  })
})

test('worker.detail은 워커 에이전트 터미널을 못 찾으면 다른 터미널의 출력을 안 읽는다', async () => {
  const s = store(STATUS)
  const h = liveHost(s.dir, {
    'agents.list': { agents: [] },
    'terminal.list': { terminals: [{ id: 'term-1' }], truncated: false },
    'terminal.read': { lines: ['$ ls'], truncated: false }
  })
  await run(s, h, async (worker) => {
    await worker.request('conductor.refresh')
    const live = await worker.request('worker.detail', { orderId: 'ord-a' })
    assert.deepEqual(live, { found: true, noWorkerTerminal: true })
    assert.deepEqual(h.callsOf('terminal.list'), [])
    assert.deepEqual(h.callsOf('terminal.read'), [])
  })
})

test('worker.open은 워커 에이전트가 없으면 첫 터미널로 가고 fallbackTerminal로 알린다', async () => {
  const s = store(STATUS)
  const h = liveHost(s.dir, {
    'agents.list': { agents: [] },
    'terminal.list': { terminals: [{ id: 'term-1' }], truncated: false },
    'terminal.focus': { focused: true }
  })
  await run(s, h, async (worker) => {
    await worker.request('conductor.refresh')
    assert.deepEqual(await worker.request('worker.open', { orderId: 'ord-a' }), { opened: true, fallbackTerminal: true })
    assert.deepEqual(h.callsOf('terminal.focus'), [{ terminalId: 'term-1' }])
  })
})

test('agent:read를 승인하지 않아 첫 터미널로 갔으면 그 이유를 fallbackReason에 싣는다', async () => {
  const s = store(STATUS)
  const h = liveHost(
    s.dir,
    { 'terminal.list': { terminals: [{ id: 'term-1' }], truncated: false }, 'terminal.focus': { focused: true } },
    ['notifications:show', 'workspace:read', 'workspace:write', 'settings:own', 'storage:own']
  )
  await run(s, h, async (worker) => {
    await worker.request('conductor.refresh')
    assert.deepEqual(await worker.request('worker.open', { orderId: 'ord-a' }), {
      opened: true,
      fallbackTerminal: true,
      fallbackReason: '에이전트 상태를 못 읽었어요(agents.list needs the agent:read capability).'
    })
  })
})

test('첫 터미널로 가다 terminal.focus가 실패하면 앞의 이유와 함께 싣고 워크트리만 연다', async () => {
  const s = store(STATUS)
  const h = liveHost(
    s.dir,
    {
      'terminal.list': { terminals: [{ id: 'term-1' }], truncated: false },
      'terminal.focus': () => {
        throw new Error('터미널이 닫혔어요')
      }
    },
    ['notifications:show', 'workspace:read', 'workspace:write', 'settings:own', 'storage:own']
  )
  await run(s, h, async (worker) => {
    await worker.request('conductor.refresh')
    assert.deepEqual(await worker.request('worker.open', { orderId: 'ord-a' }), {
      opened: true,
      worktreeOnly: true,
      error: '에이전트 상태를 못 읽었어요(agents.list needs the agent:read capability). 터미널로 못 옮겨 갔어요(터미널이 닫혔어요). 워크트리만 열었어요.'
    })
    assert.deepEqual(h.callsOf('workspace.open'), [{ workspaceId: 'ws-a' }])
  })
})

test('worker.detail은 지난 상태에 워크스페이스가 있으면 workspace.list를 다시 안 부른다', async () => {
  const s = store(STATUS)
  const h = liveHost(s.dir, { 'agents.list': AGENTS, 'terminal.read': { lines: [], truncated: false } })
  await run(s, h, async (worker) => {
    await worker.request('conductor.refresh')
    const before = h.callsOf('workspace.list').length
    await worker.request('worker.detail', { orderId: 'ord-a' })
    await worker.request('worker.detail', { orderId: 'ord-a' })
    assert.equal(h.callsOf('workspace.list').length, before)
  })
})

test('pickAgent는 작업을 받은 것, 도는 것, 최근 것 순으로 고르고 터미널 없는 에이전트는 뺀다', () => {
  const row = (terminalId: string | null, state: 'working' | 'waiting' | 'done', at: number, task?: string) => ({
    terminalId,
    title: null,
    agent: 'claude',
    state,
    stateStartedAt: at,
    ...(task ? { task: { title: task } } : {})
  })
  assert.equal(main.pickAgent([row('t-done', 'done', 9, 'x'), row('t-run', 'working', 1, 'x')])?.terminalId, 't-run')
  assert.equal(main.pickAgent([row('t-idle', 'working', 9), row('t-task', 'waiting', 1, 'x')])?.terminalId, 't-task')
  assert.equal(main.pickAgent([row('t-old', 'working', 1, 'x'), row('t-new', 'working', 5, 'x')])?.terminalId, 't-new')
  assert.equal(main.pickAgent([row(null, 'working', 1, 'x')]), undefined)
})

test('tailLines는 끝의 빈 줄을 걷고 24줄만, 줄당 400자까지 남긴다', () => {
  assert.deepEqual(main.tailLines(['a', 'b', '', '  ']), ['a', 'b'])
  assert.deepEqual(main.tailLines(['', ' ']), [])
  const many = Array.from({ length: 30 }, (_, i) => `l${i}`)
  assert.deepEqual(main.tailLines(many), many.slice(6))
  assert.equal(main.tailLines(['y'.repeat(401)])[0], `${'y'.repeat(400)}…`)
})

test('status는 --with-activity로 부르고 옛 CLI가 모르면 플래그 없이 다시 불러 그 뒤로는 안 붙인다', async () => {
  const s = store(STATUS)
  writeFileSync(join(s.dir, 'fake-no-activity'), '')
  await run(s, host(s.dir), async (worker) => {
    const first = await worker.request('conductor.status', undefined)
    assert.equal(first.state, 'ok')
    await worker.request('conductor.refresh', undefined)
    const calls = s.calls().filter((c) => c.args[1] === 'status')
    assert.equal(calls[0]!.args.includes('--with-activity'), true)
    assert.equal(calls.slice(1).every((c) => !c.args.includes('--with-activity')), true)
  })
})

test('작업 내용을 아는 CLI면 주문에 work를 싣는다', async () => {
  const work = { activity: null, changedFiles: ['a.ts'], tasks: null, subagents: null, recentTools: null, history: null }
  const s = store({ ...STATUS, orders: STATUS.orders.map((o) => ({ ...o, ...work })) })
  await run(s, host(s.dir), async (worker) => {
    const view = await worker.request('conductor.status', undefined)
    assert.deepEqual(view.orders[0]!.work?.changedFiles, ['a.ts'])
    const calls = s.calls().filter((c) => c.args[1] === 'status')
    assert.equal(calls[0]!.args.includes('--with-activity'), true)
  })
})

/** 경로 찾기가 돌려줄 bin. 지울 수 있게 가짜를 저장소 폴더에 복사해 둔다 */
function directBin(s: ReturnType<typeof store>, name: string): string {
  const bin = join(s.dir, name)
  writeFileSync(bin, readFileSync(FAKE, 'utf8'))
  writeFileSync(
    join(s.dir, 'fake-exec-path.json'),
    JSON.stringify({ node: process.execPath, args: [bin], env: {}, version: '0.0.0' })
  )
  return bin
}

const statusCalls = (s: ReturnType<typeof store>) => s.calls().filter((c) => c.args[1] === 'status')
const lookups = (s: ReturnType<typeof store>) => s.calls().filter((c) => c.args[1] === 'exec-path')

test('gestalt 경로는 처음 한 번만 찾고 그 뒤로는 찾은 bin을 node로 바로 부른다', async () => {
  const s = store(STATUS)
  const bin = directBin(s, 'bin-a.mjs')
  await run(s, host(s.dir), async (worker) => {
    await worker.request('conductor.refresh')
    await worker.request('conductor.refresh')
    await worker.request('order.remove', { orderIds: ['ord-a'] })
    assert.equal(lookups(s).length, 1)
    assert.equal(realpathSync(lookups(s)[0]!.cwd), s.dir, '경로 찾기도 워커 워크트리 밖에서 부른다')
    const others = s.calls().filter((c) => c.args[1] !== 'exec-path')
    assert.equal(others.length >= 3, true)
    assert.deepEqual(new Set(others.map((c) => c.via)), new Set([bin]), '설정한 명령(런처)을 다시 타지 않는다')
    assert.deepEqual(statusCalls(s).at(-1)!.args, ['conductor', 'status', '--all', '--json', '--with-activity', `--state-dir=${s.dir}`])
  })
})

test('찾아 둔 bin이 사라지면 다시 찾는다', async () => {
  const s = store(STATUS)
  const first = directBin(s, 'bin-a.mjs')
  await run(s, host(s.dir), async (worker) => {
    await worker.request('conductor.refresh')
    assert.equal(statusCalls(s).at(-1)!.via, first)
    const second = directBin(s, 'bin-b.mjs')
    rmSync(first)
    const view = await worker.request('conductor.refresh')
    assert.equal(view.state, 'ok')
    assert.equal(lookups(s).length, 2)
    assert.equal(statusCalls(s).at(-1)!.via, second)
  })
})

test('경로를 못 찾으면 설정한 명령을 그대로 부르고 매번 다시 찾지 않는다', async () => {
  const s = store(STATUS)
  await run(s, host(s.dir), async (worker) => {
    const view = await worker.request('conductor.refresh')
    assert.equal(view.state, 'ok')
    await worker.request('conductor.refresh')
    assert.equal(lookups(s).length, 1)
    assert.equal(statusCalls(s).every((c) => c.via === FAKE), true)
  })
})

test('경로 찾기가 엉뚱한 답을 주면 설정한 명령으로 돌아간다', async () => {
  const s = store(STATUS)
  writeFileSync(
    join(s.dir, 'fake-exec-path.json'),
    JSON.stringify({ node: process.execPath, args: [join(s.dir, 'nope.mjs')], env: {}, version: '0.0.0' })
  )
  await run(s, host(s.dir), async (worker) => {
    const view = await worker.request('conductor.refresh')
    assert.equal(view.state, 'ok')
    assert.equal(statusCalls(s).at(-1)!.via, FAKE)
  })
})

test('결과 뷰어도 찾아 둔 bin으로 띄운다', async () => {
  const s = store(STATUS)
  const bin = directBin(s, 'bin-a.mjs')
  await run(s, host(s.dir), async (worker) => {
    const out = await worker.request('order.browse', { orderId: 'ord-a' })
    assert.equal(out.ok, true)
    assert.equal(s.calls().find((c) => c.args[1] === 'browse')!.via, bin)
  })
})

test('gate resolve도 찾아 둔 bin으로 부른다', async () => {
  const s = store(STATUS)
  const bin = directBin(s, 'bin-a.mjs')
  writeFileSync(join(s.dir, 'fake-resolve.json'), JSON.stringify({ gate: { id: 'gate-1' }, hostActions: [], errors: [] }))
  await run(s, host(s.dir), async (worker) => {
    const out = await worker.request('gate.resolve', { gateId: 'gate-1', decision: 'approve' })
    assert.equal(out.ok, true)
    assert.equal(s.calls().find((c) => c.args[1] === 'gate')!.via, bin)
  })
})

test('결과 뷰어를 동시에 두 번 열어도 하나만 띄운다', async () => {
  const s = store(STATUS)
  directBin(s, 'bin-a.mjs')
  await run(s, host(s.dir), async (worker) => {
    const [a, b] = await Promise.all([
      worker.request('order.browse', { orderId: 'ord-a' }),
      worker.request('order.browse', { orderId: 'ord-a' })
    ])
    assert.equal(a.ok && b.ok, true)
    assert.equal(s.calls().filter((c) => c.args[1] === 'browse').length, 1)
  })
})

test('conductor.open은 컨덕터 세션 id와 같은 에이전트의 터미널로 간다', async () => {
  const s = store({ ...STATUS, conductor: { session: { id: 'sess-1', cwd: '/w/ord-a-2/sub' } } })
  const agents = {
    agents: [
      { terminalId: 'term-other', title: 'x', agent: 'claude', state: 'working', stateStartedAt: 1, sessionId: 'sess-2' },
      { terminalId: 'term-conductor', title: 'c', agent: 'claude', state: 'waiting', stateStartedAt: 2, sessionId: 'sess-1' }
    ]
  }
  const h = liveHost(s.dir, { 'agents.list': agents, 'terminal.focus': { focused: true } })
  await run(s, h, async (worker) => {
    await worker.request('conductor.refresh')
    assert.deepEqual(await worker.request('conductor.open'), { opened: true })
    assert.deepEqual(h.callsOf('agents.list'), [{ workspaceId: 'ws-a' }], '세션 폴더를 품은 가장 깊은 워크스페이스를 고른다')
    assert.deepEqual(h.callsOf('terminal.focus'), [{ terminalId: 'term-conductor' }])
  })
})

test('conductor.open은 세션 터미널을 못 찾으면 다른 터미널로 가지 않고 워크스페이스만 연다', async () => {
  const s = store({ ...STATUS, conductor: { session: { id: 'sess-1', cwd: '/w/ord-a-2' } } })
  const h = liveHost(s.dir, { 'agents.list': AGENTS, 'terminal.focus': { focused: true } })
  await run(s, h, async (worker) => {
    await worker.request('conductor.refresh')
    const out = await worker.request('conductor.open')
    assert.equal(out.opened, true)
    assert.equal(out.worktreeOnly, true)
    assert.deepEqual(h.callsOf('terminal.focus'), [])
    assert.deepEqual(h.callsOf('workspace.open'), [{ workspaceId: 'ws-a' }])
  })
})

test('conductor.open은 세션이 없거나 폴더가 워크스페이스 밖이면 열지 않는다', async () => {
  const none = store(STATUS)
  await run(none, liveHost(none.dir, {}), async (worker) => {
    await worker.request('conductor.refresh')
    assert.equal((await worker.request('conductor.open')).opened, false)
  })
  const outside = store({ ...STATUS, conductor: { session: { id: 'sess-1', cwd: '/elsewhere' } } })
  const h = liveHost(outside.dir, {})
  await run(outside, h, async (worker) => {
    await worker.request('conductor.refresh')
    assert.equal((await worker.request('conductor.open')).opened, false)
    assert.deepEqual(h.callsOf('workspace.open'), [])
  })
})
