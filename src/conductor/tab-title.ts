import { execRunner, type CommandResult, type CommandRunner } from './launcher.js';

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
export function tabRenameArgs(
  env: NodeJS.ProcessEnv,
  title: string = CONDUCTOR_TAB_TITLE,
): string[] | undefined {
  if (env['ORCA_STRUCTURED_SESSION'] === '1') return chatRenameArgs(title);
  const handle = env['ORCA_TERMINAL_HANDLE'];
  if (handle) return terminalRenameArgs(handle, title);
  return undefined;
}

// sessionId가 없으면 오르카가 명령을 부른 채팅을 대상으로 잡는다
function chatRenameArgs(title: string, sessionId?: string): string[] {
  const target = sessionId ? [`--session=${sessionId}`] : [];
  return ['chat', 'rename', ...target, '--name', title, '--json'];
}

// 핸들이 --로 시작해도 플래그로 안 읽히게 값을 붙여 넘긴다
function terminalRenameArgs(handle: string, title: string): string[] {
  return ['terminal', 'rename', `--terminal=${handle}`, '--title', title, '--json'];
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
  return runRename(opts.orcaCommand, args, opts.runner, opts.cwd);
}

async function runRename(
  orcaCommand: string,
  args: string[],
  runner: CommandRunner = execRunner,
  cwd?: string,
): Promise<string | undefined> {
  let r: CommandResult;
  // 주입한 러너가 동기로 던져도 Promise.all이 무너지지 않게 await 안에서 잡는다
  try {
    r = await runner(orcaCommand, args, {
      ...(cwd ? { cwd } : {}),
      timeoutMs: RENAME_TIMEOUT_MS,
    });
  } catch (err) {
    r = { code: 1, stdout: '', stderr: (err as Error).message };
  }
  if (r.code !== 0) {
    const head = (r.stderr || r.stdout).trim().split('\n').slice(0, 2).join(' ');
    return `오르카 ${args[0]} rename 실패(${r.code}): ${head}`;
  }
  return undefined;
}

/** 오르카 `agent launch`가 띄운 탭. 채팅이면 채팅 세션 id, 터미널이면 터미널 핸들로 가리킨다 */
export type LaunchedTab =
  | { kind: 'chat'; sessionId: string }
  | { kind: 'terminal'; handle: string };

/** 인계를 마친 세션 탭 이름. 지금 도는 컨덕터와 헷갈리지 않게 왕관을 떼고 날짜를 붙인다 */
export function handedOffTabTitle(now: Date): string {
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `지휘자 세션 (인계 완료, ${mm}/${dd})`;
}

/**
 * 인계 직후 두 탭 이름을 바꾼다. 넘긴 세션 탭은 인계 완료로, 새로 띄운 탭은 지금 도는 컨덕터 이름으로 바꾼다.
 * 새 탭은 첫 tick에서도 같은 이름을 받지만 그 전까지 두 탭이 같은 이름으로 남지 않게 여기서 먼저 바꾼다.
 * launch 응답에서 새 탭을 못 읽었으면 넘긴 탭만 바꾸고 그 사실을 실패 메시지로 남긴다.
 * 실패해도 던지지 않고 실패 메시지 목록을 돌려준다. 인계는 이미 끝난 뒤라 이름 때문에 실패로 돌리지 않는다.
 */
export async function renameHandoffTabs(opts: {
  env: NodeJS.ProcessEnv;
  orcaCommand: string;
  launched?: LaunchedTab;
  now: Date;
  runner?: CommandRunner;
  cwd?: string;
}): Promise<string[]> {
  const jobs: string[][] = [];
  const current = tabRenameArgs(opts.env, handedOffTabTitle(opts.now));
  if (current) jobs.push(current);
  const tab = opts.launched;
  if (tab?.kind === 'chat') jobs.push(chatRenameArgs(CONDUCTOR_TAB_TITLE, tab.sessionId));
  else if (tab?.kind === 'terminal') jobs.push(terminalRenameArgs(tab.handle, CONDUCTOR_TAB_TITLE));
  // 두 탭은 서로 다른 대상이라 순서가 상관없다
  const results = await Promise.all(
    jobs.map((args) => runRename(opts.orcaCommand, args, opts.runner, opts.cwd)),
  );
  const errors = results.filter((f): f is string => !!f);
  if (!tab)
    errors.push(
      '새 탭을 launch 응답에서 못 찾아 이름을 안 바꿨어요. 새 세션의 첫 tick에서 이름이 붙어요',
    );
  return errors;
}
