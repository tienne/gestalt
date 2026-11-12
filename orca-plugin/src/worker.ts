// 컨덕터 저장소를 지켜보다 바뀌면 `gestalt conductor status`를 다시 읽어 패널과 상태 표시줄에 알린다.
// 이벤트 로그를 직접 재생하지 않는다. 저장소 꼴이 바뀌어도 CLI 하나만 따라가면 되게 하려는 것이다.
import type { OrcaWorkerApi } from 'orca/worker'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runGestalt } from './cli'
import type { ConductorView, GateResolveInput, GateResolveResult, GateView, OrderRemoveResult } from './protocol'
import {
  diffGates,
  emptyView,
  findWorkspace,
  isSafeId,
  needsWorkspaces,
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
const DEBOUNCE_MS = 300
const RETRY_MS = 5000
const STATUS_TIMEOUT_MS = 20_000
const RESOLVE_TIMEOUT_MS = 100_000
const MAX_ANSWER = 4000
const MAX_REMOVE = 200

type Config = { command: string; stateDir: string }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

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
  private stopped = false

  constructor(private readonly orca: OrcaWorkerApi) {}

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
    return { command: text(settings['gestaltPath']) || 'gestalt', stateDir: text(settings['stateDir']) }
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
    const now = Date.now()
    let view: ConductorView
    if (cfg.stateDir && !existsSync(join(cfg.stateDir, EVENTS_FILE))) {
      // status는 저장소 폴더를 만들어 버린다. 설정한 폴더가 비었으면 CLI를 부르지 않는다
      this.raw = null
      view = emptyView('missing', cfg.stateDir, now)
    } else {
      try {
        const out = await runGestalt(
          cfg.command,
          ['conductor', 'status', '--all', '--json', ...this.dirArgs(cfg)],
          { cwd: this.cwd(cfg.stateDir || null), timeoutMs: STATUS_TIMEOUT_MS }
        )
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
  }

  private async workspaces(raw: RawStatus): Promise<Workspace[]> {
    if (!needsWorkspaces(raw.orders)) return []
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
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.refresh()
    }, DEBOUNCE_MS)
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
    const args = [
      'conductor',
      'gate',
      'resolve',
      input.gateId,
      input.decision === 'approve' ? '--approve' : '--reject',
      // `=`로 붙여야 '-'로 시작하는 답이 다른 옵션으로 읽히지 않는다
      ...(answer ? [`--answer=${answer}`] : []),
      '--json',
      ...this.dirArgs(cfg)
    ]
    try {
      const out = await runGestalt(cfg.command, args, {
        cwd: this.cwd(cfg.stateDir || this.view?.stateDir || null),
        timeoutMs: RESOLVE_TIMEOUT_MS
      })
      const parsed = parseJsonOutput(out) as { hostActions?: unknown; errors?: unknown }
      return {
        ...base,
        ok: true,
        hostActions: Array.isArray(parsed.hostActions) ? parsed.hostActions : [],
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
      const out = await runGestalt(cfg.command, args, {
        cwd: this.cwd(cfg.stateDir || this.view?.stateDir || null),
        timeoutMs: STATUS_TIMEOUT_MS
      })
      const parsed = parseJsonOutput(out) as { removed?: unknown; skipped?: unknown }
      const removed = Array.isArray(parsed.removed) ? parsed.removed.map(String) : []
      const skipped = Array.isArray(parsed.skipped)
        ? parsed.skipped.map((v) => {
            const r = (v ?? {}) as { id?: unknown; reason?: unknown }
            return { id: String(r.id ?? ''), reason: String(r.reason ?? '') }
          })
        : []
      return { ok: true, removed, skipped }
    } catch (e) {
      return fail(message(e))
    } finally {
      void this.refresh()
    }
  }

  async openWorker(orderId: string): Promise<{ opened: boolean; error?: string }> {
    const order = this.raw?.orders.find((o) => o.id === orderId)
    if (!order) return { opened: false, error: '모르는 주문이에요' }
    let workspaces: Workspace[]
    try {
      workspaces = (await this.orca.host.call('workspace.list')).workspaces
    } catch (e) {
      return { opened: false, error: message(e) }
    }
    const workspaceId = findWorkspace(order, workspaces)?.id
    if (!workspaceId) return { opened: false, error: '이 주문의 워크트리를 오르카에서 못 찾았어요' }
    try {
      await this.orca.host.call('workspace.open', { workspaceId })
      return { opened: true }
    } catch (e) {
      return { opened: false, error: message(e) }
    }
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

  async stop(): Promise<void> {
    this.stopped = true
    this.closeWatcher()
    this.clearRetry()
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    await this.running?.catch(() => undefined)
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
  orca.panels.handle('order.remove', (input) => conductor.removeOrders(input.orderIds))
  orca.commands.register('conductor.refresh', async () => {
    await conductor.refresh()
    const view = await conductor.current()
    return statusBarOf(view).text
  })
  orca.settings.onDidChange(() => void conductor.refresh())
  void conductor.refresh()
}

export async function deactivate(): Promise<void> {
  await active?.stop()
  active = null
}
