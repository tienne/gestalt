// 컨덕터 저장소를 지켜보다 바뀌면 `gestalt conductor status`를 다시 읽어 패널과 상태 표시줄에 알린다.
// 이벤트 로그를 직접 재생하지 않는다. 저장소 꼴이 바뀌어도 CLI 하나만 따라가면 되게 하려는 것이다.
import type { OrcaWorkerApi } from 'orca/worker'
import { spawn } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CliError, CliResolver } from './cli'
import { MobileServer } from './mobile-server'
import { ResultsViewer, type ViewerRecord } from './viewer'
import type {
  AgentState,
  ConductorView,
  GateResolveInput,
  GateResolveResult,
  GateView,
  OrderBrowseResult,
  ViewerOpenResult,
  OrderRemoveResult,
  WorkerLive,
  WorkerOpenResult
} from './protocol'
import {
  diffGates,
  emptyView,
  findWorkspace,
  isSafeId,
  parseJsonOutput,
  parseStatus,
  statusBarOf,
  toView,
  type RawStatus,
  type Workspace
} from './status'

const EVENTS_FILE = 'events.jsonl'
const STATUS_BAR_ID = 'conductor'
const NOTIFIED_KEY = 'notifiedGates'
/** 띄운 결과 뷰어의 pid와 주소. 워커가 다시 떠도 같은 뷰어를 이어받는다 */
const VIEWER_KEY = 'resultsViewer'
const DEBOUNCE_MS = 300
/** 쓰기가 300ms보다 촘촘히 이어져도 이만큼 지나면 한 번은 다시 읽는다 */
const DEBOUNCE_MAX_MS = 2000
const RETRY_MS = 5000
/**
 * 워커 작업 내용은 트랜스크립트가 바뀌어도 events.jsonl이 안 바뀌어서 감시로 못 잡는다.
 * 도는 주문이 있을 때만 이 간격으로 다시 읽는다
 */
const ACTIVITY_POLL_MS = 10_000
const STATUS_TIMEOUT_MS = 20_000
const RESOLVE_TIMEOUT_MS = 100_000
const MAX_ANSWER = 4000
const MAX_REMOVE = 200

type Config = { command: string; stateDir: string; mobilePort: number; viewerOnStart: boolean }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

type AgentRow = {
  terminalId: string | null
  title: string | null
  agent: string | null
  state: AgentState
  stateStartedAt: number
  task?: { title: string } | null
}

const AGENT_RANK: Record<string, number> = { working: 0, blocked: 0, waiting: 1, done: 2 }

/** 터미널이 있는 에이전트 중 작업을 받은 것, 아직 도는 것, 최근에 바뀐 것 순으로 고른다 */
export function pickAgent(agents: readonly AgentRow[]): AgentRow | undefined {
  return agents
    .filter((a) => a.terminalId)
    .sort(
      (a, b) =>
        Number(!a.task) - Number(!b.task) ||
        (AGENT_RANK[a.state] ?? 3) - (AGENT_RANK[b.state] ?? 3) ||
        b.stateStartedAt - a.stateStartedAt
    )[0]
}

/** 터미널에서 읽는 줄 수. 끝의 빈 줄을 걷고 나면 TAIL_SHOW줄만 보여 준다 */
const TAIL_READ = 80
const TAIL_SHOW = 24
const LINE_MAX = 400

