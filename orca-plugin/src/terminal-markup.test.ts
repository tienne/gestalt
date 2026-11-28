import { assert, test } from 'orca/testing'
import type { ConductorView, OrderView } from './protocol'
import { STATUS_COLORS } from './palette'
import { TERMINAL_STYLE, terminalMarkup } from './terminal-markup'

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

test('데스크톱 카드의 PR을 누르면 전체 URL을 열거나 복사할 수 있다', () => {
  const v = view([
    order('ord-a', { pr: 'acme/web#12' }),
    order('ord-b', { pr: 'https://github.com/acme/api/pull/34' }),
    order('ord-c', { pr: 'https://example.com/acme/api/pull/56' })
  ])
  const opts = { now: NOW, interactive: true, private: true }
  const html = terminalMarkup(v, opts)
  has(html, 'popovertarget="pr:ord-a"')
  has(html, 'id="pr:ord-a" popover')
  has(html, 'data-open-link="https://github.com/acme/web/pull/12"')
  has(html, 'data-copy="https://github.com/acme/web/pull/12"')
  has(html, 'data-open-link="https://github.com/acme/api/pull/34"')
  lacks(html, 'popovertarget="pr:ord-c"')
  const mobile = terminalMarkup(v, { ...opts, interactive: false, private: false })
  has(mobile, 'acme/web#12')
  lacks(mobile, 'popovertarget')
})

test('티켓과 PR이 함께 있는 카드에서 각각의 링크를 열거나 복사할 수 있다', () => {
  const orders = [
    order('ord-a', { issue: 'PROJ-42', pr: 'acme/web#12' }),
    order('ord-b', { issue: 'https://example.com' })
  ]
  const jiraSiteUrl = 'https://team.atlassian.net'
  const v = view(orders, { jiraSiteUrl })
  const opts = { now: NOW, interactive: true, private: true }
  const html = terminalMarkup(v, opts)
  has(html, 'popovertarget="issue:ord-a"')
  has(html, 'popovertarget="pr:ord-a"')
  has(html, `data-open-link="${jiraSiteUrl}/browse/PROJ-42"`)
  has(html, `data-copy="${jiraSiteUrl}/browse/PROJ-42"`)
  lacks(html, 'popovertarget="issue:ord-b"')
  lacks(terminalMarkup(view(orders), opts), 'popovertarget="issue:ord-a"')
  lacks(terminalMarkup(v, { ...opts, interactive: false, private: false }), jiraSiteUrl)
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
  has(html, '>&quot;&gt;&lt;script&gt;x&lt;/script&gt;</div>')
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
    checkpoint: { skill: 'ship', phase: 'ci', next: 'cat /Users/someone/.npmrc', completedSkills: [], savedAt: '' },
    bypasses: [{ need: 'cleanup', action: 'rm -rf /Users/someone/tmp', at: '2026-11-12T01:10:00.000Z' }]
  })
  // 대기 사유가 있으면 대기 칸의 줄로 간다
  const waiting = order('ord-w', { waiting: { reason: 'ghp_waitTOKEN 만료', since: '2026-11-12T01:00:00.000Z', until: '2026-11-12T03:00:00.000Z' } })
  const v = view([o, waiting], {
    // 게이트 사유는 워커가 넘긴 detail로 만들어 경로나 토큰이 섞일 수 있다
    gates: [{ id: 'gx', type: 'merge', orderId: 'ord-a', reason: 'ghp_gateTOKEN · /Users/someone/gate', openedAt: '2026-11-12T01:30:00.000Z' }],
    recentEvents: [
      { at: '2026-11-12T01:19:00.000Z', type: 'gate-opened', orderId: 'ord-a', summary: 'merge · ghp_gateTOKEN' },
      { at: '2026-11-12T01:20:00.000Z', type: 'report', orderId: 'ord-a', summary: 'done · ghp_reportTOKEN' },
      { at: '2026-11-12T01:21:00.000Z', type: 'waiting', orderId: 'ord-a', summary: '/Users/someone/wait' },
      { at: '2026-11-12T01:22:00.000Z', type: 'bypass', orderId: 'ord-a', summary: 'cleanup · /Users/someone/bypass' },
      { at: '2026-11-12T01:23:00.000Z', type: 'checkpoint', orderId: 'ord-a', summary: 'ship → ci' }
    ]
  })
  const web = terminalMarkup(v, { now: NOW, interactive: false, private: false })
  for (const secret of ['/Users/someone', 'TOKEN', 'work-acct', 'next ›', '자동 처리 내역 ›']) lacks(web, secret)
  has(web, '<span class="c-bp">자동 처리 내역</span>')
  has(web, '자동 처리 내역 <b class="b-purple">[1]</b>')
  has(web, 'ship → ci')
  has(web, '대기 ~')
  has(web, '<span class="g">머지 승인</span>')
  has(web, '사람 승인 대기')

  const desk = terminalMarkup(v, { now: NOW, interactive: true, private: true })
  for (const shown of ['cat /Users/someone/.npmrc', 'ghp_waitTOKEN', 'ghp_gateTOKEN · /Users/someone/gate', 'merge · ghp_gateTOKEN', '<span class="muted">계정</span><span class="ell">work-acct</span>', 'ghp_reportTOKEN', '자동 처리 내역 › rm -rf /Users/someone/tmp']) has(desk, shown)
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

