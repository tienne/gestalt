// 컨덕터 터미널 화면의 마크업. 에디터와 사이드바 패널, 폰 웹 페이지가 이 문자열 하나를 그린다.
// 계산은 terminal-model이 하고 여기는 이스케이프한 HTML 문자열만 만든다. DOM과 오르카 런타임은 모른다.
// 주문 제목이나 게이트 사유는 지라나 PR에서 온 바깥 글이라 전부 esc를 거친다.
import { esc } from './html'
import { ms, OUTDATED_CLI_TEXT, splitRepo } from './model'
import type { ConductorView, EventView } from './protocol'
import { clock, duration, eventText, gateLabel, terminalModel, type Card, type TerminalModel } from './terminal-model'

export type TerminalMarkupOptions = {
  now: number
  /** 카드를 두 번 눌러 워크트리로 가는 화면(에디터와 패널). 웹 페이지는 보기 전용이라 끈다 */
  interactive: boolean
  /** 인증 없는 웹 페이지는 저장소 경로와 CLI 오류 원문을 싣지 않는다. 홈 경로에 사용자 이름이 들어 있다 */
  private: boolean
  loadError?: string | null
  openError?: string | null
}

type Part = string | false | null | undefined
const join = (...parts: Part[]) => parts.filter(Boolean).join('')
const div = (cls: string, ...body: Part[]) => `<div class="${cls}">${join(...body)}</div>`
const span = (cls: string, text: string) => `<span${cls ? ` class="${cls}"` : ''}>${esc(text)}</span>`
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
    !info && SEP,
    !info && div('muted', '옛 CLI라 슬롯 최대값과 PR 감시, 컴팩트 칸이 빠졌어요.'),
    '<div class="sep motto"></div>',
    div('muted motto', '코드는 안 고친다.<br>배정하고 끌고 간다.')
  )
}

function card(c: Card, interactive: boolean): string {
  const o = c.order
  const canOpen = interactive && Boolean(o.workspaceId)
  const pct = c.progress === null ? null : Math.round(c.progress * 100)
  const attrs = interactive
    ? ` data-order="${esc(o.id)}" tabindex="0"${canOpen ? ' data-open title="두 번 누르면 워크트리로 가요"' : ''}`
    : ''
  const body = join(
    div('t', esc(`${o.id} · ${o.title}`)),
    div('muted ell', esc(c.meta.join(' · '))),
    c.chips.length > 0 && div('chain', ...c.chips.map((ch) => span(`chip ${ch.state}`, ch.text))),
    pct !== null && `<div class="prog ${c.state.tone}"><b style="width:${pct}%"></b></div>`,
    div('state', span(`st ${c.state.tone}`, c.state.text), span('muted', c.state.aside)),
    c.next && div('muted ell', esc(`next › ${c.next}`)),
    c.bypass && div('muted ell', esc(`bypass › ${c.bypass}`)),
    c.children.length > 0 &&
      div('children', ...c.children.map((k) => div('child', span('ell', `${k.id} ${k.title}`), span('', k.status))))
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

const eventRow = (e: EventView) =>
  div('r', span('muted', clock(e.at, true)), span(EVENT_TONE[e.type] ?? '', EVENT_LABEL[e.type] ?? e.type), span('ell', eventText(e)))

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
  const m = terminalModel(v, opts.now)
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
    opts.openError && div('alert', esc(`워크트리를 못 열었어요. ${opts.openError}`)),
    div(
      'grid',
      conductorBox(v, m, opts.now),
      div(
        '',
        m.cards.length > 0 ? div('workers', ...m.cards.map((c) => card(c, opts.interactive))) : div('box muted', '진행 중인 주문이 없어요.'),
        div('flow', '──────── ● ──────── 결과 보고 → tick ──────── ● ────────'),
        gateBoxes(m, v)
      )
    ),
    div('log', div('muted', 'event log'), m.events.length ? div('log-rows', ...m.events.map(eventRow)) : div('muted', '아직 이벤트가 없어요.')),
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