export function tailLines(lines: readonly string[]): string[] {
  let end = lines.length
  while (end > 0 && !lines[end - 1]!.trim()) end--
  return lines.slice(Math.max(0, end - TAIL_SHOW), end).map((l) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}…` : l))
}

/**
 * 워크트리에서 워커 에이전트가 도는 터미널을 고른다. firstTerminal을 켜면 에이전트 터미널을 못 찾았을 때
 * 워크트리의 첫 터미널을 고르고 fallback을 켠다. 첫 터미널도 못 고르면 fallback은 꺼진 채 이유를 errors에 남긴다
 */
export async function workerTerminal(
  host: Pick<OrcaWorkerApi['host'], 'has' | 'call'>,
  workspaceId: string,
  opts: { firstTerminal?: boolean } = {}
): Promise<{ agent?: AgentRow; terminalId?: string; fallback: boolean; errors: string[] }> {
  const errors: string[] = []
  let agent: AgentRow | undefined
  if (!host.has('agents.list')) errors.push('이 오르카는 에이전트 상태를 읽는 기능을 지원하지 않아요.')
  else {
    try {
      agent = pickAgent((await host.call('agents.list', { workspaceId })).agents)
    } catch (e) {
      errors.push(`에이전트 상태를 못 읽었어요(${message(e)}).`)
    }
  }
  const agentTerminal = agent?.terminalId ?? undefined
  const found = agent ? { agent } : {}
  if (agentTerminal) return { ...found, terminalId: agentTerminal, fallback: false, errors }
  if (!opts.firstTerminal) return { ...found, fallback: false, errors }
  let terminalId: string | undefined
  if (!host.has('terminal.list')) errors.push('이 오르카는 터미널 목록을 읽는 기능을 지원하지 않아요.')
  else {
    try {
      terminalId = (await host.call('terminal.list', { workspaceId })).terminals[0]?.id
      if (!terminalId) errors.push('워크트리에 열린 터미널이 없어요.')
    } catch (e) {
      errors.push(`터미널 목록을 못 읽었어요(${message(e)}).`)
    }
  }
  return terminalId ? { ...found, terminalId, fallback: true, errors } : { ...found, fallback: false, errors }
}

/** CLI가 stateDir을 안 알려 주는 옛 버전일 때만 쓴다. 설정 파일의 stateDir은 못 읽는다 */
function defaultStateDir(): string {
  const env = process.env['GESTALT_CONDUCTOR_STATE_DIR']
  if (env) return env
  const home = process.env['GESTALT_HOME']
  return home ? join(home, 'conductor') : join(homedir(), '.gestalt', 'conductor')
}

class Conductor {
  private view: ConductorView | null = null
  private raw: RawStatus | null = null
  private running: Promise<void> | null = null
  private again = false
  private watcher: FSWatcher | null = null
  private watchedFile: string | null = null
  private retry: ReturnType<typeof setInterval> | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private debounceSince: number | null = null
  private stopped = false
  /** 옛 CLI가 --with-activity를 몰랐다. 워커가 다시 뜰 때까지 플래그 없이 부른다 */
  private activityUnsupported = false
  private activityPoll: ReturnType<typeof setTimeout> | null = null
  private readonly mobile = new MobileServer(() => this.view)
  private readonly cli = new CliResolver(STATUS_TIMEOUT_MS)
  private mobilePort = 0

  constructor(private readonly orca: OrcaWorkerApi) {}

  /** 설정의 포트가 바뀔 때만 다시 연다. 못 연 포트는 설정이 바뀔 때까지 다시 시도하지 않는다 */
  private async applyMobile(port: number): Promise<void> {
    if (port === this.mobilePort) return
    this.mobilePort = port
    if (port === 0) {
      await this.mobile.stop()
      return
    }
    try {
      await this.mobile.start(port)
      if (this.stopped) return void (await this.mobile.stop())
      this.orca.log(`보기 전용 페이지를 http://127.0.0.1:${port} 에 열었어요`)
    } catch (e) {
      this.orca.log(`보기 전용 페이지를 ${port} 포트에 못 열었어요: ${message(e)}`)
      await this.orca.host
        .call('notifications.show', {
          title: '컨덕터 보기 전용 페이지',
          body: `${port} 포트를 못 열었어요. 다른 프로그램이 쓰는지 확인하고 설정에서 포트를 바꿔 주세요.`
        })
        .catch(() => undefined)
    }
  }

  async config(): Promise<Config> {
    let settings: Record<string, unknown> = {}
    try {
      settings = await this.orca.settings.get()
    } catch (e) {
      this.orca.log(`설정을 못 읽었어요: ${message(e)}`)
    }
    // 셸을 안 거치니 `~`를 직접 풀어야 한다
    const text = (v: unknown) =>
      typeof v === 'string' ? v.trim().replace(/^~(?=$|[\\/])/, homedir()) : ''
    const port = settings['mobilePort']
    return {
      command: text(settings['gestaltPath']) || 'gestalt',
      stateDir: text(settings['stateDir']),
      mobilePort: typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
      viewerOnStart: settings['viewerOnStart'] !== false
    }
  }

  /**
   * gate resolve는 워커 워크트리 안에서 부르면 거절된다(assertConductorSession).
   * 그래서 CLI는 언제나 상태 폴더나 홈에서 부른다.
   */
  private cwd(dir: string | null): string {
    return dir && existsSync(dir) ? dir : homedir()
  }

  private dirArgs(cfg: Config): string[] {
    return cfg.stateDir ? [`--state-dir=${cfg.stateDir}`] : []
  }

  current(): Promise<ConductorView> {
    if (this.view) return Promise.resolve(this.view)
    return this.refresh().then(() => this.view!)
  }

  /** 겹쳐 들어온 요청은 한 번 더 읽는 것으로 합친다 */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        await this.load()
      } while (this.again && !this.stopped)
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async load(): Promise<void> {
    const cfg = await this.config()
    if (!this.stopped) await this.applyMobile(cfg.mobilePort)
    const now = Date.now()
    let view: ConductorView
    if (cfg.stateDir && !existsSync(join(cfg.stateDir, EVENTS_FILE))) {
      // status는 저장소 폴더를 만들어 버린다. 설정한 폴더가 비었으면 CLI를 부르지 않는다
      this.raw = null
      view = emptyView('missing', cfg.stateDir, now)
    } else {
      try {
        const out = await this.status(cfg)
        const raw = parseStatus(parseJsonOutput(out))
        const dir = cfg.stateDir || raw.stateDir || defaultStateDir()
        if (!existsSync(join(dir, EVENTS_FILE))) {
          this.raw = null
          view = emptyView('missing', dir, now)
        } else {
          this.raw = raw
          view = toView(raw, dir, await this.workspaces(raw), now)
        }
      } catch (e) {
        this.raw = null
        view = emptyView('error', cfg.stateDir || this.view?.stateDir || null, now, message(e))
      }
    }
    if (this.stopped) return
    this.view = view
    this.orca.panels.post('conductor.changed', view)
    await this.paintStatusBar(view)
    if (view.state === 'ok') await this.notify(view.gates)
    this.arm(view.stateDir)
    this.armActivityPoll(view)
  }

  private async status(cfg: Config): Promise<string> {
    const run = (withActivity: boolean) =>
      this.cli.run(
        cfg.command,
        ['conductor', 'status', '--all', '--json', ...(withActivity ? ['--with-activity'] : []), ...this.dirArgs(cfg)],
        { cwd: this.cwd(cfg.stateDir || null), timeoutMs: STATUS_TIMEOUT_MS }
      )
    if (this.activityUnsupported) return run(false)
    try {
      return await run(true)
    } catch (e) {
      if (!/unknown option.*--with-activity/.test(message(e))) throw e
      this.activityUnsupported = true
      return run(false)
    }
  }

  private armActivityPoll(view: ConductorView): void {
    if (this.activityPoll) clearTimeout(this.activityPoll)
    this.activityPoll = null
    if (this.stopped || this.activityUnsupported) return
    if (!view.orders.some((o) => o.status === 'running' && o.work)) return
    this.activityPoll = setTimeout(() => {
      this.activityPoll = null
      this.schedule()
    }, ACTIVITY_POLL_MS)
  }

  private async workspaces(raw: RawStatus): Promise<Workspace[]> {
    // 워크트리를 잇는 일 말고도 레포마다 오르카 프로젝트 이름을 찾는 데 목록이 필요하다
    if (raw.orders.length === 0) return []
    try {
      return (await this.orca.host.call('workspace.list')).workspaces
    } catch (e) {
      this.orca.log(`워크스페이스 목록을 못 읽었어요: ${message(e)}`)
      return []
    }
  }

  private async paintStatusBar(view: ConductorView): Promise<void> {
    try {
      await this.orca.host.call('statusBar.update', { id: STATUS_BAR_ID, ...statusBarOf(view) })
    } catch (e) {
      this.orca.log(`상태 표시줄을 못 바꿨어요: ${message(e)}`)
    }
  }

  /** 워커가 다시 떠도 같은 게이트를 또 알리지 않게 알린 id를 저장소에 남긴다 */
  private async notify(gates: readonly GateView[]): Promise<void> {
    let notified: string[] = []
    try {
      const stored = await this.orca.storage.get(NOTIFIED_KEY)
      if (Array.isArray(stored)) notified = stored.filter((v): v is string => typeof v === 'string')
    } catch (e) {
      this.orca.log(`알린 게이트 목록을 못 읽었어요: ${message(e)}`)
      return
    }
    const { fresh, keep } = diffGates(gates, notified)
    for (const g of fresh) {
      try {
        await this.orca.host.call('notifications.show', {
          title: '컨덕터 확인 대기',
          body: `${g.type} · ${g.orderId ?? '주문 없음'}: ${g.reason}`.slice(0, 200)
        })
      } catch (e) {
        this.orca.log(`알림을 못 띄웠어요: ${message(e)}`)
      }
    }
    if (fresh.length > 0 || keep.length !== notified.length)
      await this.orca.storage.set(NOTIFIED_KEY, keep).catch((e: unknown) => {
        this.orca.log(`알린 게이트 목록을 못 남겼어요: ${message(e)}`)
      })
  }

  /** 로그 파일이 있으면 감시하고, 없으면 생길 때까지 일정 간격으로 들여다본다 */
  private arm(dir: string | null): void {
    if (this.stopped) return
    const file = dir ? join(dir, EVENTS_FILE) : null
    if (file && existsSync(file)) {
      this.clearRetry()
      if (this.watchedFile === file && this.watcher) return
      this.closeWatcher()
      try {
        this.watcher = watch(file, (event) => {
          // 파일이 갈아끼워지면 이 감시는 끊긴다. 다시 읽을 때 새로 건다
          if (event === 'rename') this.closeWatcher()
          this.schedule()
        })
        this.watcher.on('error', () => {
          this.closeWatcher()
          this.schedule()
        })
        this.watchedFile = file
      } catch (e) {
        this.orca.log(`${file}을 감시하지 못했어요: ${message(e)}`)
        this.startRetry(file)
      }
      return
    }
    this.closeWatcher()
    if (file) this.startRetry(file)
    else this.clearRetry()
  }

  private startRetry(file: string): void {
    this.clearRetry()
    this.retry = setInterval(() => {
      if (existsSync(file)) this.schedule()
    }, RETRY_MS)
  }

  private schedule(): void {
    if (this.stopped) return
    const now = Date.now()
    this.debounceSince ??= now
    if (this.debounce) clearTimeout(this.debounce)
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, this.debounceSince + DEBOUNCE_MAX_MS - now))
    this.debounce = setTimeout(() => {
      this.debounce = null
      this.debounceSince = null
      void this.refresh()
    }, wait)
  }

  async resolveGate(input: GateResolveInput): Promise<GateResolveResult> {
    const base = { gateId: input.gateId, decision: input.decision, hostActions: [], errors: [] }
    if (!isSafeId(input.gateId)) return { ...base, ok: false, error: '게이트 id 꼴이 아니에요' }
    if (input.decision !== 'approve' && input.decision !== 'reject')
      return { ...base, ok: false, error: '결정은 approve나 reject여야 해요' }
    const answer = input.answer?.trim()
    if (answer && answer.length > MAX_ANSWER)
      return { ...base, ok: false, error: `답은 ${MAX_ANSWER}자까지예요` }
    const cfg = await this.config()
    const args = (defer: boolean) => [
      'conductor',
      'gate',
      'resolve',
      input.gateId,
      input.decision === 'approve' ? '--approve' : '--reject',
      // `=`로 붙여야 '-'로 시작하는 답이 다른 옵션으로 읽히지 않는다
      ...(answer ? [`--answer=${answer}`] : []),
      // 플러그인은 hostActions를 못 돌리니 직접 못 전하는 결정은 컨덕터 세션의 tick에 넘긴다
      ...(defer ? ['--defer-delivery'] : []),
      '--json',
      ...this.dirArgs(cfg)
    ]
    const run = (defer: boolean) =>
      this.cli.run(cfg.command, args(defer), {
        cwd: this.cwd(cfg.stateDir || this.view?.stateDir || null),
        timeoutMs: RESOLVE_TIMEOUT_MS
      })
    try {
      let out: string
      try {
        out = await run(true)
      } catch (e) {
        // 옛 CLI는 모르는 옵션을 게이트를 종료하기 전에 거절하니 플래그 없이 한 번 더 불러도 두 번 종료되지 않는다
        if (!/unknown option.*--defer-delivery/.test(message(e))) throw e
        out = await run(false)
      }
      const parsed = parseJsonOutput(out) as { hostActions?: unknown; errors?: unknown; deferred?: unknown }
      return {
        ...base,
        ok: true,
        hostActions: Array.isArray(parsed.hostActions) ? parsed.hostActions : [],
        deferred: parsed.deferred === true,
        errors: Array.isArray(parsed.errors) ? parsed.errors.map((e) => String(e)) : []
      }
    } catch (e) {
      return { ...base, ok: false, error: message(e) }
    } finally {
      void this.refresh()
    }
  }

  async removeOrders(orderIds: unknown): Promise<OrderRemoveResult> {
    const fail = (error: string): OrderRemoveResult => ({ ok: false, removed: [], skipped: [], error })
    if (!Array.isArray(orderIds) || orderIds.length === 0) return fail('지울 주문을 골라 주세요')
    if (orderIds.length > MAX_REMOVE) return fail(`한 번에 ${MAX_REMOVE}개까지 지울 수 있어요`)
    if (!orderIds.every((id): id is string => typeof id === 'string' && isSafeId(id)))
      return fail('주문 id 꼴이 아니에요')
    const cfg = await this.config()
    const args = ['conductor', 'order', 'remove', ...new Set(orderIds), '--json', ...this.dirArgs(cfg)]
    try {
      const out = await this.cli.run(cfg.command, args, {
        cwd: this.cwd(cfg.stateDir || this.view?.stateDir || null),
        timeoutMs: STATUS_TIMEOUT_MS
      })
      return { ok: true, ...removeOutcome(parseJsonOutput(out)) }
    } catch (e) {
      // 하나도 못 지우면 CLI는 exit 1로 끝나지만 stdout에 주문마다 이유를 남긴다. stderr 끝 몇 줄보다 그쪽이 온전하다
      const outcome = e instanceof CliError ? tryRemoveOutcome(e.stdout) : null
      if (outcome && outcome.skipped.length > 0) return { ok: false, ...outcome, error: '하나도 못 지웠어요' }
      // order remove가 없는 옛 CLI는 commander가 "unknown command 'remove'"만 남겨 무엇을 고칠지 안 보인다
      if (/unknown command '?remove'?/.test(message(e)))
        return fail(
          `설정한 gestalt(${cfg.command})에 주문 지우기 명령(conductor order remove)이 없어요. 이 명령이 들어간 버전으로 올리거나 플러그인 설정의 "gestalt 실행 파일"을 그 빌드로 바꿔 주세요.`
        )
      return fail(message(e))
    } finally {
      void this.refresh()
    }
  }

  private async workspaceOf(orderId: string): Promise<{ workspaceId: string } | { error: string }> {
    const order = this.raw?.orders.find((o) => o.id === orderId)
    if (!order) return { error: '모르는 주문이에요' }
    // 상세를 펼쳐 두면 4초마다 불려서 지난 상태 갱신 때 찾아 둔 워크스페이스를 먼저 쓴다
    const known = this.view?.orders.find((o) => o.id === orderId)?.workspaceId
    if (known) return { workspaceId: known }
    let workspaces: Workspace[]
    try {
      workspaces = (await this.orca.host.call('workspace.list')).workspaces
    } catch (e) {
      return { error: message(e) }
    }
    const workspaceId = findWorkspace(order, workspaces)?.id
    return workspaceId ? { workspaceId } : { error: '이 주문의 워크트리를 오르카에서 못 찾았어요' }
  }

  async openWorker(orderId: string): Promise<WorkerOpenResult> {
    const ws = await this.workspaceOf(orderId)
    if ('error' in ws) return { opened: false, error: ws.error }
    let missed = '이 오르카는 터미널로 옮기는 기능을 지원하지 않아요.'
    if (this.orca.host.has('terminal.focus')) {
      const { terminalId, fallback, errors } = await workerTerminal(this.orca.host, ws.workspaceId, { firstTerminal: true })
      missed = errors.join(' ')
      try {
        if (terminalId && (await this.orca.host.call('terminal.focus', { terminalId })).focused) {
          if (!fallback) return { opened: true }
          return { opened: true, fallbackTerminal: true, ...(errors.length > 0 ? { fallbackReason: errors.join(' ') } : {}) }
        }
        if (terminalId) missed = [...errors, '터미널로 못 옮겨 갔어요.'].join(' ')
      } catch (e) {
        missed = [...errors, `터미널로 못 옮겨 갔어요(${message(e)}).`].join(' ')
      }
    }
    try {
      await this.orca.host.call('workspace.open', { workspaceId: ws.workspaceId })
      return { opened: true, worktreeOnly: true, error: `${missed} 워크트리만 열었어요.` }
    } catch (e) {
      return { opened: false, error: message(e) }
    }
  }

  async workerDetail(orderId: string): Promise<WorkerLive> {
    const ws = await this.workspaceOf(orderId)
    if ('error' in ws) return { found: false, error: ws.error }
    // 첫 터미널로 물러나지 않는다. 다른 일을 하는 터미널의 출력을 워커 출력처럼 보여 주게 된다
    const { agent, terminalId, errors } = await workerTerminal(this.orca.host, ws.workspaceId)
    const out: WorkerLive = { found: true }
    if (agent)
      out.agent = { kind: agent.agent, title: agent.title, state: agent.state, since: agent.stateStartedAt, task: agent.task?.title ?? null }
    if (!terminalId) out.noWorkerTerminal = true
    else {
      out.terminalId = terminalId
      if (!this.orca.host.has('terminal.read')) errors.push('이 오르카는 터미널 출력을 읽는 기능을 지원하지 않아요.')
      else {
        try {
          out.lines = tailLines((await this.orca.host.call('terminal.read', { terminalId, maxLines: TAIL_READ })).lines)
        } catch (e) {
          errors.push(`터미널을 못 읽었어요(${message(e)}).`)
        }
      }
    }
    if (errors.length > 0) out.error = errors.join(' ')
    return out
  }

  private closeWatcher(): void {
    this.watcher?.close()
    this.watcher = null
    this.watchedFile = null
  }

  private clearRetry(): void {
    if (this.retry) clearInterval(this.retry)
    this.retry = null
  }

  private readonly viewer = new ResultsViewer({
    load: () => this.orca.storage.get(VIEWER_KEY),
    save: (rec: ViewerRecord | null) =>
      rec ? this.orca.storage.set(VIEWER_KEY, rec) : this.orca.storage.delete(VIEWER_KEY).then(() => undefined),
    log: (line) => this.orca.log(line)
  })

  /** 결과 뷰어를 워커가 살아 있는 동안 하나만 띄워 두고 주문의 작업 내용 탭 주소를 준다 */
  async browseUrl(orderId: unknown): Promise<OrderBrowseResult> {
    if (typeof orderId !== 'string' || !isSafeId(orderId)) return { ok: false, error: '주문 id 꼴이 아니에요' }
    const out = await this.viewerUrl()
    return out.ok ? { ok: true, url: `${out.url}/#order/${encodeURIComponent(orderId)}/work` } : out
  }

  /** 결과 뷰어 첫 화면 주소. 떠 있으면 그 주소를 주고 없으면 띄운다 */
  async viewerUrl(): Promise<ViewerOpenResult> {
    try {
      return { ok: true, url: await this.ensureViewer(await this.config()) }
    } catch (e) {
      return { ok: false, error: `결과 뷰어를 못 띄웠어요. ${message(e)}` }
    }
  }

  /** 플러그인이 뜰 때 저장소가 있으면 결과 뷰어를 미리 띄운다. 실패해도 버튼을 누를 때 다시 띄운다 */
  async warmViewer(): Promise<void> {
    const cfg = await this.config()
    if (!cfg.viewerOnStart || this.stopped || this.view?.state !== 'ok') return
    try {
      await this.ensureViewer(cfg)
    } catch (e) {
      this.orca.log(`결과 뷰어를 미리 못 띄웠어요: ${message(e)}`)
    }
  }

  private ensureViewer(cfg: Config): Promise<string> {
    const cwd = this.cwd(cfg.stateDir || this.view?.stateDir || null)
    // 명령이나 저장소가 바뀌면 다른 뷰어다. 저장소 설정이 비면 뷰어는 실행 폴더의 저장소를 쓰므로 그 폴더로 가른다
    const key = JSON.stringify([cfg.command, cfg.stateDir || cwd])
    return this.viewer.ensure(key, async () => {
      const inv = await this.cli.resolve(cfg.command, cwd)
      if (this.stopped) throw new Error('플러그인 워커가 멈췄어요')
      return spawn(inv.file, [...inv.prefix, 'conductor', 'browse', '--no-open', ...this.dirArgs(cfg)], {
        cwd,
        ...(Object.keys(inv.env).length > 0 ? { env: { ...process.env, ...inv.env } } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    })
  }

  /** 설정이 바뀌면 gestalt 경로를 다시 찾는다. 명령이 그대로여도 그 뒤의 설치가 바뀌었을 수 있다 */
  settingsChanged(): Promise<void> {
    this.cli.invalidate()
    return this.refresh()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.viewer.stop()
    this.closeWatcher()
    this.clearRetry()
    if (this.activityPoll) clearTimeout(this.activityPoll)
    this.activityPoll = null
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    this.debounceSince = null
    await this.running?.catch(() => undefined)
    await this.mobile.stop()
  }
}

let active: Conductor | null = null

export default function activate(orca: OrcaWorkerApi): void {
  const conductor = new Conductor(orca)
  active = conductor
  orca.panels.handle('conductor.status', () => conductor.current())
  orca.panels.handle('conductor.refresh', async () => {
    await conductor.refresh()
    return conductor.current()
  })
  orca.panels.handle('gate.resolve', (input) => conductor.resolveGate(input))
  orca.panels.handle('worker.open', (input) => conductor.openWorker(input.orderId))
  orca.panels.handle('worker.detail', (input) => conductor.workerDetail(input.orderId))
  orca.panels.handle('order.remove', (input) => conductor.removeOrders(input.orderIds))
  orca.panels.handle('order.browse', (input) => conductor.browseUrl(input.orderId))
  orca.panels.handle('viewer.open', () => conductor.viewerUrl())
  orca.commands.register('conductor.refresh', async () => {
    await conductor.refresh()
    const view = await conductor.current()
    return statusBarOf(view).text
  })
  orca.settings.onDidChange(() => void conductor.settingsChanged())
  void conductor.refresh().then(() => conductor.warmViewer())
}

export async function deactivate(): Promise<void> {
  await active?.stop()
  active = null
}

function removeOutcome(json: unknown): Pick<OrderRemoveResult, 'removed' | 'skipped'> {
  const parsed = (json ?? {}) as { removed?: unknown; skipped?: unknown }
  const removed = Array.isArray(parsed.removed) ? parsed.removed.map(String) : []
  const skipped = Array.isArray(parsed.skipped)
    ? parsed.skipped.map((v) => {
        const r = (v ?? {}) as { id?: unknown; reason?: unknown }
        return { id: String(r.id ?? ''), reason: String(r.reason ?? '') }
      })
    : []
  return { removed, skipped }
}

function tryRemoveOutcome(stdout: string): Pick<OrderRemoveResult, 'removed' | 'skipped'> | null {
  if (!stdout.trim()) return null
  try {
    return removeOutcome(parseJsonOutput(stdout))
  } catch {
    return null
  }
}