test('해제된 워커의 상세는 터미널 안내와 이동 버튼 없이 워커 종료만 싣는다', () => {
  for (const workerStatus of ['released', 'finished']) {
    const o = order('ord-a', { status: 'merged', workspaceId: 'ws-1', worker: 'wrk-1', workerKind: 'orca-worktree', workerStatus })
    const html = terminalMarkup(view([o]), {
      now: NOW,
      interactive: true,
      private: true,
      open: new Set(['ord-a']),
      live: { 'ord-a': { found: true, noWorkerTerminal: true, error: '에이전트 상태를 못 읽었어요(no workspace has this id).' } }
    })
    has(html, '워커 종료')
    lacks(html, '터미널을 못 찾아')
    lacks(html, '못 읽었어요')
    lacks(html, '터미널로 이동')
    lacks(html, 'data-open')
    has(html, 'aria-label="ord-a')
    has(html, ' · 워커 종료"')
  }
})

test('주문은 있는데 새 필드가 하나도 없으면 CLI를 올리라고 알린다', () => {
  has(terminalMarkup(view([order('ord-a')], { terminalFieldsMissing: true }), { now: NOW, interactive: true, private: true }), 'gestalt CLI가 낡아')
  lacks(terminalMarkup(view([order('ord-a')]), { now: NOW, interactive: true, private: true }), 'gestalt CLI가 낡아')
})

const WORK = {
  activity: { tool: 'Edit', file: 'src/a.ts', at: '2026-11-12T01:57:00.000Z' },
  changedFiles: ['src/a.ts', 'src/b.ts'],
  overlapFiles: ['src/b.ts'],
  tasks: {
    items: [
      { title: '리더 만들기', status: 'completed' as const },
      { title: '플러그인 표시', status: 'in_progress' as const }
    ],
    done: 1,
    total: 2
  },
  subagents: [{ name: '코드 조사', startedAt: '2026-11-12T01:50:00.000Z', state: 'detached' as const }],
  recentTools: [{ at: '2026-11-12T01:57:00.000Z', tool: 'Bash', detail: 'cat /Users/someone/.npmrc', ok: true }],
  history: 'partial' as const
}

test('작업 내용이 있으면 todo 막대와 지금 파일, 실행 중인 서브에이전트 수를 카드에 그린다', () => {
  const html = terminalMarkup(view([order('ord-a', { work: WORK })]), { now: NOW, interactive: true, private: true })
  has(html, 'todo 1/2')
  has(html, '✎ src/a.ts · 3분')
  has(html, '서브 1')
  has(html, '⚠ src/b.ts')
  has(html, '리더 만들기')
  has(html, '코드 조사')
  has(html, 'cat /Users/someone/.npmrc')
  has(html, '끝부분만 읽었어요')
})

