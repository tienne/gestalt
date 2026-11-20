import { assert, test } from 'orca/testing'
import type { ConductorView, OrderView } from './protocol'
import { terminalMarkup } from './terminal-markup'

const NOW = Date.parse('2026-11-12T02:00:00.000Z')
const order = (id: string, extra: Partial<OrderView> = {}): OrderView => ({
  id,
  status: 'running',
  scope: 'pr',
  repo: 'acme/web',
  title: id,
  bypasses: [],
  worker: `w-${id}`,
  workerKind: 'orca-worktree',
  ...extra
})
const view = (orders: OrderView[], extra: Partial<ConductorView> = {}): ConductorView => ({
  state: 'ok',
  stateDir: '/Users/someone/.gestalt/conductor',
  lastTickAt: '2026-11-12T01:58:00.000Z',
  orders,
  gates: [],
  unassignedBypasses: [],
  refreshedAt: NOW,
  ...extra
})
const has = (html: string, part: string) => assert.equal(html.includes(part), true, `${part}가 없어요`)
const lacks = (html: string, part: string) => assert.equal(html.includes(part), false, `${part}가 있어요`)

test('에디터와 패널에서는 워크트리를 찾은 카드만 두 번 눌러 열 수 있다', () => {
  const html = terminalMarkup(view([order('ord-a', { workspaceId: 'ws-1' }), order('ord-b')]), {
    now: NOW,
    interactive: true,
    private: true
  })
  has(html, 'data-order="ord-a" data-focus="card:ord-a" tabindex="0" role="group" aria-label="ord-a ord-a" data-open aria-keyshortcuts="Enter"')
  has(html, 'data-order="ord-b" data-focus="card:ord-b" tabindex="0" role="group" aria-label="ord-b ord-b">')
})

test('바깥 글은 제목과 게이트 사유, 이벤트 요약, 속성값까지 이스케이프한다', () => {
  const html = terminalMarkup(
    view([order('ord-"a', { title: '<img src=x onerror=alert(1)>', workspaceId: 'ws' })], {
      gates: [{ id: 'g', type: 'merge', orderId: 'ord-"a', reason: '"><script>x</script>' }],
      recentEvents: [{ at: '2026-11-12T01:00:00.000Z', type: 'report', summary: '<b>끝</b>' }]
    }),
    { now: NOW, interactive: true, private: true }
  )
  lacks(html, '<img')
  lacks(html, '<script>')
  lacks(html, '<b>끝</b>')
  has(html, 'data-order="ord-&quot;a"')
  has(html, 'aria-label="ord-&quot;a &lt;img src=x onerror=alert(1)&gt;"')
  has(html, 'title="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"')
})

test('데스크톱 화면은 저장소 경로와 CLI 오류 원문을 그대로 보여 준다', () => {
  has(terminalMarkup(view([], { state: 'missing' }), { now: NOW, interactive: true, private: true }), '/Users/someone/.gestalt/conductor')
  has(terminalMarkup(view([], { state: 'error', error: 'spawn ENOENT' }), { now: NOW, interactive: true, private: true }), 'spawn ENOENT')
  has(terminalMarkup(null, { now: NOW, interactive: true, private: true, loadError: 'timeout' }), '워커에 못 닿았어요. timeout')
})

test('펼친 카드는 데스크톱에서 워커 터미널을 이스케이프해 붙이고 이동 버튼을 단다', () => {
  const o = order('ord-a', {
    workspaceId: 'ws-1',
    worktreePath: '/Users/someone/w/ord-a',
    branch: 'ord-a',
    checkpoint: { skill: 'ship', phase: 'ci', round: 2, next: 'CI 기다리기', completedSkills: [], savedAt: '2026-11-12T01:50:00.000Z' }
  })
  const html = terminalMarkup(view([o]), {
    now: NOW,
    interactive: true,
    private: true,
    open: new Set(['ord-a']),
    live: {
      'ord-a': {
        found: true,
        terminalId: 't-1',
        agent: { kind: 'claude', title: null, state: 'working', since: NOW - 90_000, task: '<b>문구</b>' },
        lines: ['$ pnpm test', '<script>x</script>']
      }
    }
  })
  has(html, '<details class="more" data-key="ord:ord-a" open><summary data-focus="sum:ord-a">상세</summary>')
  has(html, 'ship → ci r2')
  has(html, '/Users/someone/w/ord-a')
  has(html, 'claude · 작업 중')
  has(html, '&lt;b&gt;문구&lt;/b&gt;')
  has(html, '<pre class="tail" data-tail="ord-a">$ pnpm test\n&lt;script&gt;x&lt;/script&gt;</pre>')
  has(html, '<button class="go" data-go="ord-a" data-focus="go:ord-a">터미널로 이동</button>')
  lacks(html, '<script>')
})

