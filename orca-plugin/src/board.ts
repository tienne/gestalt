// 에디터 탭에 띄우는 넓은 컨덕터 보드. 파일 내용은 쓰지 않고 워커가 읽은 상태만 그린다.
import {
  buildHierarchy,
  findNode,
  orderKey,
  pruneHierarchy,
  type HierarchyNode
} from './hierarchy'
import { ago, isTerminal, ms, splitRepo, STATUS_LABEL, STATUS_TONE, summarize, type RepoSummary } from './model'
import type {
  Bypass,
  ConductorView,
  GateDecision,
  GateResolveResult,
  GateView,
  OrderRemoveResult,
  OrderView
} from './protocol'

const RESOLVE_TIMEOUT_MS = 120_000
const DECISION_LABEL: Record<GateDecision, string> = { approve: '승인', reject: '거절' }

type State = {
  view: ConductorView | null
  loadError: string | null
  selected: string | null
  showDone: boolean
  pending: { gateId: string; decision: GateDecision } | null
  busy: string | null
  answers: Record<string, string>
  result: GateResolveResult | null
  openError: string | null
  /** 지우기 확인을 기다리는 자리. 주문 하나면 'order:<id>', 레포의 끝난 주문 전부면 'repo:<레포>' */
  removing: { key: string; ids: string[] } | null
  removeBusy: boolean
  removeResult: OrderRemoveResult | null
  /** 다음 그리기 뒤에 포커스를 줄 data-focus 값. 확인 칸이 처음 뜨거나 닫힐 때만 쓴다 */
  focusNext: string | null
}

const state: State = {
  view: null,
  loadError: null,
  selected: null,
  showDone: false,
  pending: null,
  busy: null,
  answers: {},
  result: null,
  openError: null,
  removing: null,
  removeBusy: false,
  removeResult: null,
  focusNext: null
}

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

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** null을 걸러 내고 자식을 갈아 끼운다. 컨테이너는 그대로 둬서 스크롤 위치가 남는다 */
function fill(target: HTMLElement, ...children: Child[]): void {
  target.replaceChildren(...children.filter((c): c is Node | string => Boolean(c)))
}

const pill = (text: string, tone = 'neutral') => el('span', { class: `pill tone-${tone}` }, text)

/** 그리기마다 갈아 끼우지 않는 알림 자리. 결과 문구를 화면 낭독기에 한 번만 읽힌다 */
const live = el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' })
const announce = (text: string) => {
  live.textContent = text
}

async function load(name: 'conductor.status' | 'conductor.refresh'): Promise<void> {
  try {
    state.view = await orca.plugin.request(name)
    state.loadError = null
  } catch (e) {
    state.loadError = errorText(e)
  }
  render()
}

async function resolve(gate: GateView, decision: GateDecision): Promise<void> {
  const answer = state.answers[gate.id]?.trim()
  state.busy = gate.id
  render()
  try {
    state.result = await orca.plugin.request(
      'gate.resolve',
      { gateId: gate.id, decision, ...(answer ? { answer } : {}) },
      { timeoutMs: RESOLVE_TIMEOUT_MS }
    )
  } catch (e) {
    state.result = { ok: false, gateId: gate.id, decision, hostActions: [], errors: [], error: errorText(e) }
  } finally {
    state.busy = null
    state.pending = null
    state.focusNext = 'close-result'
    announce(`${gate.id} ${DECISION_LABEL[decision]} ${state.result?.ok ? '완료' : '실패'}`)
    render()
  }
}

async function openWorker(orderId: string): Promise<void> {
  state.openError = null
  try {
    const out = await orca.plugin.request('worker.open', { orderId })
    if (!out.opened) state.openError = out.error ?? '워크트리를 못 열었어요'
  } catch (e) {
    state.openError = errorText(e)
  }
  if (state.openError) announce(`워크트리를 못 열었어요. ${state.openError}`)
  render()
}

async function removeOrders(ids: string[]): Promise<void> {
  if (state.removeBusy) return
  state.removeBusy = true
  render()
  try {
    state.removeResult = await orca.plugin.request('order.remove', { orderIds: ids }, { timeoutMs: RESOLVE_TIMEOUT_MS })
  } catch (e) {
    state.removeResult = { ok: false, removed: [], skipped: [], error: errorText(e) }
  } finally {
    state.removeBusy = false
    state.removing = null
    state.focusNext = 'close-remove'
    const r = state.removeResult
    announce(r?.ok && r.removed.length > 0 ? `주문 ${r.removed.length}개를 지웠어요` : '못 지웠어요')
    render()
  }
}

