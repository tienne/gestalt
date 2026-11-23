import { assert, test } from 'orca/testing'
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { mobileFragment, mobilePage, screenOf, shortPr, terminalFragment, terminalPage } from './mobile'
import { allowedHost, MobileServer } from './mobile-server'
import type { ConductorView, OrderView } from './protocol'

const NOW = Date.parse('2026-11-13T03:00:00.000Z')

const order = (id: string, extra: Partial<OrderView> = {}): OrderView => ({
  id,
  status: 'running',
  scope: 'pr',
  repo: 'tienne/web',
  title: id,
  bypasses: [],
  updatedAt: '2026-11-13T02:50:00.000Z',
  ...extra
})

const view = (extra: Partial<ConductorView> = {}): ConductorView => ({
  state: 'ok',
  stateDir: '/s',
  lastTickAt: '2026-11-13T02:59:00.000Z',
  orders: [],
  gates: [],
  unassignedBypasses: [],
  refreshedAt: NOW,
  ...extra
})

const has = (html: string, part: string) => assert.equal(html.includes(part), true, `${part}가 없어요`)
const lacks = (html: string, part: string) => assert.equal(html.includes(part), false, `${part}가 있어요`)

test('지라나 PR에서 온 제목과 사유는 이스케이프해서 그린다', () => {
  const html = mobileFragment(
    view({
      orders: [order('ord-a', { title: '<script>alert(1)</script>' })],
      gates: [{ id: 'g-1', type: 'merge', orderId: 'ord-a', reason: '"><img src=x onerror=alert(1)>' }]
    }),
    NOW
  )
  lacks(html, '<script>')
  lacks(html, '<img')
  has(html, '&lt;script&gt;alert(1)&lt;/script&gt;')
  has(html, '&quot;&gt;&lt;img src=x')
})

test('확인 대기는 맨 위에 모으고 처리는 다른 곳에서 한다고 알린다', () => {
  const html = mobileFragment(
    view({
      orders: [order('ord-a', { title: '결제 버튼' })],
      gates: [{ id: 'g-1', type: 'merge', orderId: 'ord-a', reason: '머지 승인', openedAt: '2026-11-13T02:00:00.000Z' }]
    }),
    NOW
  )
  has(html, '<h2>확인 대기</h2><span class="count">1</span>')
  has(html, '<div class="gate-repo">web</div>')
  has(html, '<div class="gate-title">결제 버튼</div>')
  has(html, '1시간 전')
  has(html, '데스크톱 오르카에서 해요')
  lacks(html, '<button')
  assert.equal(html.indexOf('<h2>확인 대기</h2>') < html.indexOf('<h2>레포</h2>'), true)
})

test('끝난 주문은 접힌 묶음에 최근 것부터 넣고 진행 중인 레포는 펼쳐 둔다', () => {
  const html = mobileFragment(
    view({
      orders: [
        order('ord-live'),
        order('ord-old', { status: 'done', updatedAt: '2026-11-10T00:00:00.000Z' }),
        order('ord-new', { status: 'cancelled', updatedAt: '2026-11-12T00:00:00.000Z' }),
        order('ord-api', { status: 'done', repo: 'tienne/api' })
      ]
    }),
    NOW
  )
  has(html, 'data-key="repo:tienne/web" open')
  has(html, 'data-key="repo:tienne/api">')
  has(html, '끝난 주문 2개')
  assert.equal(html.indexOf('ord-new') < html.indexOf('ord-old'), true)
  const done = html.slice(html.indexOf('data-key="done:tienne/web"'))
  lacks(done.slice(0, done.indexOf('</details>')), 'ord-live')
})

test('레포 이름 옆에 오르카 프로젝트 이름을 붙이고 레포 이름과 같으면 한 번만 쓴다', () => {
  const html = mobileFragment(
    view({
      orders: [order('ord-a'), order('ord-b', { repo: 'tienne/gestalt' })],
      projects: { 'tienne/web': '<웹> 프론트', 'tienne/gestalt': 'Gestalt' }
    }),
    NOW
  )
  has(html, '<span class="project">&lt;웹&gt; 프론트</span>')
  assert.equal(html.split('class="project"').length, 2, '레포 이름과 같은 프로젝트 이름은 안 붙인다')
})

test('PR은 카드가 레포를 알려 주니 번호만 남기고 모르는 꼴은 그대로 둔다', () => {
  assert.equal(shortPr('tienne/web#453'), '#453')
  assert.equal(shortPr('https://github.com/tienne/web/pull/12/'), '#12')
  assert.equal(shortPr('draft'), 'draft')
})

