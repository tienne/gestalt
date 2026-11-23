// gestalt CLI를 셸 없이 부른다. 인자는 배열로만 넘겨서 주문 제목이나 답이 명령으로 읽히지 않는다.
import { execFile, type ExecFileError } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export type RunOptions = { cwd: string; timeoutMs: number }

/** 실제로 띄울 실행 파일과 앞에 붙일 인자. 런처를 거치지 않는 경로면 prefix 끝이 CLI 진입 파일이다 */
export type Invocation = { file: string; prefix: string[]; env: Record<string, string> }

/** 실패해도 stdout을 같이 들고 간다. `--json` 명령은 실패할 때도 stdout에 결과를 남길 수 있다 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly stdout = '',
    /** 실행 파일이나 cwd가 없어서 프로세스가 아예 안 떴다 */
    readonly notStarted = false,
    readonly timedOut = false
  ) {
    super(message)
  }
}

const TAIL_LINES = 5
const TAIL_CHARS = 1000

export function runGestalt(command: string | Invocation, args: string[], opts: RunOptions): Promise<string> {
  const inv = typeof command === 'string' ? direct(command) : command
  const env = Object.keys(inv.env).length > 0 ? { env: { ...process.env, ...inv.env } } : {}
  return new Promise((resolve, reject) => {
    execFile(
      inv.file,
      [...inv.prefix, ...args],
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...env },
      (error: ExecFileError | null, stdout: string, stderr: string) => {
        if (!error) return resolve(stdout)
        reject(new CliError(describe(inv.file, error, stderr), stdout, error.code === 'ENOENT', error.killed === true))
      }
    )
  })
}

function describe(command: string, error: ExecFileError, stderr: string): string {
  if (error.code === 'ENOENT')
    return `gestalt 실행 파일을 못 찾았어요(${command}). 설정의 gestalt 경로에 절대 경로를 적어 주세요`
  if (error.killed) return `gestalt가 제한 시간 안에 끝나지 않았어요(${command})`
  const all = stderr.trim().split('\n').filter((l) => l.trim() !== '')
  if (all.length === 0) return `gestalt가 실패했어요(종료 코드 ${String(error.code ?? '?')})`
  const tail = all.slice(-TAIL_LINES).join('\n')
  const cut = all.length > TAIL_LINES ? `…(앞 ${all.length - TAIL_LINES}줄 생략)\n` : ''
  return tail.length > TAIL_CHARS ? `${cut}…${tail.slice(-TAIL_CHARS)}` : `${cut}${tail}`
}

const direct = (command: string): Invocation => ({ file: command, prefix: [], env: {} })
const entry = (inv: Invocation): string => inv.prefix.at(-1)!

// exec-path가 실제로 내는 env 키만 받는다. NODE_OPTIONS 같은 키가 섞여 와도 이후 모든 호출에 실리지 않게 한다
const ENV_KEYS = new Set(['TSX_TSCONFIG_PATH'])
// 옛 CLI가 아닌 실패는 부하나 일시 오류일 수 있어서 이만큼 지나면 다시 찾는다
const RETRY_AFTER_MS = 60_000

/**
 * 셸 런처(`~/.local/bin/gestalt`)는 호출마다 설치 경로를 찾고 npm exec로 bin을 다시 찾아 2~3초가 더 든다.
 * 그래서 `conductor exec-path`로 실제 bin을 한 번만 알아 두고 이후엔 `node <bin>`으로 바로 부른다.
 * 설정한 명령이 바뀌거나 invalidate()(설정 변경)가 불리거나 node나 진입 파일이 사라지거나
 * Claude의 installed_plugins.json이 바뀌면 다시 찾는다. 같은 경로의 bin 내용만 바뀐 업그레이드는
 * 호출마다 node가 새로 읽으니 따로 찾지 않아도 된다. Codex 플러그인 업데이트나 settings.json에서
 * 플러그인을 끄고 켜는 일은 이 신호로 못 잡는다. 그때는 받아 둔 bin이 없어지거나 설정을 바꿀 때까지 이전 bin을 쓴다.
 * 옛 CLI라 명령이 없으면 설정한 명령을 그대로 쓰고 위 신호가 올 때까지 다시 찾지 않는다.
 * 그 밖의 이유로 찾기에 실패하면 RETRY_AFTER_MS 뒤에 다시 찾는다
 */
