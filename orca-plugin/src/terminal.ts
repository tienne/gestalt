// 에디터 탭에 띄우는 컨덕터 터미널. 어떤 워커가 어느 스킬의 어느 단계에 있는지 터미널 대시보드처럼 그린다.
// 파일 내용은 쓰지 않고 워커가 읽은 상태만 그린다. 주문 제목이나 게이트 사유는 바깥에서 온 글이라 textContent로만 넣는다.
import { ms, OUTDATED_CLI_TEXT, splitRepo } from './model'
import type { ConductorView, EventView } from './protocol'
import { clock, duration, eventText, gateLabel, terminalModel, type Card, type TerminalModel } from './terminal-model'

type State = { view: ConductorView | null; loadError: string | null; openError: string | null }
const state: State = { view: null, loadError: null, openError: null }

type Child = Node | string | null | undefined | false
type Attrs = Record<string, string | boolean | ((e: Event) => void) | undefined>

function el(tag: string, attrs: Attrs | null, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === false) continue
    if (typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v)
    else if (v === true) node.setAttribute(k, '')
    else node.setAttribute(k, v)
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c)
  return node
}

function fill(target: HTMLElement, ...children: Child[]): void {
  target.replaceChildren(...children.filter((c): c is Node | string => Boolean(c)))
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function load(): Promise<void> {
  try {
    state.view = await orca.plugin.request('conductor.status')
    state.loadError = null
  } catch (e) {
    state.loadError = errorText(e)
  }
  render()
}

async function openWorker(orderId: string): Promise<void> {
  state.openError = null
  try {
    const out = await orca.plugin.request('worker.open', { orderId })
    if (!out.opened) state.openError = out.error ?? '워크트리를 못 열었어요'
  } catch (e) {
    state.openError = errorText(e)
  }
  render()
}

const kv = (k: string, v: string) => el('div', { class: 'kv' }, el('span', null, k), el('span', null, v))
const sep = () => el('div', { class: 'sep' })

function conductorBox(v: ConductorView, m: TerminalModel): HTMLElement {
  const info = v.conductor
  const tickAt = ms(v.lastTickAt)
  const lastTick = tickAt === null ? '' : `${duration(tickAt, Date.now())} 전`
  const repos = info?.prWatchRepos?.map((r) => splitRepo(r).name)
  return el(
    'div',
    { class: 'box conductor' },
    el('h3', null, 'CONDUCTOR'),
    el('div', { class: 'muted' }, info?.pollIntervalSec ? `세션 · tick ${info.pollIntervalSec}s` : '세션'),
    sep(),
    kv('마지막 tick', lastTick || '없음'),
    kv('슬롯', m.maxWorkers !== undefined ? `${m.activeWorkers} / ${m.maxWorkers}` : String(m.activeWorkers)),
    kv('대기 주문', String(m.queued)),
    repos && sep(),
    repos && el('div', { class: 'muted' }, 'PR 감시'),
    repos && el('div', null, repos.length ? repos.join(', ') : '없음'),
    info && (info.compactions !== undefined || info.disconnectedWorkers !== undefined) && sep(),
    info?.compactions !== undefined && kv('컴팩트', `${info.compactions}회`),
    info?.disconnectedWorkers !== undefined && kv('끊긴 워커', String(info.disconnectedWorkers)),
    !info && sep(),
    !info && el('div', { class: 'muted' }, '옛 CLI라 슬롯 최대값과 PR 감시, 컴팩트 칸이 빠졌어요.'),
    sep(),
    el('div', { class: 'muted' }, '코드는 안 고친다.', el('br', null), '배정하고 끌고 간다.')
  )
}

function card(c: Card): HTMLElement {
  const o = c.order
  const canOpen = Boolean(o.workspaceId)
  const pct = c.progress === null ? null : Math.round(c.progress * 100)
  return el(
    'div',
    {
      class: `w ${c.kind}${canOpen ? ' openable' : ''}`,
      tabindex: '0',
      title: canOpen ? '두 번 누르면 워크트리로 가요' : undefined,
      onDblclick: canOpen ? () => void openWorker(o.id) : undefined,
      onKeydown: canOpen
        ? (e: Event) => {
            if ((e as KeyboardEvent).key === 'Enter') void openWorker(o.id)
          }
        : undefined
    },
    el('div', { class: 't' }, `${o.id} · ${o.title}`),
    el('div', { class: 'muted ell' }, c.meta.join(' · ')),
    c.chips.length > 0 && el('div', { class: 'chain' }, ...c.chips.map((ch) => el('span', { class: `chip ${ch.state}` }, ch.text))),
    pct !== null && el('div', { class: `prog ${c.state.tone}` }, el('b', { style: `width:${pct}%` })),
    el('div', { class: 'state' }, el('span', { class: `st ${c.state.tone}` }, c.state.text), el('span', { class: 'muted' }, c.state.aside)),
    c.next && el('div', { class: 'muted ell' }, `next › ${c.next}`),
    c.bypass && el('div', { class: 'muted ell' }, `bypass › ${c.bypass}`),
    c.children.length > 0 &&
      el(
        'div',
        { class: 'children' },
        ...c.children.map((k) => el('div', { class: 'child' }, el('span', { class: 'ell' }, `${k.id} ${k.title}`), el('span', null, k.status)))
      )
  )
}

function gateBox(m: TerminalModel, v: ConductorView): HTMLElement {
  if (m.gates.length === 0) return el('div', { class: 'gates' }, el('div', { class: 'gbox none' }, el('div', { class: 'muted' }, '사람 확인'), el('div', { class: 'muted' }, '없음')))
  return el(
    'div',
    { class: 'gates' },
    ...m.gates.map((g) => {
      const order = v.orders.find((o) => o.id === g.orderId)
      const target = order?.pr ?? order?.issue ?? g.orderId ?? ''
      return el(
        'div',
        { class: 'gbox', title: g.reason },
        el('div', { class: 'g' }, `${gateLabel(g.type)}${target ? ` · ${target}` : ''}`),
        el('div', { class: 'muted ell' }, g.reason),
        el('div', { class: 'muted' }, '사람에게 · approve / reject')
      )
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

function eventRow(e: EventView): HTMLElement {
  return el(
    'div',
    { class: 'r' },
    el('span', { class: 'muted' }, clock(e.at, true)),
    el('span', { class: EVENT_TONE[e.type] ?? '' }, EVENT_LABEL[e.type] ?? e.type),
    el('span', { class: 'ell' }, eventText(e))
  )
}

const root = el('div', { class: 'term' })

function draw(): void {
  const v = state.view
  if (!v) {
    root.replaceChildren(el('div', { class: 'empty' }, state.loadError ? `워커에 못 닿았어요. ${state.loadError}` : '불러오는 중'))
    return
  }
  if (v.state === 'missing') {
    root.replaceChildren(el('div', { class: 'empty' }, `${v.stateDir ?? '상태 폴더'}에 events.jsonl이 아직 없어요. 컨덕터가 첫 주문을 받으면 여기에 보여요.`))
    return
  }
  const m = terminalModel(v, Date.now())
  const log = el('div', { class: 'log-rows' }, ...m.events.map(eventRow))
  fill(
    root,
    el(
      'div',
      { class: 'bar' },
      el('span', { class: 'dot', style: 'background:#ff5f57' }),
      el('span', { class: 'dot', style: 'background:#febc2e' }),
      el('span', { class: 'dot', style: 'background:#28c840' }),
      el('span', { class: 'bar-title' }, `conductor · ${m.workers} workers`)
    ),
    el(
      'div',
      { class: 'head' },
      el('span', null, 'GESTALT CONDUCTOR'),
      el('span', { class: 'k-orca' }, `ORCA ${m.kinds.orca}`),
      el('span', { class: 'k-git' }, `GIT ${m.kinds.git}`),
      el('span', { class: 'k-sub' }, `SUBAGENT ${m.kinds.sub}`)
    ),
    el(
      'div',
      { class: 'legend' },
      ...[
        ['var(--t-orange)', 'orca-worktree'],
        ['var(--t-blue)', 'git-worktree'],
        ['var(--t-green)', 'subagent'],
        ['var(--t-purple)', 'conductor'],
        ['var(--t-yellow)', '사람 확인']
      ].map(([color, label]) => el('span', null, el('i', { style: `background:${color}` }), label!))
    ),
    v.state === 'error' && el('div', { class: 'alert' }, `gestalt CLI가 실패했어요. ${v.error ?? ''}`),
    v.outdatedCli && el('div', { class: 'alert' }, OUTDATED_CLI_TEXT),
    state.openError && el('div', { class: 'alert' }, `워크트리를 못 열었어요. ${state.openError}`),
    el(
      'div',
      { class: 'grid' },
      conductorBox(v, m),
      el(
        'div',
        null,
        m.cards.length > 0
          ? el('div', { class: 'workers' }, ...m.cards.map(card))
          : el('div', { class: 'box muted' }, '진행 중인 주문이 없어요.'),
        el('div', { class: 'flow' }, '──────── ● ──────── 결과 보고 → tick ──────── ● ────────'),
        gateBox(m, v)
      )
    ),
    el('div', { class: 'log' }, el('div', { class: 'muted' }, 'event log'), m.events.length ? log : el('div', { class: 'muted' }, '아직 이벤트가 없어요.')),
    el(
      'div',
      { class: 'status' },
      el('span', null, '$ gestalt conductor watch ', el('span', { class: 'cursor' })),
      el('span', { class: 'grow' }),
      el('span', null, 'workers ', el('b', { class: 'b-green' }, `[${m.activeWorkers}${m.maxWorkers !== undefined ? `/${m.maxWorkers}` : ''}]`)),
      el('span', null, 'gates ', el('b', { class: 'b-yellow' }, `[${m.gates.length}]`)),
      el('span', null, 'bypass ', el('b', { class: 'b-purple' }, `[${m.bypasses}]`))
    )
  )
  log.scrollTop = log.scrollHeight
}

function render(): void {
  const focused = document.activeElement
  const keep = focused && root.contains(focused) ? focused.querySelector('.t')?.textContent : null
  draw()
  if (!keep) return
  for (const n of Array.from(root.querySelectorAll<HTMLElement>('.w'))) {
    if (n.querySelector('.t')?.textContent === keep) return n.focus()
  }
}

const style = document.createElement('style')
style.textContent = `
:root { color-scheme: dark; --t-bg:#14161c; --t-line:#2a2f3a; --t-fg:#c9ced8; --t-dim:#6b7280; --t-orange:#f0915a; --t-blue:#7aa7ff; --t-green:#5fd38d; --t-purple:#a78bfa; --t-yellow:#f2c94c; --t-red:#f26d6d; }
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--t-bg); color: var(--t-fg); }
.term { font: 12px/1.5 ui-monospace, "SF Mono", Menlo, "D2Coding", monospace; min-height: 100vh; display: flex; flex-direction: column; }
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
.workers { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
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
`
document.head.append(style)
document.body.append(root)

orca.plugin.on('conductor.changed', (next) => {
  state.view = next
  state.loadError = null
  render()
})
render()
// 파일 내용은 쓰지 않지만 오르카는 에디터가 문서를 받아 가야 다 떴다고 본다
void orca.document?.get()
void load()
