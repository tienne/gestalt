// 컨덕터 터미널 화면의 마크업. 에디터와 사이드바 패널, 폰 웹 페이지가 이 문자열 하나를 그린다.
// 계산은 terminal-model이 하고 여기는 이스케이프한 HTML 문자열만 만든다. DOM과 오르카 런타임은 모른다.
// 주문 제목이나 게이트 사유는 지라나 PR에서 온 바깥 글이라 전부 esc를 거친다.
import { esc } from './html'
import { ms, OUTDATED_CLI_TEXT, splitRepo } from './model'
import type { AgentState, ConductorView, EventView, WorkerLive, WorkView } from './protocol'
import { clock, duration, eventText, gateLabel, lookup, orderWaitText, terminalModel, waitText, type Card, type TerminalModel } from './terminal-model'

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
  /** 상세를 펼쳐 둔 주문. 웹 페이지는 폴링 스크립트가 data-key로 펼침을 지키니 안 넘긴다 */
  open?: ReadonlySet<string>
  /** 펼친 카드에 붙일 워커 터미널. interactive일 때만 그린다 */
  live?: Readonly<Record<string, WorkerLive | 'loading'>>
}

type Part = string | false | null | undefined
const join = (...parts: Part[]) => parts.filter(Boolean).join('')
const div = (cls: string, ...body: Part[]) => `<div class="${esc(cls)}">${join(...body)}</div>`
const span = (cls: string, text: string) => `<span${cls ? ` class="${esc(cls)}"` : ''}>${esc(text)}</span>`
const kv = (k: string, v: string) => div('kv', span('', k), span('', v))
const SEP = '<div class="sep"></div>'

