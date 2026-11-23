// 결과 뷰어(`gestalt conductor browse`) 프로세스를 워커가 하나만 맡아 띄우고 끈다.
// 워커가 비정상으로 죽으면 뷰어가 고아로 남는다. 그래서 띄운 뷰어의 pid와 주소를 플러그인 저장소에 남기고
// 다음에 뜬 워커가 그 뷰어가 살아 있으면 새로 띄우지 않고 이어받는다. 같은 저장소에 뷰어가 둘 뜨지 않게 하려는 것이다.
import type { ChildProcess } from 'node:child_process'
import { request } from 'node:http'

/** 뷰어가 주소를 찍을 때까지 기다리는 시간 */
export const VIEWER_START_MS = 10_000
/** 이어받기 전에 남은 뷰어가 응답하는지 보는 시간 */
const PROBE_MS = 1500
const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d{1,5}/

/** 저장소에 남기는 뷰어 기록. key는 gestalt 명령과 저장소 폴더를 묶은 값이라 설정이 바뀌면 이어받지 않는다 */
export type ViewerRecord = { pid: number; url: string; key: string }

type Running = { key: string; url: Promise<string>; pid: () => number | undefined; alive: () => boolean; kill: () => void }

/** 뷰어 프로세스를 띄운다. gestalt 경로 찾기에 실패하면 throw한다 */
export type LaunchViewer = () => Promise<ChildProcess>

export type ViewerDeps = {
  load: () => Promise<unknown>
  save: (record: ViewerRecord | null) => Promise<void>
  /** 그 주소에서 결과 뷰어가 응답하는지 본다 */
  probe?: (url: string) => Promise<boolean>
  log?: (line: string) => void
}

export class ResultsViewer {
  private cur: Running | null = null
  private starting: { key: string; url: Promise<string> } | null = null
  /** 띄우는 사이 설정이 바뀌어 다른 key로 다시 불렸으면 먼저 띄우던 쪽이 결과를 버린다 */
  private generation = 0
  private stopped = false

  constructor(private readonly deps: ViewerDeps) {}

  /** 뷰어 주소를 준다. 살아 있으면 그대로 쓰고 key가 바뀌었으면 옛 뷰어를 끄고 다시 띄운다 */
  ensure(key: string, launch: LaunchViewer): Promise<string> {
    if (this.stopped) return Promise.reject(new Error('플러그인 워커가 멈췄어요'))
    const cur = this.cur
    if (cur && cur.key === key && cur.alive()) return cur.url
    if (this.starting?.key === key) return this.starting.url
    if (cur && cur.key !== key) this.drop(cur)
    const gen = ++this.generation
    const url = this.start(key, gen, launch).finally(() => {
      if (this.starting?.url === url) this.starting = null
    })
    // 아무도 기다리지 않는 사이에 실패해도 처리 안 된 거절로 남지 않게 한다
    url.catch(() => undefined)
    this.starting = { key, url }
    return url
  }

  private async start(key: string, gen: number, launch: LaunchViewer): Promise<string> {
    const adopted = await this.adopt(key, gen)
    if (adopted) return adopted
    const child = await launch()
    if (this.stopped || gen !== this.generation) {
      child.kill()
      throw new Error(this.stopped ? '플러그인 워커가 멈췄어요' : '설정이 바뀌어 다시 띄워요')
    }
    const running: Running = {
      key,
      url: waitForUrl(child, () => {
        if (this.cur === running) this.cur = null
        void this.forget(child.pid)
      }),
      pid: () => child.pid,
      alive: () => child.exitCode === null && child.signalCode === null,
      kill: () => child.kill()
    }
    this.cur = running
    const url = await running.url
    if (child.pid !== undefined && this.cur === running) await this.remember({ pid: child.pid, url, key })
    return url
  }

