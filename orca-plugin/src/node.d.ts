// 플러그인 tsconfig는 오르카 타입만 싣는다. 워커가 쓰는 Node API만 여기 적는다.

declare module 'node:child_process' {
  export type ExecFileError = Error & { code?: string | number; killed?: boolean }
  export type ExecFileOptions = {
    cwd?: string
    env?: Record<string, string | undefined>
    timeout?: number
    maxBuffer?: number
    windowsHide?: boolean
  }
  export function execFile(
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (error: ExecFileError | null, stdout: string, stderr: string) => void
  ): unknown
}

declare module 'node:fs' {
  export type FSWatcher = {
    close(): void
    on(event: 'error', listener: (error: Error) => void): FSWatcher
  }
  export function existsSync(path: string): boolean
  export function watch(path: string, listener: (event: string) => void): FSWatcher
  export function realpathSync(path: string): string
  // 아래는 테스트만 쓴다
  export function mkdtempSync(prefix: string): string
  export function writeFileSync(path: string, data: string): void
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function basename(path: string): string
  export function resolve(...parts: string[]): string
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}

declare const process: { env: Record<string, string | undefined> }

declare module 'node:http' {
  export type IncomingMessage = {
    method?: string
    url?: string
    headers: Record<string, string | string[] | undefined>
  }
  export type ServerResponse = {
    writeHead(status: number, headers?: Record<string, string | number>): ServerResponse
    end(body?: string): void
  }
  export type Server = {
    listen(port: number, host: string, callback?: () => void): Server
    close(callback?: (error?: Error) => void): Server
    closeAllConnections?(): void
    address(): { port: number } | string | null
    once(event: 'error', listener: (error: Error & { code?: string }) => void): Server
    once(event: 'listening', listener: () => void): Server
    off(event: 'error', listener: (error: Error & { code?: string }) => void): Server
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server
  // 아래는 테스트만 쓴다
  export type ClientResponse = {
    statusCode?: number
    headers: Record<string, string | string[] | undefined>
    setEncoding(encoding: 'utf8'): void
    on(event: 'data', listener: (chunk: string) => void): ClientResponse
    on(event: 'end', listener: () => void): ClientResponse
  }
  export type ClientRequest = {
    on(event: 'error', listener: (error: Error) => void): ClientRequest
    end(): void
  }
  export function request(
    options: { host: string; port: number; path: string; method: string; headers?: Record<string, string> },
    callback: (res: ClientResponse) => void
  ): ClientRequest
}

declare module 'node:crypto' {
  export function createHash(algorithm: 'sha256'): {
    update(data: string): { digest(encoding: 'base64'): string }
  }
}