test('ship 리뷰 라운드면 todo 막대 대신 리뷰어 완료 막대를 그리고 리뷰가 끝나면 todo 막대로 돌아간다', () => {
  const checkpoint = { skill: 'ship', phase: '2', round: 1, next: '', completedSkills: [], savedAt: '2026-11-12T01:00:00.000Z' }
  const review = { startedAt: '2026-11-12T01:50:00.000Z', round: 2, total: 6, done: 3, running: 3, failed: 0 }
  for (const opts of [{ interactive: true, private: true }, { interactive: false, private: false }]) {
    const html = terminalMarkup(view([order('ord-a', { skillChain: ['ship'], checkpoint, work: { ...WORK, review } })]), { now: NOW, ...opts })
    has(html, '>ship r2<')
    has(html, '리뷰 3/6 완료 (3개 실행 중)')
    has(html, 'width:50%')
    // 막대는 꾸밈이고 진행은 옆 글이 읽어 준다
    has(html, 'aria-hidden="true"><b style="width:50%">')
    lacks(html, 'todo 1/2')
  }
  const done = terminalMarkup(view([order('ord-a', { skillChain: ['ship'], checkpoint, work: { ...WORK, review: null } })]), { now: NOW, interactive: true, private: true })
  lacks(done, '리뷰 ')
  has(done, 'todo 1/2')
  has(done, '>ship · 2 r1<')
})

test('todo를 모르면 빗금 막대와 모름을 그린다', () => {
  const html = terminalMarkup(view([order('ord-a', { work: { ...WORK, tasks: null } })]), {
    now: NOW,
    interactive: true,
    private: true
  })
  has(html, 'prog unknown')
  has(html, 'todo 모름')
})

test('웹 페이지는 고친 파일과 지금 파일만 보여 주고 todo와 서브에이전트는 개수만, tool 호출은 안 싣는다', () => {
  const html = terminalMarkup(view([order('ord-a', { work: WORK })]), { now: NOW, interactive: false, private: false })
  has(html, '✎ src/a.ts')
  has(html, '⚠ src/b.ts')
  has(html, 'todo 1/2')
  lacks(html, '리더 만들기')
  lacks(html, '코드 조사')
  lacks(html, '.npmrc')
  lacks(html, '최근 tool 호출')
  lacks(html, 'data-browse')
  const desk = terminalMarkup(view([order('ord-a', { work: WORK })]), { now: NOW, interactive: true, private: true })
  has(desk, 'data-browse="ord-a"')
  has(desk, 'data-viewer')
  has(desk, 'data-copy="ord-a"')
  lacks(html, 'data-copy')
  has(html, 'w-ord-a')
})

test('파일 없이 tool만 있으면 웹 페이지에는 tool 이름을 안 싣는다', () => {
  const work = { ...WORK, activity: { tool: 'WebFetch', at: '2026-11-12T01:57:00.000Z' } }
  lacks(terminalMarkup(view([order('ord-a', { work })]), { now: NOW, interactive: false, private: false }), 'WebFetch')
  has(terminalMarkup(view([order('ord-a', { work })]), { now: NOW, interactive: true, private: true }), '▸ WebFetch')
})

test('하위 주문 줄도 배포 대기를 상태줄과 같게 그린다', () => {
  const html = terminalMarkup(
    view([order('ord-p'), order('ord-c', { status: 'merged', awaitingDeploy: true, parentOrderId: 'ord-p', worker: undefined })]),
    { now: NOW, interactive: false, private: false }
  )
  has(html, 'ord-c ord-c</span><span>awaiting-deploy')
})

