// 에디터 탭과 사이드바 패널의 컨덕터 터미널. 마크업은 terminal-markup이 문자열로 만들고 여기는 띄우기와 클릭만 맡는다.
// 폭에 따른 차이는 TERMINAL_STYLE의 미디어 쿼리에만 있다.
import type { ConductorView, WorkerLive } from './protocol'
import { TERMINAL_STYLE, terminalMarkup } from './terminal-markup'
import { terminalModel } from './terminal-model'

/** 상세를 펼쳐 둔 동안 워커 터미널을 다시 읽는 간격 */
const LIVE_POLL_MS = 4000
/** 상태가 안 바뀌어도 경과 시간과 마지막 tick 표시를 새로 그리는 간격 */
const CLOCK_MS = 30_000

type State = {
  view: ConductorView | null
  loadError: string | null
  openError: string | null
  openNote: string | null
  open: Set<string>
  live: Record<string, WorkerLive | 'loading'>
}
const state: State = { view: null, loadError: null, openError: null, openNote: null, open: new Set(), live: {} }
const inflight = new Set<string>()
let poll: ReturnType<typeof setInterval> | null = null
let clockTimer: ReturnType<typeof setInterval> | null = null
let lastMarkup = ''

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const root = document.createElement('div')
root.className = 'term'
// root는 다시 그릴 때마다 통째로 바뀌어서 스크린 리더가 안내를 놓친다. 안내는 바깥의 고정 영역에 따로 싣는다
const SR_ONLY = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap'
const statusRegion = Object.assign(document.createElement('div'), { role: 'status' })
const alertRegion = Object.assign(document.createElement('div'), { role: 'alert' })
for (const r of [statusRegion, alertRegion]) r.style.cssText = SR_ONLY
statusRegion.setAttribute('aria-live', 'polite')

async function load(): Promise<void> {
  try {
    state.view = await orca.plugin.request('conductor.status')
    state.loadError = null
  } catch (e) {
    state.loadError = errorText(e)
  }
  pruneOpen()
  render()
}

async function openWorker(orderId: string): Promise<void> {
  state.openError = null
  state.openNote = null
  try {
    const out = await orca.plugin.request('worker.open', { orderId })
    if (!out.opened) state.openError = out.error ?? '이유를 못 받았어요.'
    else if (out.fallbackTerminal) state.openNote = '워커 에이전트를 못 찾아 워크트리의 첫 터미널로 옮겼어요. 워커 터미널이 아닐 수 있어요.'
    else if (out.worktreeOnly) state.openNote = out.error ?? '워크트리만 열었어요.'
  } catch (e) {
    state.openError = errorText(e)
  }
  render()
  // 같은 문장이 다시 와도 읽히도록 비웠다가 싣는다
  statusRegion.textContent = ''
  alertRegion.textContent = ''
  if (state.openError) alertRegion.textContent = `워크트리를 못 열었어요. ${state.openError}`
  else if (state.openNote) statusRegion.textContent = state.openNote
}

const hasWorkspace = (orderId: string) => Boolean(state.view?.orders.find((o) => o.id === orderId)?.workspaceId)

/** 워커 터미널을 다시 읽는다. 그리기는 부른 쪽이 한 번에 한다 */
async function readLive(orderId: string): Promise<void> {
  if (inflight.has(orderId) || !hasWorkspace(orderId)) return
  inflight.add(orderId)
  // 읽는 사이 접었으면 결과를 버린다. 남겨 두면 다시 펼칠 때 지난 출력이 잠깐 보인다
  try {
    const live = await orca.plugin.request('worker.detail', { orderId })
    if (state.open.has(orderId)) state.live[orderId] = live
  } catch (e) {
    if (state.open.has(orderId)) state.live[orderId] = { found: true, error: `워커에 못 닿았어요. ${errorText(e)}` }
  } finally {
    inflight.delete(orderId)
  }
}

async function readOpen(): Promise<void> {
  await Promise.all(Array.from(state.open, (id) => readLive(id)))
  // 결과가 같아도 경과 시간은 흐르니 다시 그린다. 마크업이 그대로면 render가 건너뛴다
  render()
}

/** 끝나서 카드가 사라진 주문은 펼침과 읽어 둔 터미널을 걷는다. 안 걷으면 안 보이는 카드를 4초마다 읽는다 */
function pruneOpen(): void {
  if (state.open.size > 0) {
    const cards = state.view ? new Set(terminalModel(state.view, Date.now()).cards.map((c) => c.order.id)) : new Set<string>()
    for (const id of state.open) if (!cards.has(id)) state.open.delete(id)
  }
  for (const id of Object.keys(state.live)) if (!state.open.has(id)) delete state.live[id]
  syncPoll()
}

function startClock(): void {
  clockTimer ??= setInterval(() => {
    if (document.visibilityState !== 'hidden') render()
  }, CLOCK_MS)
}