test('CLI 실패 원문과 저장소 경로는 인증 없는 폰 페이지에 싣지 않는다', () => {
  const failed = mobileFragment(view({ state: 'error', error: 'spawn /Users/someone/bin/gestalt ENOENT' }), NOW)
  has(failed, 'gestalt CLI가 실패했어요')
  lacks(failed, '/Users/someone')
  const missing = mobileFragment(view({ state: 'missing', stateDir: '/Users/someone/.gestalt/conductor' }), NOW)
  has(missing, '저장소가 아직 없어요')
  lacks(missing, '/Users/someone')
  has(mobileFragment(null, NOW), '불러오는 중')
})

test('페이지는 본문을 감싸고 같은 주소로 본문만 다시 받아 온다', () => {
  const page = mobilePage('<p>본문</p>')
  has(page, '<main id="main"><p>본문</p></main>')
  has(page, 'name="viewport"')
  has(page, "'x-conductor-fragment': '1'")
})

test('루프백과 테일넷 이름으로 들어온 요청만 받는다', () => {
  assert.equal(allowedHost('127.0.0.1:8792', 8792), true)
  assert.equal(allowedHost('localhost:8792', 8792), true)
  assert.equal(allowedHost('mac.tail1234.ts.net', 8792), true)
  assert.equal(allowedHost('127.0.0.1:9999', 8792), false)
  assert.equal(allowedHost('evil.example.com:8792', 8792), false)
  assert.equal(allowedHost('ts.net.evil.com', 8792), false)
  assert.equal(allowedHost(undefined, 8792), false)
})

type Reply = { status: number; body: string; headers: Record<string, string | string[] | undefined> }