test('결과 페이지 열기는 데스크톱 화면 머리에만 있고 카드 목록보다 위에 있다', () => {
  const desk = terminalMarkup(view([order('ord-a')]), { now: NOW, interactive: true, private: true })
  has(desk, 'data-viewer')
  assert.equal(desk.indexOf('data-viewer') < desk.indexOf('class="workers"'), true, '카드 목록보다 위에 있어요')
  lacks(terminalMarkup(view([order('ord-a')]), { now: NOW, interactive: false, private: false }), 'data-viewer')
  lacks(terminalMarkup(view([order('ord-a')]), { now: NOW, interactive: true, private: false }), 'data-viewer')
})

test('결과 뷰어를 못 띄운 이유는 버튼 옆에 이스케이프해서 한 줄로 붙인다', () => {
  const html = terminalMarkup(view([order('ord-a')]), {
    now: NOW,
    interactive: true,
    private: true,
    viewerNote: '결과 뷰어를 못 띄웠어요. <gestalt> 실행 파일을 못 찾았어요'
  })
  has(html, '<span class="viewer-note">결과 뷰어를 못 띄웠어요. &lt;gestalt&gt; 실행 파일을 못 찾았어요</span>')
  assert.equal(html.indexOf('viewer-note') > html.indexOf('data-viewer'), true)
  lacks(terminalMarkup(view([order('ord-a')]), { now: NOW, interactive: true, private: true }), 'viewer-note')
})

test('카드는 주문 id를 워커 종류 색 배지로, 제목은 다음 줄에 그리고 길면 줄바꿈한다', () => {
  const html = terminalMarkup(view([order('ord-a', { title: '아주 긴 작업 제목', workspaceId: 'ws-1' }), order('ord-b')]), { now: NOW, interactive: true, private: true })
  has(html, '<div class="t"><div class="tid-row"><span class="tid">ord-a</span><button class="copy" data-copy="ord-a"')
  has(html, 'data-go="ord-a" data-focus="go-head:ord-a"')
  lacks(html, 'go-head:ord-b')
  has(html, '<span class="ttl">아주 긴 작업 제목</span></div>')
  const web = terminalMarkup(view([order('ord-a', { title: '아주 긴 작업 제목' })]), { now: NOW, interactive: false, private: false })
  has(web, '<div class="tid-row"><span class="tid">ord-a</span></div>')
  has(TERMINAL_STYLE, '.w .t .ttl { white-space: normal;')
  has(TERMINAL_STYLE, '.w.orca .t .tid { background: var(--t-orange); }')
})

