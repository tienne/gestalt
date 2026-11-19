// 에디터 탭과 사이드바 패널의 컨덕터 터미널. 마크업은 terminal-markup이 문자열로 만들고 여기는 띄우기와 클릭만 맡는다.
// 폭에 따른 차이는 TERMINAL_STYLE의 미디어 쿼리에만 있다.
import type { ConductorView, WorkerLive } from './protocol'
import { TERMINAL_STYLE, terminalMarkup } from './terminal-markup'

/** 상세를 펼쳐 둔 동안 워커 터미널을 다시 읽는 간격 */
const LIVE_POLL_MS = 4000

type State = {
  view: ConductorView | null
  loadError: string | null
  openError: string | null
  open: Set<string>
  live: Record<string, WorkerLive | 'loading'>
}
const state: State = { view: null, loadError: null, openError: null, open: new Set(), live: {} }
const inflight = new Set<string>()
let poll: ReturnType<typeof setInterval> | null = null

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const root = document.createElement('div')
root.className = 'term'

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

const hasWorkspace = (orderId: string) => Boolean(state.view?.orders.find((o) => o.id === orderId)?.workspaceId)

async function readLive(orderId: string): Promise<void> {
  if (inflight.has(orderId) || !hasWorkspace(orderId)) return
  inflight.add(orderId)
  try {
    state.live[orderId] = await orca.plugin.request('worker.detail', { orderId })
  } catch (e) {
    state.live[orderId] = { found: true, error: `워커에 못 닿았어요. ${errorText(e)}` }
  } finally {
    inflight.delete(orderId)
  }
  if (state.open.has(orderId)) render()
}

function syncPoll(): void {
  if (state.open.size > 0 && !poll) {
    poll = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      for (const id of state.open) void readLive(id)
    }, LIVE_POLL_MS)
  } else if (state.open.size === 0 && poll) {
    clearInterval(poll)
    poll = null
  }
}

function render(): void {
  const focused = document.activeElement
  const keep = focused instanceof HTMLElement && root.contains(focused) ? focused.dataset['order'] : undefined
  // 읽던 터미널 출력이 맨 아래에 있었으면 새 줄을 따라가고 위로 올려 읽던 중이면 그 자리를 지킨다
  const tails = new Map<string, number | 'end'>()
  for (const t of Array.from(root.querySelectorAll<HTMLElement>('.tail[data-tail]'))) {
    const atEnd = t.scrollTop + t.clientHeight >= t.scrollHeight - 4
    tails.set(t.dataset['tail']!, atEnd ? 'end' : t.scrollTop)
  }
  // 바깥 글과 터미널 출력은 terminalMarkup이 전부 이스케이프해서 넘긴다
  root.innerHTML = terminalMarkup(state.view, {
    now: Date.now(),
    interactive: true,
    private: true,
    loadError: state.loadError,
    openError: state.openError,
    open: state.open,
    live: state.live
  })
  const log = root.querySelector('.log-rows')
  if (log) log.scrollTop = log.scrollHeight
  for (const t of Array.from(root.querySelectorAll<HTMLElement>('.tail[data-tail]'))) {
    const was = tails.get(t.dataset['tail']!)
    t.scrollTop = was === undefined || was === 'end' ? t.scrollHeight : was
  }
  if (!keep) return
  for (const n of Array.from(root.querySelectorAll<HTMLElement>('.w[data-order]'))) {
    if (n.dataset['order'] === keep) return n.focus()
  }
}

/** 두 번 누르거나 Enter를 누른 카드의 주문 id. 워크트리를 못 찾은 카드는 data-open이 없고 상세 안은 제 할 일이 따로 있다 */
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
    void readLive(id)
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
  document.body.append(root)
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
    if (e.key !== 'Enter') return
    const id = openTarget(e)
    if (id) void openWorker(id)
  })
  orca.plugin.on('conductor.changed', (next) => {
    state.view = next
    state.loadError = null
    render()
  })
  render()
  void load()
}
