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
  removeResult: null
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

// ── 데이터 ─────────────────────────────────────────────

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
  render()
}

async function removeOrders(ids: string[]): Promise<void> {
  state.removeBusy = true
  render()
  try {
    state.removeResult = await orca.plugin.request('order.remove', { orderIds: ids }, { timeoutMs: RESOLVE_TIMEOUT_MS })
  } catch (e) {
    state.removeResult = { ok: false, removed: [], skipped: [], error: errorText(e) }
  } finally {
    state.removeBusy = false
    state.removing = null
    render()
  }
}

function askRemove(key: string, ids: string[]): void {
  state.removeResult = null
  state.removing = { key, ids }
  render()
}

function select(key: string | null): void {
  state.selected = state.selected === key ? null : key
  state.pending = null
  state.removing = null
  render()
}

// ── 그리기 ─────────────────────────────────────────────

const root = el('div', { class: 'board' })
const header = el('header', { class: 'top' })
const map = el('main', { class: 'map' })
const side = el('aside', { class: 'side' })
root.append(header, el('div', { class: 'body' }, map, side))

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
        checked: state.showDone,
        onChange: (e) => {
          state.showDone = (e.target as HTMLInputElement).checked
          render()
        }
      }),
      '끝난 주문도 보기'
    ),
    el('button', { class: 'btn', onClick: () => void load('conductor.refresh') }, '새로고침')
  )
}