function askRemove(key: string, ids: string[]): void {
  state.removeResult = null
  state.removing = { key, ids }
  state.focusNext = `cancel:${key}`
  render()
}

function select(key: string | null): void {
  state.selected = state.selected === key ? null : key
  state.pending = null
  state.removing = null
  render()
}

const root = el('div', { class: 'board' })
const header = el('header', { class: 'top' })
const map = el('main', { class: 'map' })
const side = el('aside', { class: 'side' })
root.append(header, el('div', { class: 'body' }, map, side), live)

function renderHeader(v: ConductorView | null): void {
  const active = v ? v.orders.filter((o) => !isTerminal(o.status)).length : 0
  const repos = v ? summarize(v).repos.length : 0
  const tick = ms(v?.lastTickAt)
  fill(
    header,
    el('h1', null, '컨덕터 보드'),
    v ? pill(`확인 대기 ${v.gates.length}`, v.gates.length > 0 ? 'warning' : 'neutral') : null,
    v ? pill(`진행 중 주문 ${active}`, 'accent') : null,
    v ? el('span', { class: 'muted' }, `레포 ${repos}곳`) : null,
    tick !== null ? el('span', { class: 'muted' }, `tick ${ago(tick)}`) : null,
    el('span', { class: 'grow' }),
    el(
      'label',
      { class: 'toggle' },
      el('input', {
        type: 'checkbox',
        'data-focus': 'show-done',
        checked: state.showDone,
        onChange: (e) => {
          state.showDone = (e.target as HTMLInputElement).checked
          render()
        }
      }),
      '끝난 주문도 보기'
    ),
    el('button', { class: 'btn', 'data-focus': 'refresh', onClick: () => void load('conductor.refresh') }, '새로고침')
  )
}

function orderButton(o: OrderView, gates: number): HTMLElement {
  const tone = STATUS_TONE[o.status] ?? 'neutral'
  const key = orderKey(o.id)
  return el(
    'button',
    {
      class: `node order tone-${tone}${state.selected === key ? ' selected' : ''}${isTerminal(o.status) ? ' faded' : ''}`,
      'data-focus': `node:${key}`,
      'aria-pressed': state.selected === key ? 'true' : 'false',
      title: o.workspaceId ? `${o.id} 자세히 보기, 두 번 누르면 워크트리로 이동` : `${o.id} 자세히 보기`,
      onClick: () => select(key),
      onDblclick: o.workspaceId ? () => void openWorker(o.id) : undefined
    },
    el(
      'span',
      { class: 'node-head' },
      el('span', { class: 'dot' }),
      el('span', { class: 'node-title' }, o.title || '(제목 없음)'),
      gates > 0 ? pill(`확인 ${gates}`, 'warning') : null
    ),
    el(
      'span',
      { class: 'node-meta' },
      `${STATUS_LABEL[o.status] ?? o.status} · ${o.id}`,
      o.branch ? ` · ${o.branch}` : '',
      o.pr ? ` · PR ${o.pr}` : ''
    )
  )
}

function orderRow(o: OrderView, gates: number): HTMLElement {
  const node = orderButton(o, gates)
  if (!o.workspaceId) return node
  return el(
    'div',
    { class: 'node-row' },
    node,
    el(
      'button',
      {
        class: 'node-open',
        'data-focus': `open:${o.id}`,
        title: '워커의 오르카 워크트리와 터미널로 이동',
        'aria-label': `${o.title || o.id} 워크트리로 이동`,
        onClick: () => void openWorker(o.id)
      },
      '↗'
    )
  )
}

function worktreeButton(n: Extract<HierarchyNode, { kind: 'worktree' }>): HTMLElement {
  return el(
    'button',
    {
      class: `node worktree${state.selected === n.key ? ' selected' : ''}`,
      'data-focus': `node:${n.key}`,
      'aria-pressed': state.selected === n.key ? 'true' : 'false',
      title: n.path,
      onClick: () => select(n.key)
    },
    el('span', { class: 'node-head' }, el('span', { class: 'glyph' }, '⎇'), el('span', { class: 'node-title' }, n.label)),
    el('span', { class: 'node-meta' }, n.branch ? `부모 워크트리 · ${n.branch}` : '부모 워크트리')
  )
}

