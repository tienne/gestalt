// gestalt CLI를 셸 없이 부른다. 인자는 배열로만 넘겨서 주문 제목이나 답이 명령으로 읽히지 않는다.
import { execFile, type ExecFileError } from 'node:child_process'

export type RunOptions = { cwd: string; timeoutMs: number }

export class CliError extends Error {}

export function runGestalt(command: string, args: string[], opts: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error: ExecFileError | null, stdout: string, stderr: string) => {
        if (!error) return resolve(stdout)
        reject(new CliError(describe(command, error, stderr)))
      }
    )
  })
}

function describe(command: string, error: ExecFileError, stderr: string): string {
  if (error.code === 'ENOENT')
    return `gestalt 실행 파일을 못 찾았어요(${command}). 설정의 gestalt 경로에 절대 경로를 적어 주세요`
  if (error.killed) return `gestalt가 제한 시간 안에 끝나지 않았어요(${command})`
  const detail = stderr.trim().split('\n').slice(-5).join('\n').slice(0, 1000)
  return detail || `gestalt가 실패했어요(종료 코드 ${String(error.code ?? '?')})`
}