function orderButton(o: OrderView, gates: number): HTMLElement {
  const tone = STATUS_TONE[o.status] ?? 'neutral'
  const key = orderKey(o.id)
  return el(
    'button',
    {
      class: `node order tone-${tone}${state.selected === key ? ' selected' : ''}${isTerminal(o.status) ? ' faded' : ''}`,
      title: `${o.id} 자세히 보기`,
      onClick: () => select(key)
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

function worktreeButton(n: Extract<HierarchyNode, { kind: 'worktree' }>): HTMLElement {
  return el(
    'button',
    {
      class: `node worktree${state.selected === n.key ? ' selected' : ''}`,
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
        n.kind === 'order' ? orderButton(n.order, gateCount.get(n.order.id) ?? 0) : worktreeButton(n),
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
      el('div', null, el('h2', null, name), owner ? el('div', { class: 'muted small' }, owner) : null),
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
                { class: 'btn danger-outline xs', disabled: state.removeBusy, onClick: () => askRemove(`repo:${s.repo}`, finished) },
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
  return el(
    'div',
    { class: 'confirm tone-danger' },
    el('strong', null, r.ids.length > 1 ? `끝난 주문 ${r.ids.length}개를 지울까요?` : '이 주문을 지울까요?'),
    el('div', { class: 'small' }, '컨덕터 저장소에서 지워져 다시 볼 수 없어요. 같은 지라 티켓이나 PR로 주문이 다시 생기지도 않아요. 워크트리와 브랜치는 그대로 남아요.'),
    el(
      'div',
      { class: 'row' },
      el('button', { class: 'btn danger', disabled: state.removeBusy, onClick: () => void removeOrders(r.ids) }, state.removeBusy ? '지우는 중' : '지우기 확정'),
      el('button', { class: 'btn ghost', disabled: state.removeBusy, onClick: () => { state.removing = null; render() } }, '취소')
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
    el('button', { class: 'btn ghost', onClick: () => { state.removeResult = null; render() } }, '닫기')
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
          { class: `confirm tone-${asking === 'approve' ? 'warning' : 'danger'}` },
          el('strong', null, `정말 ${DECISION_LABEL[asking]}할까요?`),
          el('div', { class: 'small' }, `${g.id}를 ${DECISION_LABEL[asking]}하면 컨덕터가 바로 워커에 전해요. 되돌릴 수 없어요.`),
          el(
            'div',
            { class: 'row' },
            el(
              'button',
              { class: `btn ${asking === 'approve' ? 'primary' : 'danger'}`, disabled: inFlight, onClick: () => void resolve(g, asking) },
              inFlight ? '보내는 중' : `${DECISION_LABEL[asking]} 확정`
            ),
            el('button', { class: 'btn ghost', disabled: inFlight, onClick: () => { state.pending = null; render() } }, '취소')
          )
        )
      : el(
          'div',
          { class: 'row' },
          el('button', { class: 'btn primary', disabled: anyBusy, onClick: () => { state.result = null; state.pending = { gateId: g.id, decision: 'approve' }; render() } }, '승인'),
          el('button', { class: 'btn danger-outline', disabled: anyBusy, onClick: () => { state.result = null; state.pending = { gateId: g.id, decision: 'reject' }; render() } }, '거절')
        )
  )
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
    r.errors.length > 0 ? el('div', { class: 'small' }, el('b', null, '컨덕터가 남긴 오류'), lines(r.errors)) : null,
    r.hostActions.length > 0
      ? el(
          'div',
          { class: 'small' },
          el('b', null, '컨덕터 세션에서 처리할 일'),
          el('div', { class: 'muted' }, '플러그인은 실행하지 않아요. 컨덕터 세션이 다음 tick에 처리해요.'),
          el('pre', null, JSON.stringify(r.hostActions, null, 2))
        )
      : null,
    el('button', { class: 'btn ghost', onClick: () => { state.result = null; render() } }, '닫기')
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
          o.workspaceId ? el('button', { class: 'btn', onClick: () => void openWorker(o.id) }, '워크트리 열기') : null,
          isTerminal(o.status)
            ? el('button', { class: 'btn danger-outline', disabled: state.removeBusy, onClick: () => askRemove(orderKey(o.id), [o.id]) }, '기록 지우기')
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
    o.bypasses.length > 0 ? el('div', null, el('h3', null, `bypass 사후 보고 ${o.bypasses.length}건`), bypassList(o.bypasses)) : null
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
    if (v.unassignedBypasses.length > 0) parts.push(el('h3', null, `주문 없는 bypass ${v.unassignedBypasses.length}건`), bypassList(v.unassignedBypasses))
  }
  fill(side, ...parts)
}

function allNodes(v: ConductorView): HierarchyNode[] {
  return summarize(v).repos.flatMap((s) => buildHierarchy(s.orders))
}

function render(): void {
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
:root { color-scheme: light dark; --warn: #d97706; --ok: #16a34a; }
html, body { margin: 0; height: 100%; background: var(--orca-background); color: var(--orca-foreground);
  font: 13px/1.45 system-ui, -apple-system, sans-serif; }
.board { display: flex; flex-direction: column; height: 100vh; }
.top { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--orca-border); flex-wrap: wrap; }
.top h1 { font-size: 15px; margin: 0 8px 0 0; }
.grow { flex: 1; }
.body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 380px; }
.map { overflow: auto; padding: 16px; }
.side { overflow: auto; padding: 16px; border-left: 1px solid var(--orca-border); background: var(--orca-card); color: var(--orca-card-foreground); }
@media (max-width: 860px) { .body { grid-template-columns: 1fr; } .side { border-left: 0; border-top: 1px solid var(--orca-border); } }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; align-items: start; }
.repo { border: 1px solid var(--orca-border); border-radius: var(--orca-radius, 8px); padding: 12px; background: var(--orca-card); }
.repo.tone-warning { border-color: var(--warn); }
.repo.tone-accent { border-color: var(--orca-primary); }
.repo-head { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.repo h2 { font-size: 14px; margin: 0; }
.pills { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; background: var(--orca-muted); color: var(--orca-muted-foreground); white-space: nowrap; }
.pill.tone-warning { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
.pill.tone-accent { background: color-mix(in srgb, var(--orca-primary) 18%, transparent); color: var(--orca-primary); }
.pill.tone-success { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
.pill.tone-danger { background: color-mix(in srgb, var(--orca-destructive) 18%, transparent); color: var(--orca-destructive); }
.muted { color: var(--orca-muted-foreground); }
.small { font-size: 12px; }
.tree, .tree ul { list-style: none; margin: 0; padding: 0; }
.tree ul { margin-left: 10px; padding-left: 16px; border-left: 1px solid var(--orca-border); }
.tree li { position: relative; padding: 3px 0; }
.tree ul > li::before { content: ''; position: absolute; left: -16px; top: 20px; width: 14px; border-top: 1px solid var(--orca-border); }
.node { display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left; padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--orca-border); background: var(--orca-background); color: inherit; font: inherit; cursor: pointer; }
.node:hover { background: var(--orca-accent); color: var(--orca-accent-foreground); }
.node.selected { outline: 2px solid var(--orca-ring); outline-offset: 1px; }
.node.faded { opacity: .6; }
.node.worktree { border-style: dashed; background: transparent; }
.node-head { display: flex; align-items: center; gap: 6px; }
.node-title { font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node-meta { font-size: 11px; color: var(--orca-muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--orca-muted-foreground); flex: none; }
.tone-accent > .node-head .dot { background: var(--orca-primary); }
.tone-warning > .node-head .dot { background: var(--warn); }
.tone-success > .node-head .dot { background: var(--ok); }
.tone-danger > .node-head .dot { background: var(--orca-destructive); }
.glyph { color: var(--orca-muted-foreground); }
.btn { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--orca-border); background: var(--orca-secondary); color: var(--orca-secondary-foreground); cursor: pointer; }
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--orca-primary); color: var(--orca-primary-foreground); border-color: transparent; }
.btn.danger { background: var(--orca-destructive); color: var(--orca-destructive-foreground); border-color: transparent; }
.btn.danger-outline { background: transparent; color: var(--orca-destructive); border-color: var(--orca-destructive); }
.btn.ghost { background: transparent; border-color: transparent; }
.link { font: inherit; background: none; border: 0; padding: 0; color: var(--orca-primary); cursor: pointer; text-align: left; text-decoration: underline; text-underline-offset: 2px; }
.row { display: flex; gap: 6px; margin-top: 6px; }
.repo-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 8px; }
.btn.xs { font-size: 11px; padding: 2px 8px; }
.toggle { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--orca-muted-foreground); }
.side h2 { font-size: 15px; margin: 6px 0 8px; }
.side h3 { font-size: 13px; margin: 14px 0 6px; }
.gate { border: 1px solid var(--warn); border-radius: 8px; padding: 8px 10px; margin: 4px 0 10px; }
.gate p { margin: 6px 0; }
.answer { width: 100%; box-sizing: border-box; min-height: 56px; font: inherit; padding: 6px; border-radius: 6px; border: 1px solid var(--orca-input); background: var(--orca-background); color: inherit; }
.confirm, .result { border-radius: 8px; padding: 8px 10px; margin: 6px 0 10px; border: 1px solid var(--orca-border); }
.tone-warning.confirm, .tone-warning.result { border-color: var(--warn); }
.tone-danger.confirm, .tone-danger.result { border-color: var(--orca-destructive); }
.tone-success.result { border-color: var(--ok); }
pre { font: 11px/1.4 ui-monospace, monospace; white-space: pre-wrap; word-break: break-all; background: var(--orca-muted); padding: 6px; border-radius: 6px; }
dl { margin: 8px 0; }
.field { display: grid; grid-template-columns: 88px 1fr; gap: 8px; padding: 2px 0; }
dt { color: var(--orca-muted-foreground); }
dd { margin: 0; word-break: break-all; }
ul.plain { list-style: none; padding: 0; margin: 4px 0; }
ul.plain li { padding: 2px 0; }
.empty { color: var(--orca-muted-foreground); padding: 24px; text-align: center; }
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
