// 컨덕터 터미널 화면의 계산. DOM과 오르카 런타임을 모르는 순수 함수만 둔다.
import { AWAITING_DEPLOY, canOpenWorktree, displayStatus, GROUP_ORDER, isTerminal, ms, splitRepo, STATUS_LABEL } from './model'
import { type ConductorView, type EventView, type GateView, type OrderView, type WaitingView } from './protocol'

export type KindKey = 'orca' | 'git' | 'sub' | 'none'

export function kindKey(workerKind?: string): KindKey {
  if (workerKind === 'orca-worktree') return 'orca'
  if (workerKind === 'git-worktree') return 'git'
  if (workerKind === 'subagent') return 'sub'
  return 'none'
}

export type Chip = { text: string; state: 'done' | 'cur' | 'todo' }

/** 워커는 체크포인트에 `gestalt:ship`처럼 플러그인 접두를 붙여 남기고 주문의 skillChain은 `ship`이라 비교 전에 뗀다 */
const bareSkill = (skill: string) => skill.replace(/^gestalt:/, '')

/** 머지나 끝남이면 워커가 끝남 체크포인트를 못 남기고 나갔어도 체인을 다 돈 것이다 */
const FINISHED_ORDER_STATUSES: ReadonlySet<string> = new Set(['merged', 'done'])
const chainFinished = (o: OrderView) => FINISHED_ORDER_STATUSES.has(o.status)

/** 해제됐거나 끝난 워커. 워크트리가 이미 지워졌을 수 있어 터미널을 찾지 않는다 */
const ENDED_WORKER_STATUSES: ReadonlySet<string> = new Set(['released', 'finished'])
export const workerEnded = (o: Pick<OrderView, 'workerStatus'>) =>
  o.workerStatus !== undefined && ENDED_WORKER_STATUSES.has(o.workerStatus)

/** 워커 터미널을 읽거나 그쪽으로 이동할 수 있는 주문. 카드 이동과 상세 폴링이 같은 판정을 쓴다 */
export const canReachWorker = (o: Pick<OrderView, 'workspaceId' | 'workerStatus' | 'status'>) =>
  canOpenWorktree(o) && !workerEnded(o)

const stepText = (o: OrderView) => {
  const c = o.checkpoint!
  return `${bareSkill(c.skill)}${c.phase ? ` · ${c.phase}` : ''}${c.round ? ` r${c.round}` : ''}`
}

/**
 * 스킬 체인 칩. 끝난 스킬, 체크포인트의 지금 스킬, 남은 스킬로 가른다. 체크포인트가 없으면 전부 남은 스킬이다.
 * 주문이 머지됐거나 끝났으면 체크포인트와 상관없이 전부 끝난 스킬이다
 */
export function chainChips(o: OrderView): Chip[] {
  const chain = o.skillChain ?? []
  if (chainFinished(o)) return chain.map((text) => ({ text, state: 'done' }))
  const cp = o.checkpoint
  if (!cp) return chain.map((text) => ({ text, state: 'todo' }))
  const done = new Set(cp.completedSkills.map(bareSkill))
  const current = bareSkill(cp.skill)
  let placed = false
  const chips: Chip[] = chain.map((s) => {
    if (done.has(bareSkill(s))) return { text: s, state: 'done' }
    if (!placed && bareSkill(s) === current) {
      placed = true
      return { text: stepText(o), state: 'cur' }
    }
    return { text: s, state: 'todo' }
  })
  // 체인에 없는 스킬을 돌고 있으면(solve가 부른 하위 스킬 같은) 끝난 칩 바로 뒤에 끼운다
  if (!placed) {
    const at = chips.findIndex((c) => c.state !== 'done')
    chips.splice(at < 0 ? chips.length : at, 0, { text: stepText(o), state: 'cur' })
  }
  return chips
}

/** completedSkills / skillChain. 체인이 비면 null이라 막대를 안 그린다. 머지됐거나 끝난 주문은 1이다 */
export function progressOf(o: OrderView): number | null {
  const chain = o.skillChain ?? []
  if (chain.length === 0) return null
  if (chainFinished(o)) return 1
  const done = new Set((o.checkpoint?.completedSkills ?? []).map(bareSkill))
  return chain.filter((s) => done.has(bareSkill(s))).length / chain.length
}

export type TodoLayer = { done: number; total: number } | 'unknown'

/** todo 막대. 작업 내용이 없는 옛 CLI면 undefined라 스킬 체인 막대를 그린다. 시간으로 퍼센트를 짐작하지 않는다 */
export function todoOf(o: OrderView): TodoLayer | undefined {
  if (!o.work) return undefined
  const t = o.work.tasks
  return t ? { done: t.done, total: t.total } : 'unknown'
}

/** 지금 고치는 파일과 경과. 파일이 없으면 tool 이름을 쓰는데 그건 데스크톱에서만 보여 준다 */
export function nowLine(o: OrderView, now: number, showPrivate: boolean): string | undefined {
  const a = o.work?.activity
  if (!a) return undefined
  const since = duration(ms(a.at), now)
  if (a.file) return `✎ ${a.file} · ${since}`
  return showPrivate ? `▸ ${a.tool} · ${since}` : `▸ ${since} 전 활동`
}