  /** 지난 워커가 남긴 뷰어가 같은 설정으로 떠 있고 응답하면 이어받는다 */
  private async adopt(key: string, gen: number): Promise<string | null> {
    let rec: ViewerRecord | null = null
    try {
      rec = asRecord(await this.deps.load())
    } catch (e) {
      this.deps.log?.(`남은 결과 뷰어 기록을 못 읽었어요: ${errorText(e)}`)
    }
    if (!rec) return null
    // 설정이 바뀌어 key가 다르면 이어받지 않는다. 그 pid가 정말 그 뷰어인지 장담할 수 없어 끄지도 않는다
    const live = rec.key === key && pidAlive(rec.pid) && (await (this.deps.probe ?? probe)(rec.url))
    if (!live) {
      await this.remember(null)
      return null
    }
    if (this.stopped || gen !== this.generation) return null
    const pid = rec.pid
    this.cur = { key, url: Promise.resolve(rec.url), pid: () => pid, alive: () => pidAlive(pid), kill: () => killPid(pid) }
    this.deps.log?.(`떠 있던 결과 뷰어를 이어받았어요: ${rec.url}`)
    return rec.url
  }

  private drop(r: Running): void {
    r.kill()
    if (this.cur === r) this.cur = null
    void this.forget(r.pid())
  }

  /** 기록이 이 pid의 것일 때만 지운다. 새 뷰어 기록을 옛 뷰어의 종료가 지우지 않게 한다 */
  private async forget(pid: number | undefined): Promise<void> {
    try {
      const rec = asRecord(await this.deps.load())
      if (rec && rec.pid === pid) await this.deps.save(null)
    } catch (e) {
      this.deps.log?.(`결과 뷰어 기록을 못 지웠어요: ${errorText(e)}`)
    }
  }

  private async remember(rec: ViewerRecord | null): Promise<void> {
    try {
      await this.deps.save(rec)
    } catch (e) {
      this.deps.log?.(`결과 뷰어 기록을 못 남겼어요: ${errorText(e)}`)
    }
  }

  /** 워커가 내려갈 때 뷰어를 같이 끈다 */
  async stop(): Promise<void> {
    this.stopped = true
    const cur = this.cur
    this.cur = null
    if (!cur) return
    cur.kill()
    await this.forget(cur.pid())
  }
}

function waitForUrl(child: ChildProcess, onExit: () => void): Promise<string> {
  const url = new Promise<string>((resolve, reject) => {
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      reject(new Error(`${VIEWER_START_MS / 1000}초 안에 주소를 못 받았어요`))
      child.kill()
    }, VIEWER_START_MS)
    child.stdout?.on('data', (d) => {
      out = (out + d.toString()).slice(-4000)
      const m = URL_PATTERN.exec(out)
      if (!m) return
      clearTimeout(timer)
      resolve(m[0])
    })
    child.stderr?.on('data', (d) => {
      err = (err + d.toString()).slice(-1000)
    })
    child.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      onExit()
      reject(new Error(err.trim() || `뷰어가 끝났어요(종료 코드 ${String(code)})`))
    })
  })
  url.catch(() => undefined)
  return url
}

function asRecord(v: unknown): ViewerRecord | null {
  const r = (v ?? null) as Partial<ViewerRecord> | null
  if (!r || typeof r !== 'object') return null
  if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) return null
  if (typeof r.url !== 'string' || URL_PATTERN.exec(r.url)?.[0] !== r.url) return null
  if (typeof r.key !== 'string') return null
  return { pid: r.pid, url: r.url, key: r.key }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // 살아 있지만 신호를 보낼 권한이 없는 프로세스는 우리가 띄운 뷰어가 아니다
    return false
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid)
  } catch {
    // 이미 끝났다
  }
}

/** pid가 다른 프로그램에 다시 쓰였을 수 있어서 주소가 결과 뷰어 화면을 주는지까지 본다 */
function probe(url: string): Promise<boolean> {
  const port = Number(url.slice(url.lastIndexOf(':') + 1))
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
      res.resume()
      const type = res.headers['content-type']
      resolve(res.statusCode === 200 && typeof type === 'string' && type.startsWith('text/html'))
    })
    req.setTimeout(PROBE_MS, () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
    req.end()
  })
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