function hit(port: number, opts: { method?: string; headers?: Record<string, string>; path?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: opts.path ?? '/', method: opts.method ?? 'GET', headers: opts.headers },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

test('서버는 GET만 받고 낯선 Host는 막고 헤더에 따라 본문만 돌려준다', async () => {
  const server = new MobileServer(() => view({ orders: [order('ord-a', { title: '보이는 주문' })] }))
  const port = await server.start(0)
  try {
    const page = await hit(port)
    assert.equal(page.status, 200)
    has(page.body, '<!doctype html>')
    has(page.body, '보이는 주문')
    const csp = String(page.headers['content-security-policy'])
    has(csp, "default-src 'none'")
    has(csp, "script-src 'sha256-")
    lacks(csp, "script-src 'unsafe-inline'")
    const scripts = [...page.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
    assert.equal(scripts.length, 1, '페이지의 인라인 스크립트는 하나뿐이다')
    const hash = createHash('sha256').update(scripts[0]!).digest('base64')
    has(csp, `script-src 'sha256-${hash}'`)
    assert.equal(page.headers['cache-control'], 'no-store')

    const fragment = await hit(port, { headers: { 'x-conductor-fragment': '1' } })
    lacks(fragment.body, '<!doctype html>')
    has(fragment.body, '보이는 주문')

    assert.equal((await hit(port, { headers: { host: 'evil.example.com' } })).status, 403)
    assert.equal((await hit(port, { method: 'POST' })).status, 405)
  } finally {
    await server.stop()
  }
  assert.equal(server.listening, null)
})

test('터미널 화면은 경로 대신 쿼리로 가려서 테일스케일 접두사와 끝 슬래시를 몰라도 된다', () => {
  assert.equal(screenOf('/?view=terminal'), 'terminal')
  assert.equal(screenOf('/conductor?view=terminal&x=1'), 'terminal')
  assert.equal(screenOf('/'), 'home')
  assert.equal(screenOf('/terminal'), 'home')
  assert.equal(screenOf(undefined), 'home')
  has(mobilePage('<p>본문</p>'), 'href="?view=terminal"')
  const page = terminalPage('<p>본문</p>')
  has(page, 'href="?"')
  has(page, '<main id="main" class="term"><p>본문</p></main>')
  has(page, "'x-conductor-fragment': '1'")
})

test('웹 터미널은 보기 전용이라 카드 이동이 없고 바깥 글은 이스케이프하며 경로와 CLI 오류 원문을 싣지 않는다', () => {
  const html = terminalFragment(
    view({
      orders: [order('ord-a', { title: '<script>alert(1)</script>', worker: 'w1', workerKind: 'orca-worktree', workspaceId: 'ws-1' })],
      gates: [{ id: 'g-1', type: 'merge', orderId: 'ord-a', reason: '"><img src=x onerror=alert(1)>' }],
      recentEvents: [{ at: '2026-11-13T02:58:00.000Z', type: 'report', orderId: 'ord-a', summary: '<b>끝</b>' }]
    }),
    NOW
  )
  lacks(html, '<script>')
  lacks(html, '<img')
  lacks(html, '<b>끝</b>')
  has(html, '&lt;script&gt;alert(1)&lt;/script&gt;')
  lacks(html, 'data-open')
  lacks(html, 'data-order')
  lacks(html, 'tabindex')
  lacks(html, '<button')
  has(html, 'data-key="ord:ord-a"')
  const failed = terminalFragment(view({ state: 'error', error: 'spawn /Users/someone/bin/gestalt ENOENT' }), NOW)
  has(failed, 'gestalt CLI가 실패했어요')
  lacks(failed, '/Users/someone')
  const missing = terminalFragment(view({ state: 'missing', stateDir: '/Users/someone/.gestalt/conductor' }), NOW)
  has(missing, '저장소가 아직 없어요')
  lacks(missing, '/Users/someone')
})

test('웹 터미널은 워커가 쓴 다음 할 일과 대기 사유, bypass, 보고 요약과 계정 이름을 싣지 않는다', () => {
  const html = terminalFragment(
    view({
      orders: [
        order('ord-a', {
          worker: 'w1',
          workerKind: 'orca-worktree',
          account: 'work-acct',
          checkpoint: { skill: 'ship', phase: 'ci', next: 'cat /Users/someone/.npmrc', completedSkills: [], savedAt: '' },
          waiting: { reason: 'ghp_waitTOKEN 만료', since: '2026-11-13T02:00:00.000Z' },
          bypasses: [{ need: 'cleanup', action: 'rm -rf /Users/someone/tmp', at: '2026-11-13T02:10:00.000Z' }]
        })
      ],
      recentEvents: [
        { at: '2026-11-13T02:20:00.000Z', type: 'report', orderId: 'ord-a', summary: 'done · ghp_reportTOKEN' },
        { at: '2026-11-13T02:21:00.000Z', type: 'waiting', orderId: 'ord-a', summary: '/Users/someone/wait' },
        { at: '2026-11-13T02:22:00.000Z', type: 'bypass', orderId: 'ord-a', summary: 'cleanup · /Users/someone/bypass' }
      ]
    }),
    NOW
  )
  for (const secret of ['/Users/someone', 'TOKEN', 'work-acct']) lacks(html, secret)
  has(html, 'ord-a')
})

test('서버는 ?view=terminal에 터미널 페이지를 같은 규칙으로 돌려준다', async () => {
  const server = new MobileServer(() => view({ orders: [order('ord-a', { title: '터미널 주문' })] }))
  const port = await server.start(0)
  const path = '/?view=terminal'
  try {
    const page = await hit(port, { path })
    assert.equal(page.status, 200)
    has(page.body, '<title>컨덕터 터미널</title>')
    has(page.body, '터미널 주문')
    const scripts = [...page.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
    assert.equal(scripts.length, 1)
    const hash = createHash('sha256').update(scripts[0]!).digest('base64')
    has(String(page.headers['content-security-policy']), `script-src 'sha256-${hash}'`)

    const fragment = await hit(port, { path, headers: { 'x-conductor-fragment': '1' } })
    lacks(fragment.body, '<!doctype html>')
    has(fragment.body, 'GESTALT CONDUCTOR')
    lacks((await hit(port, { headers: { 'x-conductor-fragment': '1' } })).body, 'GESTALT CONDUCTOR')

    assert.equal((await hit(port, { path, headers: { host: 'evil.example.com' } })).status, 403)
    assert.equal((await hit(port, { path, method: 'POST' })).status, 405)
    assert.equal((await hit(port, { path, method: 'HEAD' })).body, '')
  } finally {
    await server.stop()
  }
})

test('배포를 기다리는 merged 주문은 배포 대기로 그리고 값이 없으면 머지됨이다', () => {
  const html = mobileFragment(
    view({
      orders: [
        order('ord-d', { status: 'merged', awaitingDeploy: true }),
        order('ord-e', { status: 'merged' })
      ]
    }),
    NOW
  )
  has(html, 'order tone-accent')
  has(html, '배포 대기')
  has(html, 'order tone-success')
  has(html, '머지됨')
})
