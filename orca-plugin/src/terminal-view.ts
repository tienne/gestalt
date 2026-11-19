// 에디터 탭과 사이드바 패널의 컨덕터 터미널. 마크업은 terminal-markup이 문자열로 만들고 여기는 띄우기와 클릭만 맡는다.
// 폭에 따른 차이는 TERMINAL_STYLE의 미디어 쿼리에만 있다.
import type { ConductorView } from './protocol'
import { TERMINAL_STYLE, terminalMarkup } from './terminal-markup'

type State = { view: ConductorView | null; loadError: string | null; openError: string | null }
const state: State = { view: null, loadError: null, openError: null }

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

function render(): void {
  const focused = document.activeElement
  const keep = focused instanceof HTMLElement && root.contains(focused) ? focused.dataset['order'] : undefined
  // 바깥 글은 terminalMarkup이 전부 이스케이프해서 넘긴다
  root.innerHTML = terminalMarkup(state.view, {
    now: Date.now(),
    interactive: true,
    private: true,
    loadError: state.loadError,
    openError: state.openError
  })
  const log = root.querySelector('.log-rows')
  if (log) log.scrollTop = log.scrollHeight
  if (!keep) return
  for (const n of Array.from(root.querySelectorAll<HTMLElement>('.w[data-order]'))) {
    if (n.dataset['order'] === keep) return n.focus()
  }
}

/** 두 번 누르거나 Enter를 누른 카드의 주문 id. 워크트리를 못 찾은 카드는 data-open이 없다 */
function openTarget(e: Event): string | undefined {
  const cardEl = (e.target as Element | null)?.closest<HTMLElement>('.w[data-open]')
  return cardEl?.dataset['order']
}

/** 화면을 띄우고 워커가 보내는 상태를 따라 다시 그린다. 에디터와 패널이 진입점에서 한 번 부른다 */
export function mountTerminal(): void {
  const style = document.createElement('style')
  style.textContent = TERMINAL_STYLE
  document.head.append(style)
  document.body.append(root)
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