function conductorBox(v: ConductorView, m: TerminalModel, now: number): string {
  const info = v.conductor
  const tickAt = ms(v.lastTickAt)
  const repos = info?.prWatchRepos?.map((r) => splitRepo(r).name)
  return div(
    'box conductor',
    '<h3>CONDUCTOR</h3>',
    div('muted', esc(info?.pollIntervalSec ? `세션 · tick ${info.pollIntervalSec}s` : '세션')),
    SEP,
    kv('마지막 tick', tickAt === null ? '없음' : `${duration(tickAt, now)} 전`),
    kv('슬롯', m.maxWorkers !== undefined ? `${m.activeWorkers} / ${m.maxWorkers}` : String(m.activeWorkers)),
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

const AGENT_STATE: Record<AgentState, string> = { working: '작업 중', blocked: '권한 대기', waiting: '입력 대기', done: '끝남' }

function liveBlock(o: Card['order'], live: WorkerLive | 'loading' | undefined, now: number): string {
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
const TASK_MARK: Record<string, string> = { completed: '✓', in_progress: '▸', pending: '·' }
const SUB_STATE: Record<string, string> = { running: '실행 중', detached: '백그라운드', done: '끝남' }

/**
 * 상세의 작업 내용. 고친 파일은 둘 다 보여 주고 겹친 파일에 ⚠를 붙인다.
 * todo 제목과 서브에이전트 이름, 최근 tool 호출은 워커가 쓴 글이라 데스크톱에서만 그리고 웹 페이지에는 개수만 싣는다
 */
function workBlock(w: WorkView, opts: TerminalMarkupOptions): string {
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
            ...tasks.items.map((t) => div('task', span('muted', lookup(TASK_MARK, t.status) ?? '·'), span('', t.title)))
          )
        : dkv('todo', `${tasks.done}/${tasks.total}`),
    subs === null
      ? false
      : opts.private && subs.length > 0
        ? join(
            dkv('서브에이전트', String(subs.length)),
            ...subs.map((a) =>
              div('task', span('muted', lookup(SUB_STATE, a.state) ?? a.state), span('', `${a.name} · ${duration(ms(a.startedAt), opts.now)}`))
            )
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
    w.history === 'partial' && div('muted', '트랜스크립트가 길어 끝부분만 읽었어요.')
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
    ...v.gates.filter((g) => g.orderId === o.id).map((g) => dkv(gateLabel(g.type), g.reason)),
    events.length > 0 && div('d-ev', div('muted', '최근 이벤트'), ...events.map((e) => detailEvent(e, opts.private))),
    o.work && workBlock(o.work, opts),
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

function card(c: Card, v: ConductorView, opts: TerminalMarkupOptions): string {
  const o = c.order
  const interactive = opts.interactive
  const canOpen = interactive && Boolean(o.workspaceId)
  const pct = c.progress === null ? null : Math.round(c.progress * 100)
  const attrs = interactive
    ? ` data-order="${esc(o.id)}" data-focus="${esc(`card:${o.id}`)}" tabindex="0" role="group" aria-label="${esc(`${o.id} ${o.title}`)}"${
        canOpen ? ' data-open aria-keyshortcuts="Enter" title="두 번 누르거나 Enter를 누르면 워커 터미널로 가요"' : ''
      }`
    : ''
  const body = join(
    div('t', esc(`${o.id} · ${o.title}`)),
    div('muted ell', esc(c.meta.join(' · '))),
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
    c.next && div('muted ell', esc(`next › ${c.next}`)),
    c.bypass && div('muted ell', esc(`bypass › ${c.bypass}`)),
    c.children.length > 0 &&
      div('children', ...c.children.map((k) => div('child', span('ell', `${k.id} ${k.title}`), span('', k.status)))),
    detail(c, v, opts)
  )
  return `<div class="w ${c.kind}${canOpen ? ' openable' : ''}"${attrs}>${body}</div>`
}

function gateBoxes(m: TerminalModel, v: ConductorView): string {
  if (m.gates.length === 0) return div('gates', div('gbox none', div('muted', '사람 확인'), div('muted', '없음')))
  return div(
    'gates',
    ...m.gates.map((g) => {
      const order = v.orders.find((o) => o.id === g.orderId)
      const target = order?.pr ?? order?.issue ?? g.orderId ?? ''
      return `<div class="gbox" title="${esc(g.reason)}">${join(
        div('g', esc(`${gateLabel(g.type)}${target ? ` · ${target}` : ''}`)),
        div('muted ell', esc(g.reason)),
        div('muted', '사람에게 · approve / reject')
      )}</div>`
    })
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

const EVENT_LABEL: Record<string, string> = { 'gate-opened': 'gate', 'gate-resolved': 'gate ✓' }

/**
 * 인증 없는 폰 페이지에 요약을 싣는 이벤트. report, waiting, bypass 요약은 워커가 쓴 글이라
 * 경로나 토큰이 섞일 수 있어서 시각과 유형, 주문 id만 남긴다
 */
const PUBLIC_SUMMARY = new Set(['checkpoint', 'gate-opened', 'gate-resolved'])
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
    div(
      'head',
      span('', 'GESTALT CONDUCTOR'),
      span('k-orca', `ORCA ${m.kinds.orca}`),
      span('k-git', `GIT ${m.kinds.git}`),
      span('k-sub', `SUBAGENT ${m.kinds.sub}`)
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
      conductorBox(v, m, opts.now),
      div(
        '',
        m.cards.length > 0 ? div('workers', ...m.cards.map((c) => card(c, v, opts))) : div('box muted', '진행 중인 주문이 없어요.'),
        div('flow', '──────── ● ──────── 결과 보고 → tick ──────── ● ────────'),
        gateBoxes(m, v)
      )
    ),
    div('log', div('muted', 'event log'), m.events.length ? div('log-rows', ...m.events.map((e) => eventRow(e, opts.private))) : div('muted', '아직 이벤트가 없어요.')),
    div(
      'status',
      '<span class="cmd">$ gestalt conductor watch <span class="cursor"></span></span>',
      '<span class="grow"></span>',
      `<span>workers <b class="b-green">[${m.activeWorkers}${m.maxWorkers !== undefined ? `/${m.maxWorkers}` : ''}]</b></span>`,
      `<span>gates <b class="b-yellow">[${m.gates.length}]</b></span>`,
      `<span>bypass <b class="b-purple">[${m.bypasses}]</b></span>`
    )
  )
}

/** 터미널 화면의 CSS. 480px 이하면 사이드바 레이아웃(세로로 쌓기, 최근 이벤트 8줄)으로 바뀐다 */
export const TERMINAL_STYLE = `
:root { color-scheme: dark; --t-bg:#14161c; --t-line:#2a2f3a; --t-fg:#c9ced8; --t-dim:#8b93a1; --t-orange:#f0915a; --t-blue:#7aa7ff; --t-green:#5fd38d; --t-purple:#a78bfa; --t-yellow:#f2c94c; --t-red:#f26d6d; }
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--t-bg); color: var(--t-fg); }
.term { font: 12px/1.5 ui-monospace, "SF Mono", Menlo, "D2Coding", monospace; min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; }
.bar { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-bottom: 1px solid var(--t-line); color: var(--t-dim); font-size: 11px; }
.bar .dot { width: 10px; height: 10px; border-radius: 50%; }
.bar-title { margin: 0 auto; }
.head { display: flex; justify-content: center; flex-wrap: wrap; gap: 22px; padding: 10px 0 4px; font-weight: 700; letter-spacing: .04em; }
.k-orca { color: var(--t-orange); } .k-git { color: var(--t-blue); } .k-sub { color: var(--t-green); }
.legend { display: flex; justify-content: center; flex-wrap: wrap; gap: 18px; color: var(--t-dim); font-size: 11px; padding-bottom: 10px; }
.legend i { display: inline-block; width: 8px; height: 8px; margin-right: 5px; vertical-align: middle; }
.alert { margin: 0 14px 10px; border: 1px solid var(--t-red); color: var(--t-red); padding: 6px 10px; }
.grid { display: grid; grid-template-columns: 210px 1fr; gap: 14px; padding: 0 14px 12px; align-items: start; }
.box { border: 1px solid var(--t-line); padding: 8px 10px; }
.conductor { border-color: var(--t-purple); }
.conductor h3 { margin: 0; color: var(--t-purple); font-size: 12px; }
.muted { color: var(--t-dim); }
.ell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kv { display: flex; justify-content: space-between; gap: 8px; }
.sep { height: 10px; }
.workers { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; align-items: start; }
.w { border: 1px solid var(--t-line); padding: 8px 9px; min-width: 0; outline: none; }
.w.openable { cursor: pointer; }
.w:focus-visible { box-shadow: 0 0 0 1px var(--t-fg); }
.w.orca { border-color: var(--t-orange); } .w.git { border-color: var(--t-blue); } .w.sub { border-color: var(--t-green); }
.w .t { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.w.orca .t { color: var(--t-orange); } .w.git .t { color: var(--t-blue); } .w.sub .t { color: var(--t-green); }
.chain { display: flex; flex-wrap: wrap; gap: 3px; margin: 6px 0; }
.chip { padding: 0 5px; border: 1px solid var(--t-line); color: var(--t-dim); }
.chip.done { color: var(--t-green); border-color: #2f5b43; }
.chip.cur { color: #14161c; background: var(--t-yellow); border-color: var(--t-yellow); font-weight: 700; }
.prog { height: 7px; background: #232833; margin: 4px 0; }
.prog b { display: block; height: 100%; background: var(--t-blue); }
.prog.gate b { background: var(--t-yellow); } .prog.limit b { background: var(--t-red); }
.prog.unknown { background: repeating-linear-gradient(135deg, #232833 0 4px, #2f3542 4px 8px); }
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
.tail { margin: 4px 0 0; padding: 6px 8px; background: #0e1015; border: 1px solid var(--t-line); max-height: 200px; overflow: auto; white-space: pre; font: inherit; font-size: 11px; color: var(--t-fg); }
.go { justify-self: start; margin-top: 6px; font: inherit; font-weight: 700; color: var(--t-bg); background: var(--t-orange); border: 0; padding: 2px 10px; cursor: pointer; }
.go:focus-visible, .more > summary:focus-visible { outline: 1px solid var(--t-fg); outline-offset: 2px; }
.flow { display: flex; justify-content: center; color: var(--t-dim); margin: 6px 0; font-size: 11px; white-space: nowrap; overflow: hidden; }
.gates { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
.gbox { border: 1px solid var(--t-yellow); padding: 6px 12px; text-align: center; max-width: 340px; }
.gbox.none { border-color: var(--t-line); }
.gbox .g { color: var(--t-yellow); font-weight: 700; }
.log { margin: 0 14px 10px; border: 1px solid var(--t-line); padding: 6px 10px; }
.log-rows { max-height: 220px; overflow-y: auto; }
.log .r { display: grid; grid-template-columns: 70px 96px 1fr; gap: 8px; white-space: nowrap; }
.log .r:last-child { animation: fadein .8s; }
@keyframes fadein { from { opacity: 0; } }
.c-ck { color: var(--t-blue); } .c-rp { color: var(--t-green); } .c-wt { color: var(--t-yellow); } .c-gt { color: var(--t-yellow); } .c-bp { color: var(--t-purple); }
.status { display: flex; align-items: center; gap: 18px; padding: 8px 14px 10px; border-top: 1px solid var(--t-line); font-size: 11px; margin-top: auto; }
.status .grow { flex: 1; }
.status b { font-weight: 700; } .b-green { color: var(--t-green); } .b-yellow { color: var(--t-yellow); } .b-purple { color: var(--t-purple); }
.cursor { display: inline-block; width: 7px; height: 12px; background: var(--t-green); animation: blink 1s infinite; }
.empty { color: var(--t-dim); padding: 24px; text-align: center; }
@media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
/* 사이드바 폭. 머리글 한 줄, 컨덕터 요약, 카드 세로 목록, 게이트, 최근 이벤트 8줄, 상태줄 순으로 쌓는다 */
@media (max-width: 480px) {
  .term { font-size: 11px; }
  .bar, .legend, .flow, .motto, .cmd { display: none; }
  .head { justify-content: flex-start; gap: 10px; padding: 8px 8px 6px; letter-spacing: 0; }
  .grid { gap: 8px; padding: 0 8px 8px; }
  .conductor h3 { display: none; }
  .workers { grid-template-columns: 1fr; gap: 8px; }
  .gates { flex-direction: column; gap: 6px; margin-top: 8px; }
  .gbox { max-width: none; text-align: left; padding: 6px 8px; }
  .alert { margin: 0 8px 8px; }
  .log { margin: 0 8px 8px; padding: 6px 8px; }
  .log-rows { max-height: none; overflow: visible; }
  .log .r { grid-template-columns: 54px 76px 1fr; gap: 4px; }
  .log .r:nth-last-child(n + 9) { display: none; }
  .status { gap: 10px; padding: 6px 8px 8px; justify-content: flex-end; }
  .status .grow { display: none; }
}
`