function stopTimers(): void {
  if (poll) clearInterval(poll)
  if (clockTimer) clearInterval(clockTimer)
  poll = null
  clockTimer = null
}

function syncPoll(): void {
  if (state.open.size > 0 && !poll) {
    poll = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void readOpen()
    }, LIVE_POLL_MS)
  } else if (state.open.size === 0 && poll) {
    clearInterval(poll)
    poll = null
  }
}

function render(): void {
  // 바깥 글과 터미널 출력은 terminalMarkup이 전부 이스케이프해서 넘긴다
  const markup = terminalMarkup(state.view, {
    now: Date.now(),
    interactive: true,
    private: true,
    loadError: state.loadError,
    openError: state.openError,
    openNote: state.openNote,
    open: state.open,
    live: state.live
  })
  // 같은 마크업을 다시 넣으면 터미널 출력에서 고르던 글자와 포커스가 날아간다
  if (markup === lastMarkup) return
  lastMarkup = markup
  const focused = document.activeElement
  const keep = focused instanceof HTMLElement && root.contains(focused) ? focused.dataset['focus'] : undefined
  // 읽던 터미널 출력이 맨 아래에 있었으면 새 줄을 따라가고 위로 올려 읽던 중이면 그 자리를 지킨다
  const tails = new Map<string, number | 'end'>()
  for (const t of Array.from(root.querySelectorAll<HTMLElement>('.tail[data-tail]'))) {
    const atEnd = t.scrollTop + t.clientHeight >= t.scrollHeight - 4
    tails.set(t.dataset['tail']!, atEnd ? 'end' : t.scrollTop)
  }
  root.innerHTML = markup
  const log = root.querySelector('.log-rows')
  if (log) log.scrollTop = log.scrollHeight
  for (const t of Array.from(root.querySelectorAll<HTMLElement>('.tail[data-tail]'))) {
    const was = tails.get(t.dataset['tail']!)
    t.scrollTop = was === undefined || was === 'end' ? t.scrollHeight : was
  }
  if (!keep) return
  for (const n of Array.from(root.querySelectorAll<HTMLElement>('[data-focus]'))) {
    if (n.dataset['focus'] === keep) return n.focus()
  }
}

/** 두 번 누른 카드의 주문 id. 워크트리를 못 찾은 카드는 data-open이 없고 상세 안은 제 할 일이 따로 있다 */
function openTarget(e: Event): string | undefined {
  const target = e.target as Element | null
  if (target?.closest('.more')) return undefined
  return target?.closest<HTMLElement>('.w[data-open]')?.dataset['order']
}

/** 펼침과 접힘. details의 toggle은 버블링하지 않아서 캡처 단계에서 받는다 */
function onToggle(e: Event): void {
  const d = e.target
  if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('more')) return
  const id = d.dataset['key']?.replace(/^ord:/, '')
  if (!id) return
  if (d.open && !state.open.has(id)) {
    state.open.add(id)
    if (!state.live[id]) state.live[id] = 'loading'
    void readLive(id).then(() => render())
  } else if (!d.open && state.open.has(id)) {
    state.open.delete(id)
  }
  syncPoll()
}

/** 화면을 띄우고 워커가 보내는 상태를 따라 다시 그린다. 에디터와 패널이 진입점에서 한 번 부른다 */
export function mountTerminal(): void {
  const style = document.createElement('style')
  style.textContent = TERMINAL_STYLE
  document.head.append(style)
  document.body.append(root, statusRegion, alertRegion)
  root.addEventListener('toggle', onToggle, true)
  root.addEventListener('click', (e) => {
    const go = (e.target as Element | null)?.closest<HTMLElement>('[data-go]')
    if (go?.dataset['go']) void openWorker(go.dataset['go'])
  })
  root.addEventListener('dblclick', (e) => {
    const id = openTarget(e)
    if (id) void openWorker(id)
  })
  root.addEventListener('keydown', (e) => {
    // 카드 안의 상세 요약이나 버튼에서 누른 Enter는 그 요소가 처리한다
    if (e.key !== 'Enter' || !(e.target instanceof HTMLElement) || !e.target.matches('.w[data-open]')) return
    const id = e.target.dataset['order']
    if (id) void openWorker(id)
  })
  orca.plugin.on('conductor.changed', (next) => {
    state.view = next
    state.loadError = null
    pruneOpen()
    render()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    syncPoll()
    if (state.open.size > 0) void readOpen()
    else render()
  })
  window.addEventListener('pagehide', stopTimers)
  // 뒤로 가기 캐시에서 돌아오면 pagehide가 멈춘 타이머를 다시 건다
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return
    startClock()
    syncPoll()
    void readOpen()
  })
  startClock()
  render()
  void load()
}
