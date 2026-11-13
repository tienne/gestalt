import { execRunner, type CommandRunner } from './launcher.js';

/**
 * 컨덕터 세션의 오르카 탭 이름.
 *
 * 탭 여러 개 사이에서 컨덕터를 바로 알아보게 이름을 붙인다. tick이 세션을 처음 등록할 때 한 번만
 * 부르므로 스킬로 연 세션도, handoff로 띄운 새 세션도 첫 tick에서 이름이 붙는다. tick은
 * `GESTALT_CONDUCTOR_WORKER_ID`가 있는 세션이나 살아 있는 워커의 워크트리 안에서 거절되니 보통 워커
 * 탭에는 안 붙는다. 오르카 워커는 환경 변수로 컨덕터와 구분이 안 돼 작업 디렉토리로만 가르므로 워커가
 * 워크트리 밖에서 tick을 부르면 그 탭 이름도 바뀐다. 사람이 나중에 탭 이름을 바꿔도 다시 덮지 않는다.
 */

export const CONDUCTOR_TAB_TITLE = '🤴 지휘자 세션 🤴';

const RENAME_TIMEOUT_MS = 10_000;

/**
 * 이 세션이 앉은 오르카 탭을 바꾸는 CLI 인자. 오르카 밖이면 undefined.
 *
 * 채팅 탭은 `ORCA_STRUCTURED_SESSION=1`이고 `chat rename`이 지금 채팅을 기본 대상으로 잡는다.
 * 채팅에도 `ORCA_TERMINAL_HANDLE`이 있지만 터미널 핸들이 아니라서 채팅 판정을 먼저 한다.
 */
export function tabRenameArgs(env: NodeJS.ProcessEnv): string[] | undefined {
  if (env['ORCA_STRUCTURED_SESSION'] === '1') {
    return ['chat', 'rename', '--name', CONDUCTOR_TAB_TITLE, '--json'];
  }
  const handle = env['ORCA_TERMINAL_HANDLE'];
  if (handle) {
    // 핸들이 --로 시작해도 플래그로 안 읽히게 값을 붙여 넘긴다
    return ['terminal', 'rename', `--terminal=${handle}`, '--title', CONDUCTOR_TAB_TITLE, '--json'];
  }
  return undefined;
}

/**
 * 실패해도 던지지 않고 실패 메시지를 돌려준다. 탭 이름 때문에 컨덕터 진행이 멈추면 안 된다.
 * 오르카 밖이거나 CLI를 못 찾아 건너뛰었을 때와 바꾼 때는 undefined다.
 */
export async function nameConductorTab(opts: {
  env: NodeJS.ProcessEnv;
  orcaCommand?: string;
  runner?: CommandRunner;
  cwd?: string;
}): Promise<string | undefined> {
  const args = tabRenameArgs(opts.env);
  if (!args || !opts.orcaCommand) return undefined;
  const runner = opts.runner ?? execRunner;
  const r = await runner(opts.orcaCommand, args, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    timeoutMs: RENAME_TIMEOUT_MS,
  }).catch((err: unknown) => ({ code: 1, stdout: '', stderr: (err as Error).message }));
  if (r.code !== 0) {
    const head = (r.stderr || r.stdout).trim().split('\n').slice(0, 2).join(' ');
    return `오르카 ${args[0]} rename 실패(${r.code}): ${head}`;
  }
  return undefined;
}