function tree(nodes: readonly HierarchyNode[], gateCount: Map<string, number>): HTMLElement {
  return el(
    'ul',
    { class: 'tree' },
    ...nodes.map((n) =>
      el(
        'li',
        null,
        n.kind === 'order' ? orderRow(n.order, gateCount.get(n.order.id) ?? 0) : worktreeButton(n),
        n.children.length > 0 ? tree(n.children, gateCount) : null
      )
    )
  )
}

function repoCard(s: RepoSummary, gateCount: Map<string, number>): HTMLElement {
  const { name, owner } = splitRepo(s.repo)
  const all = buildHierarchy(s.orders)
  const shown = state.showDone ? all : pruneHierarchy(all, (o) => !isTerminal(o.status))
  const hidden = s.orders.length - s.orders.filter((o) => state.showDone || !isTerminal(o.status)).length
  const finished = s.orders.filter((o) => isTerminal(o.status)).map((o) => o.id)
  const tone = s.needsPerson > 0 ? 'warning' : s.active > 0 ? 'accent' : 'neutral'
  return el(
    'section',
    { class: `repo tone-${tone}` },
    el(
      'div',
      { class: 'repo-head' },
      el(
        'div',
        null,
        el('h2', null, name),
        s.project || owner ? el('div', { class: 'muted small' }, [s.project, owner].filter(Boolean).join(' · ')) : null
      ),
      el(
        'div',
        { class: 'pills' },
        s.gates.length > 0 ? pill(`확인 대기 ${s.gates.length}`, 'warning') : null,
        s.active > 0 ? pill(`진행 ${s.active}`, 'accent') : null,
        s.nested > 0 ? pill(`하위 ${s.nested}`) : null
      )
    ),
    shown.length > 0 ? tree(shown, gateCount) : el('div', { class: 'muted small' }, '진행 중인 주문이 없어요'),
    hidden > 0 || finished.length > 0
      ? el(
          'div',
          { class: 'repo-foot' },
          hidden > 0 ? el('span', { class: 'muted small' }, `끝난 주문 ${hidden}개 숨김`) : el('span', null),
          finished.length > 0
            ? el(
                'button',
                { class: 'btn danger-outline xs', 'data-focus': `remove:repo:${s.repo}`, disabled: state.removeBusy, onClick: () => askRemove(`repo:${s.repo}`, finished) },
                `끝난 주문 ${finished.length}개 지우기`
              )
            : null
        )
      : null,
    removeConfirm(`repo:${s.repo}`)
  )
}

/** 지우기 버튼을 누른 자리에만 뜨는 확인 칸 */
function removeConfirm(at: string): HTMLElement | null {
  const r = state.removing
  if (r?.key !== at) return null
  const titleId = `confirm-${at}`
  return el(
    'div',
    { class: 'confirm tone-danger', role: 'group', 'aria-labelledby': titleId },
    el('strong', { id: titleId }, r.ids.length > 1 ? `끝난 주문 ${r.ids.length}개를 지울까요?` : '이 주문을 지울까요?'),
    el('div', { class: 'small' }, '컨덕터 저장소에서 지워져 다시 볼 수 없어요. 같은 지라 티켓이나 PR로 주문이 다시 생기지도 않아요. 워크트리와 브랜치는 그대로 남아요.'),
    el(
      'div',
      { class: 'row' },
      el('button', { class: 'btn danger', 'data-focus': `confirm:${at}`, disabled: state.removeBusy, onClick: () => void removeOrders(r.ids) }, state.removeBusy ? '지우는 중' : '지우기 확정'),
      el(
        'button',
        {
          class: 'btn ghost',
          'data-focus': `cancel:${at}`,
          disabled: state.removeBusy,
          onClick: () => {
            state.removing = null
            state.focusNext = `remove:${at}`
            render()
          }
        },
        '취소'
      )
    )
  )
}