export class CliResolver {
  private known: { command: string; stamp: string; inv: Invocation | null; retryAt: number } | null = null
  private pending: { command: string; promise: Promise<Invocation> } | null = null

  constructor(
    private readonly timeoutMs: number,
    private readonly stamp: () => string = installStamp,
    private readonly now: () => number = Date.now
  ) {}

  invalidate(): void {
    this.known = null
    this.pending = null
  }

  resolve(command: string, cwd: string): Promise<Invocation> {
    const known = this.known
    if (known && known.command === command && known.stamp === this.stamp()) {
      if (!known.inv) {
        if (this.now() < known.retryAt) return Promise.resolve(direct(command))
      } else if (existsSync(known.inv.file) && existsSync(entry(known.inv))) return Promise.resolve(known.inv)
    }
    if (this.pending?.command === command) return this.pending.promise
    const stamp = this.stamp()
    const pending = {
      command,
      promise: this.lookup(command, cwd).then(({ inv, retryAt }) => {
        if (this.pending === pending) {
          this.known = { command, stamp, inv, retryAt }
          this.pending = null
        }
        return inv ?? direct(command)
      })
    }
    this.pending = pending
    return pending.promise
  }

  /**
   * 기억해 둔 경로로 부른다. spawn이 ENOENT로 실패해 프로세스가 아예 안 떴을 때만 다시 찾아 한 번 더 부른다.
   * 한 번이라도 뜬 프로세스가 실패하면 그대로 올린다. order remove처럼 상태를 바꾸는 명령이 이미 돌았을 수 있어서다
   */
  async run(command: string, args: string[], opts: RunOptions): Promise<string> {
    const inv = await this.resolve(command, opts.cwd)
    try {
      return await runGestalt(inv, args, opts)
    } catch (e) {
      if (inv.prefix.length === 0 || !(e instanceof CliError && e.notStarted)) throw e
      this.invalidate()
      return runGestalt(await this.resolve(command, opts.cwd), args, opts)
    }
  }

  private async lookup(command: string, cwd: string): Promise<{ inv: Invocation | null; retryAt: number }> {
    const never = { inv: null, retryAt: Infinity }
    let out: string
    try {
      out = await runGestalt(command, ['conductor', 'exec-path', '--json'], { cwd, timeoutMs: this.timeoutMs })
    } catch (e) {
      // exec-path를 모르는 옛 CLI면 설정한 명령을 그대로 부른다. 다른 실패는 잠시 뒤 다시 찾는다
      const oldCli = e instanceof CliError && e.message.includes("unknown command 'exec-path'")
      return oldCli ? never : { inv: null, retryAt: this.now() + RETRY_AFTER_MS }
    }
    try {
      const parsed = JSON.parse(out) as { node?: unknown; args?: unknown; env?: unknown }
      const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
      if (typeof parsed.node !== 'string' || !strings(parsed.args) || parsed.args.length === 0) return never
      const bin = parsed.args.at(-1)!
      if (![parsed.node, bin].every((f) => isAbsolute(f) && existsSync(f))) return never
      const env: Record<string, string> = {}
      if (parsed.env && typeof parsed.env === 'object')
        for (const [k, v] of Object.entries(parsed.env)) if (ENV_KEYS.has(k) && typeof v === 'string') env[k] = v
      return { inv: { file: parsed.node, prefix: parsed.args, env }, retryAt: Infinity }
    } catch {
      return never
    }
  }
}

/**
 * 플러그인을 업데이트하면 런처가 고르는 버전이 바뀐다. 셸 런처가 읽는 설치 목록의 수정 시각으로 알아챈다.
 * 매 호출 버전을 묻는 대신 stat 두 번으로 끝낸다
 */
function installStamp(): string {
  const dirs = [process.env['CLAUDE_CONFIG_DIR'], join(homedir(), '.claude')].filter((d): d is string => !!d)
  return dirs
    .map((d) => {
      try {
        return String(statSync(join(d, 'plugins', 'installed_plugins.json')).mtimeMs)
      } catch {
        return '-'
      }
    })
    .join('|')
}
