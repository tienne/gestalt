import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * cwd는 레포 밖에 새로 만든 임시 폴더여야 한다. yt-dlp는 cwd의 yt-dlp.conf를 설정으로 읽고
 * python3 -c는 cwd의 모듈을 먼저 import해서, 남의 레포 안에서 돌리면 그 레포 파일이 실행된다
 */
export type RunCommand = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
) => Promise<RunResult>;

export class CommandError extends Error {
  constructor(
    readonly cmd: string,
    readonly stderr: string,
    message: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

/** yt-dlp -J 결과가 수 MB라 기본 버퍼(1MB)로는 잘린다 */
const MAX_BUFFER = 64 * 1024 * 1024;

export const runCommand: RunCommand = async (cmd, args, opts) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      maxBuffer: MAX_BUFFER,
      timeout: opts.timeoutMs ?? 0,
      encoding: 'utf8',
    });
    return { stdout, stderr };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (err.killed && opts.timeoutMs) {
      throw new CommandError(
        cmd,
        typeof err.stderr === 'string' ? err.stderr : '',
        `${cmd}가 ${Math.round(opts.timeoutMs / 1000)}초 안에 끝나지 않아 멈췄어요.`,
      );
    }
    if (err.code === 'ENOENT') {
      throw new CommandError(
        cmd,
        '',
        `${cmd}를 찾지 못했어요. 설치한 뒤 PATH에 있는지 확인해 주세요.`,
      );
    }
    const stderr = typeof err.stderr === 'string' ? err.stderr : '';
    const tail = stderr.trim().split('\n').slice(-3).join('\n');
    throw new CommandError(cmd, stderr, `${cmd} 실행 실패: ${tail || err.message}`);
  }
};

/**
 * 유튜브가 기본 클라이언트 요청에 403을 내는 경우가 잦아서 web_embedded로 한 번 더 시도한다.
 * 실험해 보니 web_embedded는 메타데이터와 자막, 720p 이하 영상 포맷까지 받아진다.
 */
export const WEB_EMBEDDED = ['--extractor-args', 'youtube:player_client=web_embedded'];

const is403 = (e: unknown) => e instanceof CommandError && /\b403\b|Forbidden/i.test(e.stderr);

export async function ytdlp(
  run: RunCommand,
  args: string[],
  retryArgs: string[] = args,
  opts: { cwd: string; timeoutMs?: number },
): Promise<RunResult> {
  const base = ['--no-update', '--no-warnings'];
  try {
    return await run('yt-dlp', [...base, ...args], opts);
  } catch (e) {
    if (!is403(e)) throw e;
    return run('yt-dlp', [...base, ...WEB_EMBEDDED, ...retryArgs], opts);
  }
}

/** 메타데이터와 자막은 영상 길이와 무관하게 금방 끝난다. 이보다 길면 네트워크가 멈춘 것이다 */
export const QUICK_TIMEOUT_MS = 120_000;

/**
 * 영상 길이에 비례하는 작업의 상한. 느린 회선에서도 넉넉하게 잡되 멈춘 프로세스를 무한정 기다리지는 않는다
 */
export function timeoutFor(durationSec: number, secPerVideoSec: number, baseSec = 120): number {
  return Math.round((baseSec + Math.max(0, durationSec) * secPerVideoSec) * 1000);
}