function removeResultBlock(r: OrderRemoveResult): HTMLElement {
  const ok = r.ok && r.removed.length > 0
  return el(
    'div',
    { class: `result tone-${ok ? (r.skipped.length > 0 ? 'warning' : 'success') : 'danger'}` },
    el('strong', null, ok ? `주문 ${r.removed.length}개를 지웠어요` : '못 지웠어요'),
    !r.ok && r.error ? el('div', { class: 'small' }, r.error) : null,
    r.skipped.length > 0
      ? el('div', { class: 'small' }, el('b', null, `${r.skipped.length}개는 남겼어요`), lines(r.skipped.map((x) => x.reason)))
      : null,
    el('button', { class: 'btn ghost', 'data-focus': 'close-remove', onClick: () => { state.removeResult = null; render() } }, '닫기')
  )
}

function renderMap(v: ConductorView): void {
  const { repos } = summarize(v)
  const gateCount = new Map<string, number>()
  for (const g of v.gates) if (g.orderId) gateCount.set(g.orderId, (gateCount.get(g.orderId) ?? 0) + 1)
  map.replaceChildren(
    repos.length === 0
      ? el('div', { class: 'empty' }, '받은 주문이 없어요. 컨덕터가 주문을 받으면 레포마다 칸이 생겨요.')
      : el('div', { class: 'grid' }, ...repos.map((s) => repoCard(s, gateCount)))
  )
}

function gateCard(g: GateView): HTMLElement {
  const asking = state.pending?.gateId === g.id ? state.pending.decision : null
  const inFlight = state.busy === g.id
  const anyBusy = state.busy !== null
  return el(
    'div',
    { class: 'gate' },
    el('div', { class: 'pills' }, pill(g.type, 'warning'), el('span', { class: 'muted small' }, g.id), el('span', { class: 'muted small' }, ago(ms(g.openedAt)))),
    el('p', null, g.reason),
    g.type === 'interview'
      ? answerBox(g, inFlight)
      : null,
    asking
      ? el(
          'div',
          { class: `confirm tone-${asking === 'approve' ? 'warning' : 'danger'}`, role: 'group', 'aria-labelledby': `confirm-gate-${g.id}` },
          el('strong', { id: `confirm-gate-${g.id}` }, `정말 ${DECISION_LABEL[asking]}할까요?`),
          el('div', { class: 'small' }, `${g.id}를 ${DECISION_LABEL[asking]}하면 오르카 워커에는 바로 전하고 다른 워커에는 컨덕터 세션이 다음 tick에 전해요. 되돌릴 수 없어요.`),
          el(
            'div',
            { class: 'row' },
            el(
              'button',
              { class: `btn ${asking === 'approve' ? 'primary' : 'danger'}`, 'data-focus': `resolve:${g.id}`, disabled: inFlight, onClick: () => void resolve(g, asking) },
              inFlight ? '보내는 중' : `${DECISION_LABEL[asking]} 확정`
            ),
            el(
              'button',
              {
                class: 'btn ghost',
                'data-focus': `cancel:gate:${g.id}`,
                disabled: inFlight,
                onClick: () => {
                  state.pending = null
                  state.focusNext = `${asking}:${g.id}`
                  render()
                }
              },
              '취소'
            )
          )
        )
      : el(
          'div',
          { class: 'row' },
          el('button', { class: 'btn primary', 'data-focus': `approve:${g.id}`, disabled: anyBusy, onClick: () => askResolve(g.id, 'approve') }, '승인'),
          el('button', { class: 'btn danger-outline', 'data-focus': `reject:${g.id}`, disabled: anyBusy, onClick: () => askResolve(g.id, 'reject') }, '거절')
        )
  )
}

function askResolve(gateId: string, decision: GateDecision): void {
  state.result = null
  state.pending = { gateId, decision }
  state.focusNext = `cancel:gate:${gateId}`
  render()
}

function answerBox(g: GateView, disabled: boolean): HTMLElement {
  const box = el('textarea', {
    class: 'answer',
    'aria-label': '답',
    placeholder: '인터뷰 답을 적어 주세요',
    disabled,
    onInput: (e) => {
      state.answers[g.id] = (e.target as HTMLTextAreaElement).value
    }
  }) as HTMLTextAreaElement
  box.value = state.answers[g.id] ?? ''
  return box
}

