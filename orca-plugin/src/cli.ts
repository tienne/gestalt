// gestalt CLI를 셸 없이 부른다. 인자는 배열로만 넘겨서 주문 제목이나 답이 명령으로 읽히지 않는다.
import { execFile, type ExecFileError } from 'node:child_process'

export type RunOptions = { cwd: string; timeoutMs: number }

/** 실패해도 stdout을 같이 들고 간다. `--json` 명령은 실패할 때도 stdout에 결과를 남길 수 있다 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly stdout = ''
  ) {
    super(message)
  }
}

const TAIL_LINES = 5
const TAIL_CHARS = 1000

export function runGestalt(command: string, args: string[], opts: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error: ExecFileError | null, stdout: string, stderr: string) => {
        if (!error) return resolve(stdout)
        reject(new CliError(describe(command, error, stderr), stdout))
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