test('중립색은 오르카 테마 변수를 따르고 변수가 없는 웹 페이지에서는 원래 다크 색으로 그린다', () => {
  has(TERMINAL_STYLE, '--t-bg: var(--orca-background, #14161c);')
  has(TERMINAL_STYLE, '--t-fg: var(--orca-foreground, #c9ced8);')
  has(TERMINAL_STYLE, '--t-dim: var(--orca-muted-foreground, #8b93a1);')
  has(TERMINAL_STYLE, '--t-line: var(--orca-border, #2a2f3a);')
  has(TERMINAL_STYLE, '--t-ring: var(--orca-ring, var(--t-fg));')
  has(TERMINAL_STYLE, '--t-card: var(--orca-card, var(--t-bg));')
  has(TERMINAL_STYLE, '--t-fill: var(--orca-muted, #232833);')
  has(TERMINAL_STYLE, '--t-hover: var(--orca-accent, #232833);')
  has(TERMINAL_STYLE, '--t-hover-fg: var(--orca-accent-foreground, var(--t-fg));')
  has(TERMINAL_STYLE, '--t-stripe: var(--orca-border, #2f3542);')
  has(TERMINAL_STYLE, '--t-pop: var(--orca-popover, #2b2b2b);')
  has(TERMINAL_STYLE, '--t-pop-fg: var(--orca-popover-foreground, #e6e6e6);')
  has(TERMINAL_STYLE, '--t-pop-line: var(--orca-border, #454545);')
  has(TERMINAL_STYLE, 'html.light { color-scheme: light;')
  // 상태는 Gestalt 상태 역할 값을 다크와 라이트에 따로 싣는다
  for (const [name, c] of Object.entries(STATUS_COLORS)) {
    has(TERMINAL_STYLE, `--t-${name}: ${c.dark};`)
    has(TERMINAL_STYLE, `--t-${name}: ${c.light};`)
  }
  // 워크트리 종류를 가르는 계열색은 그대로 두고 라이트에서만 글자색을 섞는다
  for (const [name, hex, pct] of [
    ['orange', '#f0915a', 62],
    ['blue', '#7aa7ff', 62],
    ['green', '#5fd38d', 58],
    ['purple', '#a78bfa', 68],
    ['yellow', '#f2c94c', 55],
  ] as const) {
    has(TERMINAL_STYLE, `--t-${name}:${hex};`)
    has(TERMINAL_STYLE, `--t-${name}: color-mix(in srgb, ${hex} ${pct}%, var(--t-fg));`)
  }
  // 흰 글자를 얹는 배지는 라이트에서 바탕을 더 어둡게 섞어야 4.5:1을 넘는다
  has(TERMINAL_STYLE, '--t-badge-yellow: color-mix(in srgb, #f2c94c 40%, var(--t-fg));')
  has(TERMINAL_STYLE, '--t-badge-orange: color-mix(in srgb, #f0915a 50%, var(--t-fg));')
  has(TERMINAL_STYLE, '--t-badge-yellow: var(--t-yellow);')
  has(TERMINAL_STYLE, '--t-badge-orange: var(--t-orange);')
  has(TERMINAL_STYLE, '--t-done-line: color-mix(in srgb, var(--t-success) 45%, var(--t-bg));')
  // 색 값은 :root와 html.light에만 둔다. 테마와 무관한 검은 그림자만 빼고 나머지 규칙에 색이 다시 들어오면 테마를 안 따른다
  const rules = TERMINAL_STYLE.split('\n')
    .filter((line) => !line.startsWith(':root {') && !line.startsWith('html.light {'))
    .join('\n')
    .replace(/box-shadow: 0 4px 12px rgba\(0,0,0,\.\d+\);/g, '')
  assert.equal(rules.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g), null, '테마 변수 밖에 박아 둔 색이 있어요')
})

test('승인 필요와 진행, 완료, 실패는 상태 역할 색으로 그리고 모양 표시를 같이 단다', () => {
  has(TERMINAL_STYLE, '.lane-head.approval .lane-name { color: var(--t-warning); } .lane-head.running .lane-name { color: var(--t-info); }')
  has(TERMINAL_STYLE, ".st.run::before { content: '●'; margin-right: 4px; color: var(--t-info);")
  has(TERMINAL_STYLE, ".st.wait, .st.gate { color: var(--t-warning); } .st.wait::before, .st.gate::before { content: '◷ '; }")
  has(TERMINAL_STYLE, ".st.limit { color: var(--t-danger); } .st.limit::before { content: '■ '; }")
  has(TERMINAL_STYLE, '.chip.done { color: var(--t-success);')
  has(TERMINAL_STYLE, '.b-run { color: var(--t-info); } .b-gate { color: var(--t-warning); }')
  has(terminalMarkup(view([order('ord-a')]), { now: NOW, interactive: true, private: true }), '<b class="b-gate">')
})

test('컨덕터 칸은 세션을 알면 데스크톱에만 세션으로 이동 버튼을 그린다', () => {
  const v = view([order('ord-a')], { conductor: { session: { id: 'sess-1', cwd: '/w' } } })
  has(terminalMarkup(v, { now: NOW, interactive: true, private: true }), 'data-go-conductor')
  lacks(terminalMarkup(v, { now: NOW, interactive: false, private: false }), 'data-go-conductor')
  lacks(terminalMarkup(view([order('ord-a')]), { now: NOW, interactive: true, private: true }), 'data-go-conductor')
})