function bypassList(items: readonly Bypass[]): HTMLElement {
  return el('ul', { class: 'plain' }, ...items.map((b) => el('li', { class: 'small' }, pill(b.need), ` ${b.action} `, el('span', { class: 'muted' }, ago(ms(b.at))))))
}

function resultBlock(r: GateResolveResult): HTMLElement {
  const label = `${r.gateId} ${DECISION_LABEL[r.decision]}`
  return el(
    'div',
    { class: `result tone-${r.ok ? 'success' : 'danger'}` },
    el('strong', null, r.ok ? `${label} 완료` : `${label} 실패`),
    r.ok ? null : el('div', { class: 'small' }, r.error ?? '이유를 못 받았어요'),
    r.ok && r.deferred ? el('div', { class: 'small' }, '이 워커에는 컨덕터 세션이 다음 tick에 결정을 전해요.') : null,
    r.errors.length > 0 ? el('div', { class: 'small' }, el('b', null, '컨덕터가 남긴 오류'), lines(r.errors)) : null,
    r.hostActions.length > 0
      ? el(
          'div',
          { class: 'small' },
          el('b', null, '컨덕터 세션에서 처리할 일'),
          el('div', { class: 'muted' }, '이 gestalt는 결정을 tick에 넘기지 못하는 버전이에요. 플러그인은 실행하지 않으니 컨덕터 세션에서 직접 처리해 주세요.'),
          el('pre', null, JSON.stringify(r.hostActions, null, 2))
        )
      : null,
    el('button', { class: 'btn ghost', 'data-focus': 'close-result', onClick: () => { state.result = null; render() } }, '닫기')
  )
}

const lines = (items: readonly string[]) => el('ul', { class: 'plain' }, ...items.map((l) => el('li', null, l)))

function field(label: string, value: Child): HTMLElement | null {
  if (value === null || value === undefined || value === '') return null
  return el('div', { class: 'field' }, el('dt', null, label), el('dd', null, value))
}

function orderDetail(o: OrderView, v: ConductorView): HTMLElement {
  const parent = o.parentOrderId ? v.orders.find((x) => x.id === o.parentOrderId) : undefined
  const children = v.orders.filter((x) => x.parentOrderId === o.id)
  const gates = v.gates.filter((g) => g.orderId === o.id)
  return el(
    'div',
    { class: 'detail' },
    el('div', { class: 'pills' }, pill(STATUS_LABEL[o.status] ?? o.status, STATUS_TONE[o.status] ?? 'neutral'), pill(o.scope)),
    el('h2', null, o.title || '(제목 없음)'),
    el(
      'dl',
      null,
      field('주문', o.id),
      field('레포', o.repo),
      field('PR', o.pr),
      field('이슈', o.issue),
      field('워커', o.worker ? `${o.worker}${o.workerKind ? ` (${o.workerKind})` : ''}` : undefined),
      field('브랜치', o.branch),
      field('워크트리', o.worktreePath),
      field('기준 브랜치', o.baseBranch),
      field(
        '상위 주문',
        o.parentOrderId
          ? parent
            ? el('button', { class: 'link', onClick: () => select(orderKey(parent.id)) }, `${parent.title || parent.id} (${parent.id})`)
            : `${o.parentOrderId} (목록에 없음)`
          : undefined
      ),
      field('부모 워크트리', o.parentWorktree ? `${o.parentWorktree}${o.parentBranch ? ` · ${o.parentBranch}` : ''}` : undefined),
      field('갱신', ago(ms(o.updatedAt)))
    ),
    o.workspaceId || isTerminal(o.status)
      ? el(
          'div',
          { class: 'row' },
          o.workspaceId ? el('button', { class: 'btn', 'data-focus': `open-detail:${o.id}`, onClick: () => void openWorker(o.id) }, '워크트리로 이동') : null,
          isTerminal(o.status)
            ? el('button', { class: 'btn danger-outline', 'data-focus': `remove:${orderKey(o.id)}`, disabled: state.removeBusy, onClick: () => askRemove(orderKey(o.id), [o.id]) }, '기록 지우기')
            : null
        )
      : null,
    removeConfirm(orderKey(o.id)),
    children.length > 0
      ? el(
          'div',
          null,
          el('h3', null, `하위 주문 ${children.length}`),
          el('ul', { class: 'plain' }, ...children.map((c) => el('li', null, el('button', { class: 'link', onClick: () => select(orderKey(c.id)) }, `${c.title || c.id}`), el('span', { class: 'muted small' }, ` ${STATUS_LABEL[c.status] ?? c.status}`))))
        )
      : null,
    gates.length > 0 ? el('div', null, el('h3', null, `확인 대기 ${gates.length}`), ...gates.map(gateCard)) : null,
    o.bypasses.length > 0 ? el('div', null, el('h3', null, `bypass 사후 보고 ${o.bypasses.length}개`), bypassList(o.bypasses)) : null
  )
}

