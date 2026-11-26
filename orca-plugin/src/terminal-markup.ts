// 컨덕터 터미널 화면의 마크업. 에디터와 사이드바 패널, 폰 웹 페이지가 이 문자열 하나를 그린다.
// 계산은 terminal-model이 하고 여기는 이스케이프한 HTML 문자열만 만든다. DOM과 오르카 런타임은 모른다.
// 주문 제목이나 게이트 사유는 지라나 PR에서 온 바깥 글이라 전부 esc를 거친다.
import { esc } from './html'
import { displayStatus, isClosed, ms, OUTDATED_CLI_TEXT, splitRepo } from './model'
import type { AgentState, ConductorView, EventView, OrderView, WorkerLive, WorkView } from './protocol'
import { canReachWorker, clock, duration, eventText, gateLabel, groupByRepo, lookup, orderWaitText, slotText, terminalModel, waitText, workerEnded, type ApprovalEntry, type Card, type GateItem, type TerminalModel } from './terminal-model'

export type TerminalMarkupOptions = {
  now: number
  /** 카드를 두 번 눌러 워크트리로 가는 화면(에디터와 패널). 웹 페이지는 보기 전용이라 끈다 */
  interactive: boolean
  /** 인증 없는 웹 페이지는 저장소 경로와 CLI 오류 원문을 싣지 않는다. 홈 경로에 사용자 이름이 들어 있다 */
  private: boolean
  loadError?: string | null
  openError?: string | null
  /** 이동은 했지만 워커 터미널이 아닌 곳으로 갔을 때의 안내. 워커가 이유까지 담아 지은 문장이다 */
  openNote?: string | null
  /** 머리의 "결과 페이지 열기" 옆에 한 줄로 붙일 안내. 뷰어를 못 띄운 이유나 브라우저를 못 열었을 때의 주소다 */
  viewerNote?: string | null
  /** 상세를 펼쳐 둔 주문. 웹 페이지는 폴링 스크립트가 data-key로 펼침을 지키니 안 넘긴다 */
  open?: ReadonlySet<string>
  /** 펼쳐 둔 칸(waiting, ended). 기본은 둘 다 접혀 있다. 웹 페이지는 open처럼 안 넘긴다 */
  lanes?: ReadonlySet<string>
  /** 펼친 카드에 붙일 워커 터미널. interactive일 때만 그린다 */
  live?: Readonly<Record<string, WorkerLive | 'loading'>>
}

type Part = string | false | null | undefined
const join = (...parts: Part[]) => parts.filter(Boolean).join('')
const div = (cls: string, ...body: Part[]) => `<div class="${esc(cls)}">${join(...body)}</div>`
const span = (cls: string, text: string) => `<span${cls ? ` class="${esc(cls)}"` : ''}>${esc(text)}</span>`
const kv = (k: string, v: string) => div('kv', span('', k), span('', v))
const SEP = '<div class="sep"></div>'
const BYPASS_LABEL = '자동 처리 내역'

function conductorBox(v: ConductorView, m: TerminalModel, now: number, interactive: boolean): string {
  const info = v.conductor
  const tickAt = ms(v.lastTickAt)
  const repos = info?.prWatchRepos?.map((r) => splitRepo(r).name)
  return div(
    'box conductor',
    '<h3>CONDUCTOR</h3>',
    div('muted', esc(info?.pollIntervalSec ? `세션 · tick ${info.pollIntervalSec}s` : '세션')),
    interactive &&
      info?.session &&
      '<button class="go" data-go-conductor data-focus="go-conductor" aria-label="컨덕터 세션으로 이동">세션으로 이동</button>',
    SEP,
    kv('마지막 tick', tickAt === null ? '없음' : `${duration(tickAt, now)} 전`),
    kv('슬롯', m.maxWorkers !== undefined ? `${m.activeWorkers} / ${m.maxWorkers}` : String(m.activeWorkers)),
    ...(m.slots ?? []).map((u) => div('kv slot', span('muted', `· ${u.label}`), span('', `${u.active} / ${u.limit}`))),
    kv('대기 주문', String(m.queued)),
    repos && SEP,
    repos && div('muted', 'PR 감시'),
    repos && div('', esc(repos.length ? repos.join(', ') : '없음')),
    info && (info.compactions !== undefined || info.disconnectedWorkers !== undefined) && SEP,
    info?.compactions !== undefined && kv('컴팩트', `${info.compactions}회`),
    info?.disconnectedWorkers !== undefined && kv('끊긴 워커', String(info.disconnectedWorkers)),
    '<div class="sep motto"></div>',
    div('muted motto', '코드는 안 고친다.<br>배정하고 끌고 간다.')
  )
}

const TERMINAL_FIELDS_TEXT = 'gestalt CLI가 낡아 워커 단계와 최근 이벤트가 빠졌어요. gestalt를 새 버전으로 올리면 채워져요.'

const dkv = (k: string, v: string) => div('dkv', span('muted', k), span('', v))

/** 복사 옆의 이동 버튼. 카드를 두 번 누르는 것과 같이 워커 터미널로 간다 */
function goButton(orderId: string): string {
  return `<button class="copy" data-go="${esc(orderId)}" data-focus="${esc(`go-head:${orderId}`)}" aria-label="${esc(`${orderId} 워커 터미널로 이동`)}" title="워커 터미널로 이동">이동</button>`
}