test('웹 페이지의 상세는 컨덕터가 아는 것만 싣고 터미널과 버튼, 경로가 없다', () => {
  const o = order('ord-a', { workspaceId: 'ws-1', worktreePath: '/Users/someone/w/ord-a', branch: 'ord-a' })
  const html = terminalMarkup(view([o]), {
    now: NOW,
    interactive: false,
    private: false,
    live: { 'ord-a': { found: true, terminalId: 't-1', lines: ['secret-token'] } }
  })
  has(html, '<details class="more" data-key="ord:ord-a"><summary data-focus="sum:ord-a">상세</summary>')
  has(html, 'ord-a')
  lacks(html, 'secret-token')
  lacks(html, '<button')
  lacks(html, '/Users/someone')
})

test('웹 페이지는 워커가 쓴 다음 할 일과 대기 사유, bypass, 이벤트 요약을 싣지 않는다', () => {
  const o = order('ord-a', {
    account: 'work-acct',
    checkpoint: { skill: 'ship', phase: 'ci', next: 'cat /Users/someone/.npmrc', completedSkills: [] },
    waiting: { reason: 'ghp_waitTOKEN 만료', since: '2026-11-12T01:00:00.000Z', until: '2026-11-12T03:00:00.000Z' },
    bypasses: [{ need: 'cleanup', action: 'rm -rf /Users/someone/tmp', at: '2026-11-12T01:10:00.000Z' }]
  })
  const v = view([o], {
    recentEvents: [
      { at: '2026-11-12T01:20:00.000Z', type: 'report', orderId: 'ord-a', summary: 'done · ghp_reportTOKEN' },
      { at: '2026-11-12T01:21:00.000Z', type: 'waiting', orderId: 'ord-a', summary: '/Users/someone/wait' },
      { at: '2026-11-12T01:22:00.000Z', type: 'bypass', orderId: 'ord-a', summary: 'cleanup · /Users/someone/bypass' },
      { at: '2026-11-12T01:23:00.000Z', type: 'checkpoint', orderId: 'ord-a', summary: 'ship → ci' }
    ]
  })
  const web = terminalMarkup(v, { now: NOW, interactive: false, private: false })
  for (const secret of ['/Users/someone', 'TOKEN', 'work-acct', 'next ›', 'bypass ›']) lacks(web, secret)
  has(web, 'ship → ci')
  has(web, '대기 ~')

  const desk = terminalMarkup(v, { now: NOW, interactive: true, private: true })
  for (const shown of ['cat /Users/someone/.npmrc', 'ghp_waitTOKEN', 'acct work-acct', 'ghp_reportTOKEN', 'rm -rf /Users/someone/tmp']) has(desk, shown)
})

test('모르는 이벤트 유형은 Object 원형에서 클래스나 이름을 꺼내지 않는다', () => {
  const html = terminalMarkup(
    view([], { recentEvents: [{ at: '2026-11-12T01:00:00.000Z', type: 'constructor' as 'report', summary: 'x' }] }),
    { now: NOW, interactive: true, private: true }
  )
  lacks(html, 'function')
  has(html, '<span>constructor</span>')
})

test('워커 에이전트 터미널을 못 찾은 상세는 출력 대신 안내를 싣고 이동 안내는 따로 띄운다', () => {
  const html = terminalMarkup(view([order('ord-a', { workspaceId: 'ws-1' })]), {
    now: NOW,
    interactive: true,
    private: true,
    openNote: '워크트리만 열었어요.',
    open: new Set(['ord-a']),
    live: { 'ord-a': { found: true, noWorkerTerminal: true } }
  })
  has(html, '터미널을 못 찾아 출력은 안 보여 줘요')
  has(html, '첫 터미널로 가고 터미널이 없으면 워크트리만 열어요')
  has(html, '>터미널로 이동</button>')
  lacks(html, 'class="tail"')
  has(html, '<div class="alert">워크트리만 열었어요.</div>')
  lacks(html, '워크트리를 못 열었어요')
})

test('주문은 있는데 새 필드가 하나도 없으면 CLI를 올리라고 알린다', () => {
  has(terminalMarkup(view([order('ord-a')], { terminalFieldsMissing: true }), { now: NOW, interactive: true, private: true }), 'gestalt CLI가 낡아')
  lacks(terminalMarkup(view([order('ord-a')]), { now: NOW, interactive: true, private: true }), 'gestalt CLI가 낡아')
})