function worktreeDetail(n: Extract<HierarchyNode, { kind: 'worktree' }>): HTMLElement {
  const orders = n.children.filter((c) => c.kind === 'order').map((c) => (c as Extract<HierarchyNode, { kind: 'order' }>).order)
  return el(
    'div',
    { class: 'detail' },
    pill('부모 워크트리'),
    el('h2', null, n.label),
    el('dl', null, field('경로', n.path), field('브랜치', n.branch)),
    el('div', { class: 'muted small' }, '이 워크트리를 맡은 주문은 지금 목록에 없어요. 사람이 연 워크트리이거나 지난 주문일 수 있어요.'),
    el('h3', null, `여기서 뜬 주문 ${orders.length}`),
    el('ul', { class: 'plain' }, ...orders.map((o) => el('li', null, el('button', { class: 'link', onClick: () => select(orderKey(o.id)) }, o.title || o.id))))
  )
}

function renderSide(v: ConductorView): void {
  const parts: Child[] = []
  if (state.openError) parts.push(el('div', { class: 'result tone-warning' }, el('strong', null, '워크트리를 못 열었어요'), el('div', { class: 'small' }, state.openError)))
  if (state.result) parts.push(resultBlock(state.result))
  if (state.removeResult) parts.push(removeResultBlock(state.removeResult))

  const node = state.selected ? findNode(allNodes(v), state.selected) : undefined
  if (node?.kind === 'order') parts.push(orderDetail(node.order, v))
  else if (node?.kind === 'worktree') parts.push(worktreeDetail(node))
  else {
    // 아무것도 안 골랐을 때는 사람 손이 필요한 일을 먼저 보여 준다
    parts.push(el('h2', null, '확인 대기'))
    if (v.gates.length === 0) parts.push(el('div', { class: 'muted small' }, '기다리는 게이트가 없어요. 주문을 누르면 자세한 내용이 여기에 나와요.'))
    for (const g of v.gates) {
      const order = g.orderId ? v.orders.find((o) => o.id === g.orderId) : undefined
      parts.push(
        el(
          'div',
          null,
          order
            ? el('button', { class: 'link small', onClick: () => select(orderKey(order.id)) }, `${splitRepo(order.repo).name} / ${order.title || order.id}`)
            : el('div', { class: 'muted small' }, '주문 없는 게이트'),
          gateCard(g)
        )
      )
    }
    if (v.unassignedBypasses.length > 0) parts.push(el('h3', null, `주문 없는 bypass ${v.unassignedBypasses.length}개`), bypassList(v.unassignedBypasses))
  }
  fill(side, ...parts)
}

function allNodes(v: ConductorView): HierarchyNode[] {
  return summarize(v).repos.flatMap((s) => buildHierarchy(s.orders))
}

/** 그리기마다 DOM을 새로 만들어서 포커스가 body로 떨어진다. data-focus로 같은 자리를 다시 찾아 돌려준다 */
function render(): void {
  const active = document.activeElement
  const keep = state.focusNext ?? (active && root.contains(active) ? active.closest('[data-focus]')?.getAttribute('data-focus') : null) ?? null
  state.focusNext = null
  draw()
  if (keep === null) return
  for (const n of Array.from(root.querySelectorAll<HTMLElement>('[data-focus]'))) {
    if (n.getAttribute('data-focus') !== keep) continue
    if (n !== document.activeElement) n.focus()
    return
  }
}

