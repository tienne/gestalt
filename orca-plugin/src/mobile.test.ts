import { assert, test } from 'orca/testing'
import { request } from 'node:http'
import { mobileFragment, mobilePage } from './mobile'
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
  has(html, '<h2>확인 대기 1</h2>')
  has(html, 'web / 결제 버튼')
  has(html, '1시간 전')
  has(html, '데스크톱 오르카에서 해요')
  lacks(html, '<button')
  assert.equal(html.indexOf('확인 대기 1</h2>') < html.indexOf('<h2>레포</h2>'), true)
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

test('CLI가 실패하면 이유를 보여 주고 저장소가 없으면 그 폴더를 알려 준다', () => {
  has(mobileFragment(view({ state: 'error', error: 'spawn gestalt ENOENT' }), NOW), 'spawn gestalt ENOENT')
  has(mobileFragment(view({ state: 'missing', stateDir: '/tmp/<x>' }), NOW), '/tmp/&lt;x&gt;에 events.jsonl')
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

function hit(port: number, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/', method: opts.method ?? 'GET', headers: opts.headers },
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
    has(String(page.headers['content-security-policy']), "default-src 'none'")
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