test('카드는 레포별 묶음 안에 들고 묶음 머리에 프로젝트 이름과 개수가 뜬다', () => {
  const html = terminalMarkup(
    view([order('ord-a'), order('ord-b', { repo: 'acme/api' }), order('ord-c')], { projects: { 'acme/web': '웹 프론트' } }),
    { now: NOW, interactive: true, private: true }
  )
  has(html, '<section class="rg" data-key="repo:acme/web"><div class="rg-head"><span class="rg-name">웹 프론트</span><span class="rg-count">2</span></div>')
  has(html, '<span class="rg-name">api</span><span class="rg-count">1</span>')
  assert.equal(html.indexOf('repo:acme/web') < html.indexOf('repo:acme/api'), true)
  lacks(html, '<span class="muted">레포</span>')
})

test('머리에 승인, 진행, 대기 수를 싣고 대기와 끝남 칸은 접어 둔다', () => {
  const v = view(
    [
      order('ord-run', { workerStatus: 'running' }),
      order('ord-wait', { workerStatus: 'running', waiting: { reason: 'CI', since: '2026-11-12T01:00:00.000Z' } }),
      order('ord-end', { workerStatus: 'released' }),
      order('ord-gate', { status: 'waiting-gate', workerStatus: 'running', pr: 'acme/web#9' })
    ],
    {
      gates: [
        { id: 'g', type: 'merge', orderId: 'ord-gate', reason: 'PR 머지', openedAt: '2026-11-12T01:50:00.000Z', approverReady: true },
        { id: 'g2', type: 'no-procedure', orderId: null, reason: '절차 없음' }
      ]
    }
  )
  for (const opts of [
    { now: NOW, interactive: true, private: true },
    { now: NOW, interactive: false, private: false }
  ]) {
    const html = terminalMarkup(v, opts)
    has(html, '<span class="k-gate">승인 2</span><span class="k-run">진행 1</span><span class="k-wait">대기 1</span>')
    has(html, '<details class="lane fold waiting" data-key="lane:waiting">')
    has(html, '<details class="lane fold ended" data-key="lane:ended">')
    has(html, '<span class="g">머지 승인</span><span class="muted">10분째</span><span>acme/web#9</span><span class="ready">봇 채팅으로 닫기</span>')
    // approverReady를 안 주는 게이트는 그 칸을 그리지 않는다
    lacks(html, '터미널 필요')
    has(html, 'conductor · 3 workers')
  }
  const opened = terminalMarkup(v, { now: NOW, interactive: true, private: true, lanes: new Set(['waiting']) })
  has(opened, 'data-key="lane:waiting" open>')
  has(opened, 'data-key="lane:ended">')
})

test('컨덕터 칸과 상태 줄에 유형별 사용량을, 카드에 유형 이름표를 그린다', () => {
  const v = view([order('ord-a', { workClass: 'work' }), order('ord-b', { workClass: 'review' })], {
    conductor: { maxWorkers: 20, workerSlots: { lookup: { active: 0, limit: 5 }, review: { active: 1, limit: 5 }, work: { active: 1, limit: 10 } } }
  })
  const html = terminalMarkup(v, { now: NOW, interactive: true, private: true })
  has(html, '· 조회')
  has(html, '1 / 10')
  has(html, '<span class="slots">조회 0/5 · 리뷰 1/5 · 작업 1/10</span>')
  has(html, '<span class="wc">작업</span>')
  has(html, '<span class="wc">리뷰</span>')
})

test('옛 CLI면 유형별 줄과 이름표 없이 전체 슬롯만 그린다', () => {
  const html = terminalMarkup(view([order('ord-a')], { conductor: { maxWorkers: 4 } }), { now: NOW, interactive: true, private: true })
  lacks(html, 'class="slots"')
  lacks(html, 'class="wc"')
  lacks(html, 'kv slot')
})