function draw(): void {
  const v = state.view
  renderHeader(v)
  if (!v) {
    map.replaceChildren(el('div', { class: 'empty' }, state.loadError ? `워커에 못 닿았어요. ${state.loadError}` : '불러오는 중'))
    side.replaceChildren()
    return
  }
  if (v.state === 'missing') {
    map.replaceChildren(el('div', { class: 'empty' }, `${v.stateDir ?? '상태 폴더'}에 events.jsonl이 아직 없어요. 컨덕터가 첫 주문을 받으면 여기에 보여요.`))
    side.replaceChildren()
    return
  }
  renderMap(v)
  // 인터뷰 답을 적는 중에 워커 알림이 오면 입력이 지워지지 않게 오른쪽은 다음 그리기로 미룬다
  if (side.contains(document.activeElement) && document.activeElement?.tagName === 'TEXTAREA') return
  renderSide(v)
  if (v.state === 'error') side.prepend(el('div', { class: 'result tone-danger' }, el('strong', null, 'gestalt CLI가 실패했어요'), el('div', { class: 'small' }, v.error ?? '')))
}

const style = document.createElement('style')
style.textContent = `
:root { color-scheme: light dark;
  --canvas: #f4f5f6; --s1: #ffffff; --s2: #f7f8f9; --s3: #eff1f3;
  --ink: #08090a; --ink-muted: #3c4149; --ink-subtle: #6b6f76;
  --line: #e4e6e9; --line-strong: #d3d6db; --line-3: #c6cad0;
  --accent: #5e6ad2; --accent-ink: #ffffff; --ok: #1f8f3a; --warn: #c27c0e; --danger: #d63c3c; --danger-ink: #b42323;
  --edge: 0 1px 2px rgba(8, 9, 10, 0.04); }
@media (prefers-color-scheme: dark) { :root:not(.light) {
  --canvas: #010102; --s1: #0f1011; --s2: #141516; --s3: #18191a;
  --ink: #f7f8f8; --ink-muted: #d0d6e0; --ink-subtle: #8a8f98;
  --line: #23252a; --line-strong: #34343a; --line-3: #3e3e44;
  --ok: #27a644; --warn: #e2a33b; --danger: #eb5757; --danger-ink: #eb5757;
  --edge: inset 0 1px 0 rgba(255, 255, 255, 0.04); } }
html.dark {
  --canvas: #010102; --s1: #0f1011; --s2: #141516; --s3: #18191a;
  --ink: #f7f8f8; --ink-muted: #d0d6e0; --ink-subtle: #8a8f98;
  --line: #23252a; --line-strong: #34343a; --line-3: #3e3e44;
  --ok: #27a644; --warn: #e2a33b; --danger: #eb5757; --danger-ink: #eb5757;
  --edge: inset 0 1px 0 rgba(255, 255, 255, 0.04); }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--canvas); color: var(--ink);
  font: 400 13px/1.5 "Inter Variable", Inter, "SF Pro Text", -apple-system, system-ui, sans-serif; letter-spacing: -0.05px; }
button, input, textarea { font: inherit; letter-spacing: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.tone-accent { --tone: var(--accent); }
.tone-warning { --tone: var(--warn); }
.tone-success { --tone: var(--ok); }
.tone-danger { --tone: var(--danger); }
.tone-neutral { --tone: var(--ink-subtle); }

.board { display: flex; flex-direction: column; height: 100vh; }
.top { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--s1); flex-wrap: wrap; }
.top h1 { font-size: 15px; font-weight: 600; letter-spacing: -0.2px; margin: 0 8px 0 0; }
.grow { flex: 1; }
.body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 380px; }
.map { overflow: auto; padding: 20px; }
.side { overflow: auto; padding: 20px; border-left: 1px solid var(--line); background: var(--s1); }
@media (max-width: 860px) { .body { grid-template-columns: 1fr; } .side { border-left: 0; border-top: 1px solid var(--line); } }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; align-items: start; }

.repo { border: 1px solid var(--line); border-radius: 12px; padding: 14px; background: var(--s1); box-shadow: var(--edge); }
.repo.tone-warning { border-color: color-mix(in srgb, var(--warn) 55%, var(--line)); }
.repo.tone-accent { border-color: var(--line-strong); }
.repo-head { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.repo h2 { font-size: 14px; font-weight: 600; letter-spacing: -0.2px; margin: 0; }

.pills { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 1px 8px; border-radius: 9999px; font-size: 11px; font-weight: 500; line-height: 16px;
  background: var(--s3); border: 1px solid var(--line); color: var(--ink-muted); white-space: nowrap; }
.pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--tone, var(--ink-subtle)); }
.muted { color: var(--ink-subtle); }
.small { font-size: 12px; }

.tree, .tree ul { list-style: none; margin: 0; padding: 0; }
.tree ul { margin-left: 10px; padding-left: 16px; border-left: 1px solid var(--line); }
.tree li { position: relative; padding: 3px 0; }
.tree ul > li::before { content: ''; position: absolute; left: -16px; top: 21px; width: 14px; border-top: 1px solid var(--line); }
.node { display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left; padding: 7px 10px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--s2); color: var(--ink); cursor: pointer; }
.node:hover { background: var(--s3); border-color: var(--line-strong); }
.node-row { display: flex; align-items: stretch; gap: 4px; }
.node-row > .node { flex: 1; min-width: 0; }
.node-open { flex: none; width: 28px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--ink-subtle); cursor: pointer; }
.node-open:hover { background: var(--s3); color: var(--ink); }
.node.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); background: var(--s1); }
.node.faded .node-title { color: var(--ink-subtle); }
.node.worktree { border-style: dashed; background: transparent; }
.node-head { display: flex; align-items: center; gap: 8px; }
.node-title { font-weight: 500; letter-spacing: -0.1px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node-meta { font-size: 11px; color: var(--ink-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--tone, var(--ink-subtle)); flex: none; }
.glyph { color: var(--ink-subtle); }

.btn { padding: 4px 12px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--s1); color: var(--ink); font-weight: 500; cursor: pointer; }
.btn:hover:not(:disabled) { background: var(--s3); }
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
.btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 88%, #ffffff); }
.btn.danger { background: var(--danger); color: #ffffff; border-color: transparent; }
.btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 88%, #000000); }
.btn.danger-outline { background: transparent; color: var(--danger-ink); border-color: color-mix(in srgb, var(--danger) 55%, var(--line)); }
.btn.ghost { background: transparent; border-color: transparent; color: var(--ink-muted); }
.btn.xs { font-size: 11px; padding: 2px 8px; }
.link { background: none; border: 0; padding: 0; color: var(--ink); cursor: pointer; text-align: left; text-decoration: underline; text-decoration-color: var(--line-3); text-underline-offset: 3px; }
.link:hover { text-decoration-color: var(--ink); }
.row { display: flex; gap: 6px; margin-top: 8px; }
.repo-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-muted); }
.toggle input { accent-color: var(--accent); }

.side h2 { font-size: 16px; font-weight: 600; letter-spacing: -0.3px; line-height: 1.3; margin: 8px 0 10px; }
.side h3 { font-size: 12px; font-weight: 500; letter-spacing: 0.3px; color: var(--ink-subtle); margin: 18px 0 8px; }
.gate { border: 1px solid var(--line-strong); border-radius: 12px; padding: 12px; margin: 6px 0 12px; background: var(--s2); box-shadow: var(--edge); }
.gate p { margin: 8px 0; color: var(--ink); }
.answer { width: 100%; min-height: 56px; padding: 8px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--s1); color: var(--ink); }
.confirm, .result { border-radius: 8px; padding: 10px 12px; margin: 8px 0 12px; border: 1px solid var(--line); background: var(--s1); }
.confirm.tone-warning, .result.tone-warning, .confirm.tone-danger, .result.tone-danger, .result.tone-success {
  border-color: color-mix(in srgb, var(--tone) 55%, var(--line)); background: color-mix(in srgb, var(--tone) 6%, var(--s1)); }
.confirm strong, .result strong { font-weight: 600; }
pre { font: 11px/1.4 ui-monospace, "SF Mono", Menlo, monospace; white-space: pre-wrap; word-break: break-all; background: var(--s3); border: 1px solid var(--line); padding: 8px; border-radius: 8px; }
dl { margin: 10px 0; }
.field { display: grid; grid-template-columns: 88px 1fr; gap: 8px; padding: 3px 0; }
dt { color: var(--ink-subtle); }
dd { margin: 0; word-break: break-all; color: var(--ink); }
ul.plain { list-style: none; padding: 0; margin: 4px 0; }
ul.plain li { padding: 3px 0; }
.empty { color: var(--ink-subtle); padding: 24px; text-align: center; }
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
void load('conductor.status')
