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