/** 아직 안 끝난 서브에이전트 수. 백그라운드로 띄우고 완료 알림을 못 받은 것도 센다 */
export function runningSubagents(o: OrderView): number {
  return (o.work?.subagents ?? []).filter((s) => s.state !== 'done').length
}

export const GATE_LABEL: Record<string, string> = {
  merge: '머지 승인',
  'slack-post': '슬랙 게시',
  interview: '인터뷰 답',
  'review-manual-switch': '리뷰 수동 전환',
  'no-procedure': '처리 절차 없음',
  'file-overlap': '파일 겹침 확인'
}

/** 이벤트 유형처럼 바깥에서 온 키로 표를 찾는다. constructor 같은 이름이 Object 원형의 함수를 꺼내지 않게 제 키만 본다 */
export const lookup = (table: Record<string, string>, key: string): string | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined

export const gateLabel = (type: string) => lookup(GATE_LABEL, type) ?? type

/** 경과 시간. 상태줄 오른쪽에 붙는다 */
export function duration(fromMs: number | null, now: number): string {
  if (fromMs === null) return ''
  const s = Math.max(0, Math.round((now - fromMs) / 1000))
  if (s < 60) return `${s}초`
  if (s < 3600) return `${Math.floor(s / 60)}분`
  if (s < 86400) return `${Math.floor(s / 3600)}시간`
  return `${Math.floor(s / 86400)}일`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 이 맥의 시각으로 HH:MM. 못 읽는 값이면 빈 문자열 */
export function clock(iso: string | undefined, seconds = false): string {
  const t = ms(iso)
  if (t === null) return ''
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`
}

/** 대기 사유와 기한. 카드 상태줄과 이벤트 로그가 같은 시각을 적도록 둘 다 이걸 쓴다 */
export function waitText(reason: string, until: string | undefined, joiner = ' '): string {
  const at = clock(until)
  return at ? `${reason}${joiner}~${at}` : reason
}

/** 주문의 대기 한 줄. 사유는 워커가 쓴 글이라 경로나 토큰이 섞일 수 있어서 showFreeText가 꺼지면 '대기'만 적는다 */
export function orderWaitText(w: WaitingView, showFreeText: boolean): string {
  return waitText(showFreeText ? w.reason : '대기', w.until)
}

/** 이벤트 로그 한 줄의 본문. 대기 기한은 CLI가 원시 ISO로 주면 이 맥의 시각으로 붙인다 */
export function eventText(e: EventView): string {
  const body = e.type === 'waiting' && e.until ? waitText(e.summary, e.until, ' · ') : e.summary
  return e.orderId ? `${e.orderId} ${body}` : body
}

export type StateTone = 'run' | 'wait' | 'gate' | 'limit' | 'idle' | 'deploy'
export type StateLine = { tone: StateTone; text: string; aside: string }

/** 상태줄. 한도, 열린 게이트, 워커 대기, 그 밖 순으로 하나만 고른다 */
export function stateLine(o: OrderView, gates: readonly GateView[], now: number, showFreeText = true): StateLine {
  if (o.rateLimitedAt) {
    const until = clock(o.rateLimitResetsAt)
    return { tone: 'limit', text: `rate-limit${until ? ` ~${until}` : ''}`, aside: duration(ms(o.rateLimitedAt), now) }
  }
  const gate = gates.find((g) => g.orderId === o.id)
  if (gate) return { tone: 'gate', text: `${gateLabel(gate.type)} 대기`, aside: duration(ms(gate.openedAt), now) }
  if (o.status === 'waiting-gate') return { tone: 'gate', text: 'waiting-gate', aside: duration(ms(o.updatedAt), now) }
  if (o.waiting) {
    return { tone: 'wait', text: orderWaitText(o.waiting, showFreeText), aside: duration(ms(o.waiting.since), now) }
  }
  const last = Math.max(ms(o.checkpoint?.savedAt) ?? 0, ms(o.updatedAt) ?? 0) || null
  const status = displayStatus(o)
  const deploy = status === AWAITING_DEPLOY
  const tone: StateTone = o.status === 'running' ? 'run' : o.status === 'escalated' ? 'gate' : deploy ? 'deploy' : 'idle'
  // 다른 상태는 CLI 값을 그대로 적는데 배포 대기는 화면에만 있는 상태라 머지됨과 갈리게 라벨로 적는다
  return { tone, text: deploy ? STATUS_LABEL[AWAITING_DEPLOY]! : status, aside: last === null ? '' : `${duration(last, now)} 전` }
}

/** 카드 둘째 줄. 레포, 지라 키, PR, 계정이나 워커 종류, 기준 브랜치. 계정 이름은 showAccount가 켜졌을 때만 */
export type MetaRow = { label: string; value: string }

/** 카드 머리의 이름표 달린 줄들. 값이 없는 줄은 뺀다 */
export function metaOf(o: OrderView, showAccount = true): MetaRow[] {
  const rows: MetaRow[] = []
  if (o.repo) rows.push({ label: '레포', value: splitRepo(o.repo).name })
  if (o.issue) rows.push({ label: '티켓', value: o.issue })
  if (o.pr) rows.push({ label: 'PR', value: o.pr })
  if (o.account && showAccount) rows.push({ label: '계정', value: o.account })
  else if (o.workerKind === 'subagent') rows.push({ label: '워커', value: 'subagent' })
  if (o.baseBranch) rows.push({ label: '기준 브랜치', value: o.baseBranch })
  return rows.filter((r) => r.value)
}

export type Card = {
  order: OrderView
  kind: KindKey
  meta: MetaRow[]
  chips: Chip[]
  progress: number | null
  /** 작업 내용을 아는 CLI면 todo 막대가 스킬 체인 막대 자리에 들어간다 */
  todo?: TodoLayer
  now?: string
  subagents: number
  state: StateLine
  next?: string
  bypass?: string
  children: OrderView[]
}

export type TerminalModel = {
  cards: Card[]
  /** 워커가 붙은 카드를 워커 종류별로 센다 */
  kinds: Record<Exclude<KindKey, 'none'>, number>
  workers: number
  activeWorkers: number
  maxWorkers?: number
  queued: number
  gates: GateView[]
  bypasses: number
  events: EventView[]
}

const STATUS_RANK = new Map<string, number>(GROUP_ORDER.map((s, i) => [s, i]))

/** showPrivate가 꺼지면 인증 없는 폰 페이지용이라 계정 이름과 워커가 쓴 글(다음 할 일, bypass, 대기 사유)을 싣지 않는다 */
export function terminalModel(v: ConductorView, now: number, showPrivate = true): TerminalModel {
  const live = v.orders.filter((o) => !isTerminal(o.status))
  const liveIds = new Set(live.map((o) => o.id))
  // 부모가 화면에 카드로 있으면 하위 주문은 부모 카드 안에 줄로 넣는다
  const nested = (o: OrderView) => o.parentOrderId !== undefined && liveIds.has(o.parentOrderId)
  const roots = live
    .filter((o) => !nested(o))
    .sort(
      (a, b) =>
        Number(Boolean(b.worker)) - Number(Boolean(a.worker)) ||
        (STATUS_RANK.get(displayStatus(a)) ?? 99) - (STATUS_RANK.get(displayStatus(b)) ?? 99) ||
        (ms(b.updatedAt) ?? 0) - (ms(a.updatedAt) ?? 0)
    )
  const cards = roots.map((o): Card => {
    const last = o.bypasses.at(-1)
    const todo = todoOf(o)
    const line = nowLine(o, now, showPrivate)
    return {
      order: o,
      kind: o.worker ? kindKey(o.workerKind) : 'none',
      meta: metaOf(o, showPrivate),
      chips: chainChips(o),
      progress: progressOf(o),
      ...(todo ? { todo } : {}),
      ...(line ? { now: line } : {}),
      subagents: runningSubagents(o),
      state: stateLine(o, v.gates, now, showPrivate),
      ...(showPrivate && o.checkpoint?.next ? { next: o.checkpoint.next } : {}),
      ...(showPrivate && last ? { bypass: last.action } : {}),
      children: live.filter((c) => c.parentOrderId === o.id)
    }
  })
  const kinds = { orca: 0, git: 0, sub: 0 }
  for (const c of cards) if (c.kind !== 'none') kinds[c.kind]++
  const workers = kinds.orca + kinds.git + kinds.sub
  const info = v.conductor
  return {
    cards,
    kinds,
    workers,
    activeWorkers: info?.activeWorkers ?? workers,
    ...(info?.maxWorkers !== undefined ? { maxWorkers: info.maxWorkers } : {}),
    queued: info?.queuedOrders ?? live.filter((o) => o.status === 'queued').length,
    gates: v.gates,
    bypasses: live.reduce((n, o) => n + o.bypasses.length, 0),
    events: v.recentEvents ?? []
  }
}

export type RepoGroup = { repo: string; label: string; cards: Card[] }

/**
 * 카드를 레포별로 묶는다. 묶음 순서는 정렬된 카드 목록에서 그 레포가 처음 나온 순서라
 * 워커가 붙어 바쁜 레포가 위로 온다. 이름은 오르카 프로젝트 이름을 먼저 쓰고 없으면 레포 이름이다
 */
export function groupByRepo(cards: readonly Card[], projects: Record<string, string> = {}): RepoGroup[] {
  const groups = new Map<string, RepoGroup>()
  for (const c of cards) {
    const repo = c.order.repo
    let g = groups.get(repo)
    if (!g) {
      g = { repo, label: projects[repo] ?? (repo ? splitRepo(repo).name : '레포 없음'), cards: [] }
      groups.set(repo, g)
    }
    g.cards.push(c)
  }
  return [...groups.values()]
}
