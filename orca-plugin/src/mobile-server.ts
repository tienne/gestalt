// 보기 전용 페이지를 이 맥의 루프백에만 연다. 바깥에서 보려면 사람이 tailscale serve로 이 포트를 테일넷에 잇는다.
// 읽기만 하므로 GET과 HEAD 말고는 받지 않고, 컨덕터 상태를 바꾸는 길은 두지 않는다.
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mobileFragment, mobilePage, SCRIPT } from './mobile'
import type { ConductorView } from './protocol'

export const FRAGMENT_HEADER = 'x-conductor-fragment'

// 인라인 스크립트는 SCRIPT 해시 하나만 허용한다. 이스케이프가 빠져 다른 스크립트가 섞여도 실행을 막는 건 브라우저 CSP가 맡는다
const SCRIPT_HASH = createHash('sha256').update(SCRIPT).digest('base64')

const SECURITY_HEADERS = {
  'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store'
}

/**
 * 루프백 주소나 테일넷 이름으로 들어온 요청만 받는다.
 * 브라우저에서 아무 사이트가 DNS를 이 맥으로 돌려 페이지를 읽어 가는 일(DNS rebinding)을 막으려는 것이다.
 */
export function allowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false
  const h = host.toLowerCase()
  if (h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`) return true
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net(:\d+)?$/.test(h)
}

export class MobileServer {
  private server: Server | null = null
  private port = 0

  constructor(private readonly view: () => ConductorView | null) {}

  get listening(): number | null {
    return this.server ? this.port : null
  }

  /** 실제로 연 포트를 돌려준다. 0을 주면 남는 포트를 고른다(테스트용) */
  async start(port: number): Promise<number> {
    await this.stop()
    const server = createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      const fail = (e: Error) => reject(e)
      server.once('error', fail)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', fail)
        resolve()
      })
    })
    const addr = server.address()
    this.port = typeof addr === 'object' && addr ? addr.port : port
    this.server = server
    return this.port
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    // 폰 브라우저가 keep-alive로 붙잡은 연결이 있으면 close가 안 끝난다
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const send = (status: number, body: string, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' })
      res.end()
      return
    }
    const host = req.headers['host']
    if (!allowedHost(typeof host === 'string' ? host : undefined, this.port)) return send(403, 'forbidden')
    if ((req.url ?? '/').split('?')[0]!.endsWith('/favicon.ico')) return send(404, 'not found')

    const fragment = mobileFragment(this.view())
    if (req.headers[FRAGMENT_HEADER] === '1') return send(200, fragment, 'text/html; charset=utf-8')
    send(200, mobilePage(fragment), 'text/html; charset=utf-8')
  }
}