/** 주문 번호 옆의 복사 버튼. 웹 페이지에는 누를 스크립트가 없어 싣지 않는다 */
function copyOrderButton(orderId: string): string {
  return `<button class="copy" data-copy="${esc(orderId)}" data-focus="${esc(`copy:${orderId}`)}" aria-label="${esc(`주문 번호 ${orderId} 복사`)}" title="주문 번호 복사">복사</button>`
}

function prUrl(ref: string): string | undefined {
  const match = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(ref) ??
    /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?(?:[?#].*)?$/.exec(ref)
  if (!match) return undefined
  const [, owner, repo, number] = match
  return `https://github.com/${owner}/${repo}/pull/${number}`
}

function metaValue(label: string, value: string, orderId: string, jiraSiteUrl?: string): string {
  const url = label === 'PR' ? prUrl(value) :
    label === '티켓' && jiraSiteUrl && /^[A-Z][A-Z0-9_]*-\d+$/.test(value) ? `${jiraSiteUrl}/browse/${value}` : undefined
  if (!url) return span('ell', value)
  const id = esc(`${label === 'PR' ? 'pr' : 'issue'}:${orderId}`)
  const href = esc(url)
  return `<button type="button" class="meta-link ell" popovertarget="${id}" data-focus="${id}" title="${esc(value)}">${esc(value)}</button>` +
    `<div class="link-actions" id="${id}" popover>` +
    `<button type="button" data-open-link="${href}" data-focus="${id}:open">브라우저에서 열기</button>` +
    `<button type="button" data-copy="${href}" data-focus="${id}:copy">링크 복사</button></div>`
}

const AGENT_STATE: Record<AgentState, string> = { working: '작업 중', blocked: '권한 대기', waiting: '입력 대기', done: '끝남' }

function liveBlock(o: Card['order'], live: WorkerLive | 'loading' | undefined, now: number): string {
  if (workerEnded(o) || isClosed(o.status)) return div('muted', '워커 종료')
  if (!o.workspaceId) return div('muted', '오르카 워크트리 워커가 아니라 터미널을 못 읽어요.')
  if (!live || live === 'loading') return div('muted', '워커 터미널을 읽는 중')
  if (!live.found) return div('muted', esc(live.error ?? '이 주문의 워크트리를 오르카에서 못 찾았어요.'))
  const a = live.agent
  return join(
    a && dkv('에이전트', `${a.kind ?? '에이전트'} · ${lookup(AGENT_STATE, a.state) ?? a.state} · ${duration(a.since, now)}째`),
    a?.task && dkv('작업', a.task),
    live.lines && live.lines.length > 0
      ? `<pre class="tail" data-tail="${esc(o.id)}">${esc(live.lines.join('\n'))}</pre>`
      : live.terminalId && !live.error && div('muted', '터미널 출력이 아직 없어요.'),
    live.noWorkerTerminal &&
      div('muted', '워커 에이전트의 터미널을 못 찾아 출력은 안 보여 줘요. 이동하면 워크트리의 첫 터미널로 가고 터미널이 없으면 워크트리만 열어요.'),
    live.error && div('muted', esc(live.error)),
    `<button class="go" data-go="${esc(o.id)}" data-focus="${esc(`go:${o.id}`)}">터미널로 이동</button>`
  )
}

const MAX_FILES = 15
const MAX_ITEMS = 20
const TASK_MARK: Record<string, string> = { completed: '✓', in_progress: '▸', pending: '·' }
const SUB_STATE: Record<string, string> = { running: '실행 중', detached: '백그라운드', done: '끝남' }

/**
 * 상세의 작업 내용. 고친 파일은 둘 다 보여 주고 겹친 파일에 ⚠를 붙인다.
 * todo 제목과 서브에이전트 이름, 최근 tool 호출은 워커가 쓴 글이라 데스크톱에서만 그리고 웹 페이지에는 개수만 싣는다
 */
function workBlock(orderId: string, w: WorkView, opts: TerminalMarkupOptions): string {
  const overlap = new Set(w.overlapFiles)
  const files = w.changedFiles
  const fileRows =
    files === null
      ? div('muted', '고친 파일을 아직 못 구했어요.')
      : files.length === 0
        ? div('muted', '고친 파일 없음')
        : join(
            ...files.slice(0, MAX_FILES).map((f) => div(`f${overlap.has(f) ? ' ov' : ''}`, esc(`${overlap.has(f) ? '⚠ ' : ''}${f}`))),
            files.length > MAX_FILES && div('muted', esc(`외 ${files.length - MAX_FILES}개`))
          )
  const tasks = w.tasks
  const subs = w.subagents
  return div(
    'work',
    div('muted', esc(`고친 파일${files ? ` ${files.length}` : ''}${overlap.size ? ` · 겹침 ${overlap.size}` : ''}`)),
    fileRows,
    tasks === null
      ? dkv('todo', '모름')
      : opts.private && tasks.total > 0
        ? join(
            dkv('todo', `${tasks.done}/${tasks.total}`),
            ...tasks.items.slice(0, MAX_ITEMS).map((t) => div('task', span('muted', lookup(TASK_MARK, t.status) ?? '·'), span('', t.title))),
            tasks.items.length > MAX_ITEMS && div('muted', esc(`외 ${tasks.items.length - MAX_ITEMS}개`))
          )
        : dkv('todo', `${tasks.done}/${tasks.total}`),
    subs === null
      ? false
      : opts.private && subs.length > 0
        ? join(
            dkv('서브에이전트', String(subs.length)),
            ...subs.slice(0, MAX_ITEMS).map((a) =>
              div('task', span('muted', lookup(SUB_STATE, a.state) ?? a.state), span('', `${a.name} · ${duration(ms(a.startedAt), opts.now)}`))
            ),
            subs.length > MAX_ITEMS && div('muted', esc(`외 ${subs.length - MAX_ITEMS}개`))
          )
        : dkv('서브에이전트', String(subs.length)),
    opts.private &&
      w.recentTools &&
      w.recentTools.length > 0 &&
      div(
        'd-ev',
        div('muted', '최근 tool 호출'),
        ...w.recentTools.map((t) =>
          div('r', span('muted', clock(t.at)), span(t.ok === false ? 'c-err' : 'c-rp', t.tool), span('', t.detail))
        )
      ),
    w.history === 'partial' && div('muted', '트랜스크립트가 길어 끝부분만 읽었어요.'),
    opts.private &&
      `<button class="go" data-browse="${esc(orderId)}" data-focus="${esc(`browse:${orderId}`)}" aria-label="${esc(`${orderId} 작업 내용 전체 보기, 브라우저에서 열려요`)}">전체 보기</button>`
  )
}

/**
 * 카드 아래 펼치는 상세. 워커 id와 브랜치, 체크포인트의 스킬과 단계는 컨덕터가 정한 값이라 칩과 이벤트 로그에도
 * 이미 나와서 폰에도 싣는다. 워커가 쓴 글(다음 할 일, 대기 사유)과 경로, 워커 터미널은 데스크톱에서만 그린다
 */
function detail(c: Card, v: ConductorView, opts: TerminalMarkupOptions): string {
  const o = c.order
  const cp = o.checkpoint
  const events = (v.recentEvents ?? []).filter((e) => e.orderId === o.id).slice(-5)
  const body = join(
    o.worker && dkv('워커', [o.worker, o.workerKind, o.workerStatus].filter(Boolean).join(' · ')),
    cp && dkv('체크포인트', `${cp.skill}${cp.phase ? ` → ${cp.phase}` : ''}${cp.round ? ` r${cp.round}` : ''}${cp.savedAt ? ` · ${clock(cp.savedAt)} 저장` : ''}`),
    opts.private && cp?.next && dkv('다음', cp.next),
    o.waiting && dkv('대기', `${orderWaitText(o.waiting, opts.private)} · ${clock(o.waiting.since)}부터`),
    o.branch && dkv('브랜치', o.branch),
    opts.private && o.worktreePath && dkv('경로', o.worktreePath),
    ...v.gates.filter((g) => g.orderId === o.id).map((g) => dkv(gateLabel(g.type), opts.private ? g.reason : '사람 승인 대기')),
    events.length > 0 && div('d-ev', div('muted', '최근 이벤트'), ...events.map((e) => detailEvent(e, opts.private))),
    o.work && workBlock(o.id, o.work, opts),
    opts.interactive && div('live', liveBlock(o, opts.live?.[o.id], opts.now))
  )
  const open = opts.open?.has(o.id) ? ' open' : ''
  return `<details class="more" data-key="${esc(`ord:${o.id}`)}"${open}><summary data-focus="${esc(`sum:${o.id}`)}">상세</summary>${div('d', body)}</details>`
}

/** todo가 없다고 보고된 워커는 빗금 막대와 "모름"을 그린다. 0개 목록과 구분한다 */
function todoBar(t: NonNullable<Card['todo']>, tone: string): string {
  if (t === 'unknown') return div('todo', '<div class="prog unknown"></div>', span('muted', 'todo 모름'))
  const pct = t.total === 0 ? 0 : Math.round((t.done / t.total) * 100)
  return div('todo', `<div class="prog ${tone}"><b style="width:${pct}%"></b></div>`, span('muted', `todo ${t.done}/${t.total}`))
}

/** 레포별 묶음. 묶음 머리에 레포가 나오니 카드에서는 레포 줄을 뺀다 */
function repoGroups(cards: readonly Card[], v: ConductorView, opts: TerminalMarkupOptions): string {
  return join(
    ...groupByRepo(cards, v.projects).map((g) =>
      `<section class="rg" data-key="${esc(`repo:${g.repo}`)}">${join(
        div('rg-head', span('rg-name', g.label), span('rg-count', `${g.cards.length}`)),
        div('workers', ...g.cards.map((c) => card(c, v, opts)))
      )}</section>`
    )
  )
}

/**
 * 승인 칸 카드 머리의 게이트 줄과 사유. 머지면 PR, 파일 겹침이면 겹친 파일 수, 서버가 주면 봇 채팅으로 닫을 수 있는지를 붙인다.
 * 사유는 워커가 넘긴 detail로 만들어 경로나 토큰이 섞일 수 있어서 데스크톱에서만 싣는다. 파일 겹침의 상대 주문은 사유에만 있다
 */
function gateLines(gates: readonly GateItem[], showPrivate: boolean): string {
  return div(
    'gate-info',
    ...gates.map((g) =>
      join(
        div(
          'gi',
          span('g', g.label),
          g.waited && span('muted', `${g.waited}째`),
          g.pr && span('', g.pr),
          g.overlapFiles !== undefined && span('', `지금 겹친 파일 ${g.overlapFiles}개`),
          g.approverReady !== undefined && span(g.approverReady ? 'ready' : 'muted', g.approverReady ? '봇 채팅으로 닫기' : '터미널 필요')
        ),
        showPrivate && `<div class="muted ell" title="${esc(g.gate.reason)}">${esc(g.gate.reason)}</div>`
      )
    )
  )
}

/** 카드와 줄이 함께 쓰는 포커스, 이동 속성. 데스크톱(interactive)에서만 붙인다 */
function openAttrs(o: OrderView, focus: string, canOpen: boolean): string {
  return ` data-order="${esc(o.id)}" data-focus="${esc(focus)}" tabindex="0" role="group" aria-label="${esc(`${o.id} ${o.title}${workerEnded(o) ? ' · 워커 종료' : ''}`)}"${
    canOpen ? ' data-open aria-keyshortcuts="Enter" title="두 번 누르거나 Enter를 누르면 워커 터미널로 가요"' : ''
  }`
}

function card(c: Card, v: ConductorView, opts: TerminalMarkupOptions, gates?: readonly GateItem[]): string {
  const o = c.order
  const interactive = opts.interactive
  const canOpen = interactive && canReachWorker(o)
  const pct = c.progress === null ? null : Math.round(c.progress * 100)
  const attrs = interactive ? openAttrs(o, `card:${o.id}`, canOpen) : ''
  const body = join(
    div('t', div('tid-row', span('tid', o.id), c.workLabel && span('wc', c.workLabel), interactive && copyOrderButton(o.id), canOpen && goButton(o.id)), span('ttl', o.title)),
    gates && gateLines(gates, opts.private),
    c.meta.some((r) => r.label !== '레포') &&
      div('meta', ...c.meta.filter((r) => r.label !== '레포').map((r) =>
        div('mrow', span('muted', r.label), interactive ? metaValue(r.label, r.value, o.id, v.jiraSiteUrl) : span('ell', r.value))
      )),
    c.chips.length > 0 && div('chain', ...c.chips.map((ch) => span(`chip ${ch.state}`, ch.text))),
    c.todo === undefined
      ? pct !== null && `<div class="prog ${c.state.tone}"><b style="width:${pct}%"></b></div>`
      : todoBar(c.todo, c.state.tone),
    c.now && div('muted ell now', esc(c.now)),
    div(
      'state',
      span(`st ${c.state.tone}`, c.state.text),
      span('muted', [c.subagents > 0 ? `서브 ${c.subagents}` : '', c.state.aside].filter(Boolean).join(' · '))
    ),
    c.stalled && div('stall', esc(`⚠ 멈춘 것 같아요 · ${c.stalled}째 활동 없음`)),
    c.next && div('muted ell', esc(`next › ${c.next}`)),
    c.bypass && div('muted ell', esc(`${BYPASS_LABEL} › ${c.bypass}`)),
    c.children.length > 0 &&
      div('children', ...c.children.map((k) => div('child', span('ell', `${k.id} ${k.title}`), span('', displayStatus(k))))),
    detail(c, v, opts)
  )
  return `<div class="w ${c.kind}${canOpen ? ' openable' : ''}"${attrs}>${body}</div>`
}

/** 주문 카드가 없는 게이트. 컨덕터 게이트이거나 화면에 없는 주문의 게이트다 */
function gateOnly(e: ApprovalEntry, showPrivate: boolean): string {
  const g = e.gates[0]!.gate
  return `<div class="w gate-only">${join(g.orderId && div('t', div('tid-row', span('tid', g.orderId))), gateLines(e.gates, showPrivate))}</div>`
}

/** 대기와 끝남 칸의 한 줄. 상세는 펼칠 수 있고, 워커에 닿을 수 있는 줄만 두 번 누르거나 Enter로 워커로 간다(끝남 칸 줄은 안 간다) */
function row(c: Card, v: ConductorView, opts: TerminalMarkupOptions): string {
  const o = c.order
  const canOpen = opts.interactive && canReachWorker(o)
  const attrs = opts.interactive ? openAttrs(o, `row:${o.id}`, canOpen) : ''
  const repo = o.repo ? (v.projects?.[o.repo] ?? splitRepo(o.repo).name) : ''
  return `<div class="w row ${c.kind}${canOpen ? ' openable' : ''}"${attrs}>${join(
    div('rt', span('tid', o.id), c.workLabel && span('wc', c.workLabel), span('ttl ell', o.title), repo && span('muted', repo)),
    div('state', span(`st ${c.state.tone}`, c.state.text), span('muted', c.state.aside)),
    detail(c, v, opts)
  )}</div>`
}

const LANE_TITLE = { approval: '승인 필요', running: '진행 중', waiting: '대기', ended: '끝남' } as const

function laneHead(name: keyof typeof LANE_TITLE, count: number): string {
  return div(`lane-head ${name}`, span('lane-name', LANE_TITLE[name]), span('rg-count', String(count)))
}

/** 접어 두는 칸. 펼침은 데스크톱이 opts.lanes로, 웹 페이지는 폴링 스크립트가 data-key로 지킨다 */
function foldedLane(name: 'waiting' | 'ended', cards: readonly Card[], v: ConductorView, opts: TerminalMarkupOptions): string {
  if (cards.length === 0) return ''
  const open = opts.lanes?.has(name) ? ' open' : ''
  return `<details class="lane fold ${name}" data-key="${esc(`lane:${name}`)}"${open}><summary data-focus="${esc(`lane:${name}`)}">${laneHead(name, cards.length)}</summary>${div(
    'rows',
    ...cards.map((c) => row(c, v, opts))
  )}</details>`
}

/** 승인 필요, 진행 중, 대기, 끝남 순으로 칸을 쌓는다. 승인과 진행은 늘 펼치고 대기와 끝남은 접어 둔다 */
function lanes(m: TerminalModel, v: ConductorView, opts: TerminalMarkupOptions): string {
  if (m.cards.length === 0 && m.approval.length === 0) return div('box muted', '진행 중인 주문이 없어요.')
  return join(
    `<section class="lane approval" data-key="lane:approval">${join(
      laneHead('approval', m.approval.length),
      m.approval.length === 0
        ? div('muted lane-empty', '사람 확인을 기다리는 게이트가 없어요.')
        : div('workers', ...m.approval.map((e) => (e.card ? card(e.card, v, opts, e.gates) : gateOnly(e, opts.private))))
    )}</section>`,
    `<section class="lane running" data-key="lane:running">${join(
      laneHead('running', m.running.length),
      m.running.length === 0 ? div('muted lane-empty', '지금 일하는 워커가 없어요.') : repoGroups(m.running, v, opts)
    )}</section>`,
    foldedLane('waiting', m.waiting, v, opts),
    foldedLane('ended', m.ended, v, opts)
  )
}

const EVENT_TONE: Record<string, string> = {
  checkpoint: 'c-ck',
  report: 'c-rp',
  waiting: 'c-wt',
  bypass: 'c-bp',
  'gate-opened': 'c-gt',
  'gate-resolved': 'c-gt'
}

const EVENT_LABEL: Record<string, string> = { bypass: BYPASS_LABEL, 'gate-opened': 'gate', 'gate-resolved': 'gate ✓' }

/**
 * 인증 없는 폰 페이지에 요약을 싣는 이벤트. report, waiting, bypass 요약과 gate-opened의 사유는 워커가 쓴 글이라
 * 경로나 토큰이 섞일 수 있어서 시각과 유형, 주문 id만 남긴다
 */
const PUBLIC_SUMMARY = new Set(['checkpoint', 'gate-resolved'])
const showSummary = (e: EventView, showPrivate: boolean) => showPrivate || PUBLIC_SUMMARY.has(e.type)
const eventTag = (e: EventView) => span(lookup(EVENT_TONE, e.type) ?? '', lookup(EVENT_LABEL, e.type) ?? e.type)

const detailEvent = (e: EventView, showPrivate: boolean) =>
  div(
    'r',
    span('muted', clock(e.at)),
    eventTag(e),
    showSummary(e, showPrivate) && span('', e.type === 'waiting' && e.until ? waitText(e.summary, e.until, ' · ') : e.summary)
  )

const eventRow = (e: EventView, showPrivate: boolean) =>
  div(
    'r',
    span('muted', clock(e.at, true)),
    eventTag(e),
    span('ell', showSummary(e, showPrivate) ? eventText(e) : (e.orderId ?? ''))
  )

/**
 * 결과 뷰어는 결과 본문에 사내 정보가 있어 127.0.0.1에만 연다. 인증 없는 폰 페이지(private: false)에서는
 * 버튼을 그리지 않는다. 폰에서 누르면 폰의 127.0.0.1을 열게 되기도 한다
 */
const viewerTools = (opts: TerminalMarkupOptions) =>
  opts.interactive &&
  opts.private &&
  div(
    'tools',
    `<button class="go" data-viewer="1" data-focus="viewer" aria-label="결과 페이지 열기, 브라우저에서 열려요">결과 페이지 열기</button>`,
    opts.viewerNote && span('viewer-note', opts.viewerNote)
  )

const LEGEND: [string, string][] = [
  ['var(--t-orange)', 'orca-worktree'],
  ['var(--t-blue)', 'git-worktree'],
  ['var(--t-green)', 'subagent'],
  ['var(--t-purple)', 'conductor'],
  ['var(--t-yellow)', '사람 확인']
]

/** .term 안에 들어갈 본문. 상태가 없거나 저장소가 없으면 안내 한 줄만 낸다 */
export function terminalMarkup(v: ConductorView | null, opts: TerminalMarkupOptions): string {
  if (!v) return div('empty', esc(opts.loadError ? `워커에 못 닿았어요. ${opts.loadError}` : '불러오는 중'))
  if (v.state === 'missing') {
    const where = opts.private ? `${v.stateDir ?? '상태 폴더'}에 events.jsonl이` : '컨덕터 저장소가'
    return div('empty', esc(`${where} 아직 없어요. 컨덕터가 첫 주문을 받으면 여기에 보여요.`))
  }
  const m = terminalModel(v, opts.now, opts.private)
  return join(
    div(
      'bar',
      '<span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>',
      span('bar-title', `conductor · ${m.workers} workers`)
    ),
    viewerTools(opts),
    div(
      'head',
      span('', 'GESTALT CONDUCTOR'),
      span('k-gate', `승인 ${m.approval.length}`),
      span('k-run', `진행 ${m.running.length}`),
      span('k-wait', `대기 ${m.waiting.length}`)
    ),
    div('legend', ...LEGEND.map(([color, label]) => `<span><i style="background:${color}"></i>${esc(label)}</span>`)),
    v.state === 'error' &&
      div('alert', esc(opts.private ? `gestalt CLI가 실패했어요. ${v.error ?? ''}` : 'gestalt CLI가 실패했어요. 이유는 데스크톱 오르카에서 봐 주세요.')),
    v.outdatedCli && div('alert', esc(OUTDATED_CLI_TEXT)),
    v.terminalFieldsMissing && div('alert', esc(TERMINAL_FIELDS_TEXT)),
    opts.openError && div('alert', esc(`워크트리를 못 열었어요. ${opts.openError}`)),
    opts.openNote && div('alert', esc(opts.openNote)),
    div(
      'grid',
      conductorBox(v, m, opts.now, opts.interactive),
      div('', lanes(m, v, opts))
    ),
    div('log', div('muted', 'event log'), m.events.length ? div('log-rows', ...m.events.map((e) => eventRow(e, opts.private))) : div('muted', '아직 이벤트가 없어요.')),
    div(
      'status',
      '<span class="cmd">$ gestalt conductor watch <span class="cursor"></span></span>',
      '<span class="grow"></span>',
      `<span>workers <b class="b-green">[${m.activeWorkers}${m.maxWorkers !== undefined ? `/${m.maxWorkers}` : ''}]</b></span>`,
      m.slots && `<span class="slots">${esc(slotText(m.slots))}</span>`,
      `<span>gates <b class="b-yellow">[${m.gates.length}]</b></span>`,
      `<span>${BYPASS_LABEL} <b class="b-purple">[${m.bypasses}]</b></span>`
    )
  )
}

/** 터미널 화면의 CSS. 480px 이하면 사이드바 레이아웃(세로로 쌓기, 최근 이벤트 8줄)으로 바뀐다 */
export const TERMINAL_STYLE = `
/* 중립색은 오르카 테마의 --orca-* 변수를 따르고 변수가 없는 웹 페이지에서는 원래 다크 색으로 그린다.
   강조색은 그대로 두되 라이트 테마에서는 본문 글자색을 섞어 흰 바탕에서도 읽히게 한다 */
:root { color-scheme: dark; --t-bg: var(--orca-background, #14161c); --t-card: var(--orca-card, var(--t-bg)); --t-line: var(--orca-border, #2a2f3a); --t-fg: var(--orca-foreground, #c9ced8); --t-dim: var(--orca-muted-foreground, #8b93a1); --t-fill: var(--orca-muted, #232833); --t-hover: var(--orca-accent, #232833); --t-hover-fg: var(--orca-accent-foreground, var(--t-fg)); --t-ring: var(--orca-ring, var(--t-fg)); --t-stripe: var(--orca-border, #2f3542); --t-pop: var(--orca-popover, #2b2b2b); --t-pop-fg: var(--orca-popover-foreground, #e6e6e6); --t-pop-line: var(--orca-border, #454545); --t-orange:#f0915a; --t-blue:#7aa7ff; --t-green:#5fd38d; --t-purple:#a78bfa; --t-yellow:#f2c94c; --t-red:#f26d6d; --t-done-line: #2f5b43; --t-badge-yellow: var(--t-yellow); --t-badge-orange: var(--t-orange); }
html.light { color-scheme: light; --t-orange: color-mix(in srgb, #f0915a 62%, var(--t-fg)); --t-blue: color-mix(in srgb, #7aa7ff 62%, var(--t-fg)); --t-green: color-mix(in srgb, #5fd38d 58%, var(--t-fg)); --t-purple: color-mix(in srgb, #a78bfa 68%, var(--t-fg)); --t-yellow: color-mix(in srgb, #f2c94c 55%, var(--t-fg)); --t-red: color-mix(in srgb, #f26d6d 70%, var(--t-fg)); --t-done-line: color-mix(in srgb, var(--t-green) 45%, var(--t-bg)); --t-badge-yellow: color-mix(in srgb, #f2c94c 40%, var(--t-fg)); --t-badge-orange: color-mix(in srgb, #f0915a 50%, var(--t-fg)); }
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--t-bg); color: var(--t-fg); }
.term { font: 12px/1.5 ui-monospace, "SF Mono", Menlo, "D2Coding", monospace; min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; }
.bar { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-bottom: 1px solid var(--t-line); color: var(--t-dim); font-size: 11px; }
.bar .dot { width: 10px; height: 10px; border-radius: 50%; }
.bar-title { margin: 0 auto; }
.head { display: flex; justify-content: center; flex-wrap: wrap; gap: 22px; padding: 10px 0 4px; font-weight: 700; letter-spacing: .04em; }
.tools { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 8px 14px 0; min-width: 0; }
.tools .go { margin-top: 0; flex: none; }
.viewer-note { color: var(--t-red); min-width: 0; overflow-wrap: anywhere; }
.k-gate { color: var(--t-yellow); } .k-run { color: var(--t-blue); } .k-wait { color: var(--t-dim); }
.legend { display: flex; justify-content: center; flex-wrap: wrap; gap: 18px; color: var(--t-dim); font-size: 11px; padding-bottom: 10px; }
.legend i { display: inline-block; width: 8px; height: 8px; margin-right: 5px; vertical-align: middle; }
.alert { margin: 0 14px 10px; border: 1px solid var(--t-red); color: var(--t-red); padding: 6px 10px; }
.grid { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 14px; padding: 0 14px 12px; align-items: start; }
.box { border: 1px solid var(--t-line); padding: 8px 10px; background: var(--t-card); }
.conductor { border-color: var(--t-purple); }
.conductor h3 { margin: 0; color: var(--t-purple); font-size: 12px; }
.muted { color: var(--t-dim); }
.ell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kv { display: flex; justify-content: space-between; gap: 8px; }
.sep { height: 10px; }
.rg + .rg { margin-top: 14px; }
.rg-head { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--t-dim); }
.rg-head::after { content: ''; flex: 1; border-top: 1px solid var(--t-line); }
.rg-name { color: var(--t-fg); font-weight: 700; }
.rg-count { padding: 0 6px; border: 1px solid var(--t-line); border-radius: 8px; }
.workers { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; align-items: start; }
.w { border: 1px solid var(--t-line); padding: 8px 9px; min-width: 0; outline: none; background: var(--t-card); }
.w.openable { cursor: pointer; }
.w:focus-visible { box-shadow: 0 0 0 1px var(--t-ring); }
.w.orca { border-color: var(--t-orange); } .w.git { border-color: var(--t-blue); } .w.sub { border-color: var(--t-green); }
.w .t { font-weight: 700; display: grid; }
.w .meta { display: grid; gap: 1px; margin-top: 2px; }
.w .mrow { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 8px; }
.w .t .tid-row { display: flex; align-items: center; gap: 6px; min-width: 0; margin-bottom: 4px; }
.w .t .tid { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.w .t .ttl { white-space: normal; overflow-wrap: anywhere; }
.w.orca .t { color: var(--t-orange); } .w.git .t { color: var(--t-blue); } .w.sub .t { color: var(--t-green); }
.w .t .tid { color: var(--t-bg); background: var(--t-fg); padding: 0 6px; border-radius: 3px; }
.w.orca .t .tid { background: var(--t-orange); } .w.git .t .tid { background: var(--t-blue); } .w.sub .t .tid { background: var(--t-green); }
.chain { display: flex; flex-wrap: wrap; gap: 3px; margin: 6px 0; }
.chip { padding: 0 5px; border: 1px solid var(--t-line); color: var(--t-dim); }
.chip.done { color: var(--t-green); border-color: var(--t-done-line); }
.chip.cur { color: var(--t-bg); background: var(--t-badge-yellow); border-color: var(--t-badge-yellow); font-weight: 700; }
.prog { height: 7px; background: var(--t-fill); margin: 4px 0; }
.prog b { display: block; height: 100%; background: var(--t-blue); }
.prog.gate b { background: var(--t-yellow); } .prog.limit b { background: var(--t-red); }
.prog.unknown { background: repeating-linear-gradient(135deg, var(--t-fill) 0 4px, var(--t-stripe) 4px 8px); }
.todo { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
.todo .prog { margin: 4px 0; }
.work { margin-top: 4px; display: grid; gap: 1px; }
.work .f { overflow-wrap: anywhere; }
.work .f.ov { color: var(--t-yellow); }
.task { display: grid; grid-template-columns: 72px 1fr; gap: 8px; }
.task > span:last-child { overflow-wrap: anywhere; }
.c-err { color: var(--t-red); }
.state { display: flex; justify-content: space-between; gap: 8px; margin-top: 4px; }
.st { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.st.run::before { content: '●'; margin-right: 4px; color: var(--t-blue); animation: blink 1.2s infinite; }
.st.wait, .st.gate { color: var(--t-yellow); } .st.wait::before, .st.gate::before { content: '◷ '; }
.st.limit { color: var(--t-red); } .st.limit::before { content: '■ '; }
.st.idle { color: var(--t-dim); }
.st.deploy { color: var(--t-blue); } .st.deploy::before { content: '⇡ '; }
@keyframes blink { 50% { opacity: .25; } }
.children { margin-top: 8px; border-top: 1px dashed var(--t-line); padding-top: 6px; }
.child { display: flex; justify-content: space-between; gap: 8px; color: var(--t-dim); }
.child::before { content: '└ '; color: var(--t-line); }
.child .ell { flex: 1; min-width: 0; }
.more { margin-top: 6px; border-top: 1px dashed var(--t-line); padding-top: 4px; }
.more > summary { cursor: pointer; color: var(--t-dim); list-style: none; width: max-content; }
.more > summary::-webkit-details-marker { display: none; }
.more > summary::before { content: '▸ '; } .more[open] > summary::before { content: '▾ '; }
.d { display: grid; gap: 2px; margin-top: 4px; }
.dkv { display: grid; grid-template-columns: 72px 1fr; gap: 8px; }
.dkv > span:last-child, .d-ev .r > span:last-child { overflow-wrap: anywhere; }
.d-ev { margin-top: 4px; }
.d-ev .r { display: grid; grid-template-columns: 40px 76px 1fr; gap: 6px; }
.live { margin-top: 6px; border-top: 1px dashed var(--t-line); padding-top: 4px; display: grid; gap: 2px; }
.tail { margin: 4px 0 0; padding: 6px 8px; background: var(--t-fill); border: 1px solid var(--t-line); max-height: 200px; overflow: auto; white-space: pre; font: inherit; font-size: 11px; color: var(--t-fg); }
.go { justify-self: start; margin-top: 6px; font: inherit; font-weight: 700; color: var(--t-bg); background: var(--t-badge-orange); border: 0; padding: 2px 10px; cursor: pointer; }
.copy { font: inherit; font-size: 11px; font-weight: 400; color: var(--t-dim); background: transparent; border: 1px solid var(--t-line); padding: 0 6px; flex: none; cursor: pointer; }
.toast { position: fixed; left: 50%; bottom: 44px; transform: translate(-50%, 6px); padding: 9px 18px; font-size: 14px; font-weight: 600; white-space: nowrap; max-width: calc(100vw - 24px); overflow: hidden; text-overflow: ellipsis; color: var(--t-pop-fg); background: var(--t-pop); border: 1px solid var(--t-pop-line); border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,.35); opacity: 0; pointer-events: none; transition: opacity .15s, transform .15s; z-index: 10; }
.toast.on { opacity: 1; transform: translate(-50%, 0); }
@media (prefers-reduced-motion: reduce) { .toast { transition: none; } }
.copy:hover { color: var(--t-hover-fg); background: var(--t-hover); border-color: var(--t-dim); }
.meta-link { justify-self: start; max-width: 100%; padding: 0; border: 0; background: none; color: var(--t-blue); text-decoration: underline; text-underline-offset: 2px; font: inherit; cursor: pointer; }
.link-actions { position: fixed; inset: auto; position-area: bottom span-right; position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline; margin: 4px 0; padding: 4px; border: 1px solid var(--t-pop-line); border-radius: 6px; background: var(--t-pop); color: var(--t-pop-fg); box-shadow: 0 4px 12px rgba(0,0,0,.33); }
.link-actions button { display: block; width: 100%; border: 0; border-radius: 3px; padding: 4px 8px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.link-actions button:hover, .link-actions button:focus-visible { background: var(--t-hover); color: var(--t-hover-fg); }
.copy:focus-visible, .go:focus-visible, .more > summary:focus-visible { outline: 1px solid var(--t-ring); outline-offset: 2px; }
.lane + .lane { margin-top: 16px; }
.lane-head { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-weight: 700; }
.lane-head::after { content: ''; flex: 1; border-top: 1px solid var(--t-line); }
.lane-head.approval .lane-name { color: var(--t-yellow); } .lane-head.running .lane-name { color: var(--t-blue); }
.lane-head.waiting .lane-name, .lane-head.ended .lane-name { color: var(--t-dim); }
.lane-empty { margin-bottom: 4px; }
.lane.fold > summary { cursor: pointer; list-style: none; }
.lane.fold > summary::-webkit-details-marker { display: none; }
.lane.fold > summary .lane-name::before { content: '▸ '; } .lane.fold[open] > summary .lane-name::before { content: '▾ '; }
.lane.fold > summary:focus-visible { outline: 1px solid var(--t-ring); outline-offset: 2px; }
.lane.approval .w { border-color: var(--t-yellow); }
.gate-info { display: grid; gap: 1px; margin: 2px 0 4px; }
.gi { display: flex; flex-wrap: wrap; gap: 0 10px; }
.gi .g { color: var(--t-yellow); font-weight: 700; }
.gi .ready { color: var(--t-green); }
.stall { color: var(--t-red); }
.rows { display: grid; gap: 4px; }
.w.row { padding: 4px 9px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 18em); gap: 10px; align-items: center; }
.w.row .rt { display: flex; align-items: center; gap: 8px; min-width: 0; }
.w.row .tid { flex: none; color: var(--t-bg); background: var(--t-dim); padding: 0 6px; border-radius: 3px; }
.w.row.orca .tid { background: var(--t-orange); } .w.row.git .tid { background: var(--t-blue); } .w.row.sub .tid { background: var(--t-green); }
.w.row .ttl { min-width: 0; }
.w.row .state { margin-top: 0; min-width: 0; }
.w.row > .more { grid-column: 1 / -1; margin-top: 0; }
.lane.ended .w.row { border-style: dashed; color: var(--t-dim); }
.log { margin: 0 14px 10px; border: 1px solid var(--t-line); padding: 6px 10px; background: var(--t-card); }
.log-rows { max-height: 220px; overflow-y: auto; }
.log .r { display: grid; grid-template-columns: 70px 96px 1fr; gap: 8px; white-space: nowrap; }
.log .r:last-child { animation: fadein .8s; }
@keyframes fadein { from { opacity: 0; } }
.c-ck { color: var(--t-blue); } .c-rp { color: var(--t-green); } .c-wt { color: var(--t-yellow); } .c-gt { color: var(--t-yellow); } .c-bp { color: var(--t-purple); }
.status { display: flex; align-items: center; gap: 18px; padding: 8px 14px 10px; border-top: 1px solid var(--t-line); font-size: 11px; margin-top: auto; }
.status .grow { flex: 1; }
.status .slots { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status b { font-weight: 700; } .b-green { color: var(--t-green); } .b-yellow { color: var(--t-yellow); } .b-purple { color: var(--t-purple); }
.cursor { display: inline-block; width: 7px; height: 12px; background: var(--t-green); animation: blink 1s infinite; }
.empty { color: var(--t-dim); padding: 24px; text-align: center; }
.wc { flex: none; padding: 0 7px; border-radius: 8px; background: transparent; border: 1px solid var(--t-dim); color: var(--t-dim); font-size: 11px; font-weight: 400; }
.kv.slot { padding-left: 6px; }
@media (max-width: 720px) { .grid { grid-template-columns: minmax(0, 1fr); } }
/* 사이드바 폭. 머리글 한 줄, 컨덕터 요약, 네 칸, 최근 이벤트 8줄, 상태줄 순으로 쌓는다 */
@media (max-width: 480px) {
  .term { font-size: 11px; }
  .bar, .legend, .motto, .cmd { display: none; }
  .head { justify-content: flex-start; gap: 10px; padding: 8px 8px 6px; letter-spacing: 0; }
  .tools { justify-content: flex-start; padding: 8px 8px 0; }
  .grid { gap: 8px; padding: 0 8px 8px; }
  .conductor h3 { display: none; }
  .workers { grid-template-columns: 1fr; gap: 8px; }
  .w.row { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .alert { margin: 0 8px 8px; }
  .log { margin: 0 8px 8px; padding: 6px 8px; }
  .log-rows { max-height: none; overflow: visible; }
  .log .r { grid-template-columns: 54px 76px 1fr; gap: 4px; }
  .log .r:nth-last-child(n + 9) { display: none; }
  .status { gap: 10px; padding: 6px 8px 8px; justify-content: flex-end; }
  .status .grow { display: none; }
  .status .slots { display: none; }
}
`
