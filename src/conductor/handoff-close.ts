import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isSessionId,
  readHandoffRecord,
  readSessionRegisteredAt,
  recordHandoff,
  SESSIONS_DIR,
  sessionDir,
  type HandoffCloseOutcome,
} from './handoff.js';
import { execRunner, type CommandResult, type CommandRunner } from './launcher.js';
import { isTerminalHandle, type SessionTab } from './tab-title.js';

/**
 * 인계를 마친 이전 지휘자 세션 탭 닫기.
 *
 * 타이머는 이전 세션에 두지 않는다. 이전 세션 프로세스는 탭이 닫히면 같이 사라지고 반복도 이미 멈췄다.
 * 대신 tick마다 지금 도는 컨덕터 세션이 저장소의 `handoff.json`을 훑어 기한이 지난 탭을 닫는다.
 * 새 세션이 살아 있다는 근거는 인계 시각부터 기한 안에 등록된 다른 세션이다. 그 세션은 첫 tick을 돌아야
 * 등록되므로 기한 안에 첫 tick이 없으면 이전 탭을 닫지 않고 남긴다.
 */

const CLOSE_CLAIM = 'close-claim';
const CLOSE_TIMEOUT_MS = 10_000;

export interface HandoffCloseResult {
  sessionId: string;
  state: HandoffCloseOutcome['state'];
  detail: string;
}

export interface ClosePreviousOptions {
  stateDir: string;
  /** tick을 돌리는 지금 세션. 이 세션의 기록은 건드리지 않는다 */
  sessionId: string;
  /** 지금 세션이 앉은 탭. 닫을 탭이 이 탭과 같으면 닫지 않는다 */
  currentTab?: SessionTab;
  /** 인계 뒤 이만큼(초) 지나면 닫는다. 0이면 아무것도 안 한다 */
  closeAfterSec: number;
  now: Date;
  orcaCommand?: string;
  runner?: CommandRunner;
  cwd?: string;
}

export async function closeHandedOffTabs(
  opts: ClosePreviousOptions,
): Promise<HandoffCloseResult[]> {
  if (opts.closeAfterSec <= 0) return [];
  const root = join(opts.stateDir, SESSIONS_DIR);
  if (!existsSync(root)) return [];
  const ids = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isSessionId(d.name))
    .map((d) => d.name);
  let registered: Map<string, number> | undefined;
  const results: HandoffCloseResult[] = [];
  for (const id of ids) {
    if (id === opts.sessionId) continue;
    const record = readHandoffRecord(opts.stateDir, id);
    if (!record?.launched || record.close || !record.previousTab) continue;
    const handedAt = Date.parse(record.at);
    if (!Number.isFinite(handedAt)) continue;
    const deadline = handedAt + opts.closeAfterSec * 1000;
    if (opts.now.getTime() < deadline) continue;
    registered ??= registeredSessions(opts.stateDir, ids);
    const successor = [...registered].some(
      ([other, at]) => other !== id && at >= handedAt && at <= deadline,
    );
    // 기한을 넘긴 기록 하나를 tick 둘이 같이 닫지 않게 wx 파일로 먼저 잡는다
    const claimed = claim(opts.stateDir, id, opts);
    if (claimed === 'taken') continue;
    if (claimed !== 'ok') {
      // 기록을 안 남겨 다음 tick이 다시 시도한다
      results.push({
        sessionId: id,
        state: 'failed',
        detail: `close-claim을 못 만들었어요: ${claimed}`,
      });
      continue;
    }
    const outcome = successor
      ? await closeTab(record.previousTab, opts)
      : {
          state: 'skipped' as const,
          detail: `인계 뒤 ${opts.closeAfterSec}초 안에 새 세션의 첫 tick이 없어 이전 탭을 남겼어요`,
        };
    const close = { ...outcome, at: opts.now.toISOString() };
    try {
      // 닫는 사이 같은 세션이 다시 인계했으면 새 기록을 옛 기록으로 덮지 않는다
      if (readHandoffRecord(opts.stateDir, id)?.at !== record.at)
        throw new Error('그사이 새 인계 기록이 들어왔어요');
      recordHandoff(opts.stateDir, id, { ...record, close });
    } catch (e) {
      // close-claim이 남아 다음 tick도 이 기록을 건너뛴다. 기록만 못 남긴 걸 알린다
      close.detail += `. 기록은 못 남겼어요: ${(e as Error).message}`;
    }
    results.push({ sessionId: id, state: close.state, detail: close.detail });
  }
  return results;
}

function registeredSessions(stateDir: string, ids: string[]): Map<string, number> {
  const registered = new Map<string, number>();
  for (const id of ids) {
    const at = readSessionRegisteredAt(stateDir, id);
    if (at !== undefined) registered.set(id, at);
  }
  return registered;
}

/** 새 인계를 적기 전에 지난 인계의 close-claim을 지운다. 남겨 두면 새 기록을 tick이 이미 잡힌 걸로 보고 건너뛴다 */
export function clearCloseClaim(stateDir: string, sessionId: string): void {
  rmSync(join(sessionDir(stateDir, sessionId), CLOSE_CLAIM), { force: true });
}

/** 'ok'는 잡았다, 'taken'은 이미 누가 잡았다. 그 밖의 문자열은 못 잡은 이유다 */
function claim(stateDir: string, id: string, opts: ClosePreviousOptions): string {
  try {
    writeFileSync(
      join(sessionDir(stateDir, id), CLOSE_CLAIM),
      JSON.stringify({ by: opts.sessionId, at: opts.now.toISOString() }),
      { flag: 'wx' },
    );
    return 'ok';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'taken';
    return (e as Error).message;
  }
}

async function closeTab(
  tab: SessionTab,
  opts: ClosePreviousOptions,
): Promise<Omit<HandoffCloseOutcome, 'at'>> {
  // handoff.json은 캐스팅만 하고 읽으므로 깨진 기록이 채팅 탭 분기로 새지 않게 kind를 직접 본다
  const kind = (tab as { kind?: unknown } | null)?.kind;
  if (kind === 'chat')
    return {
      state: 'skipped',
      detail: '이전 세션이 채팅 탭이라 오르카 CLI로 닫을 수 없어요. 탭을 직접 닫아 주세요',
    };
  const handle = (tab as { handle?: unknown }).handle;
  if (kind !== 'terminal' || !isTerminalHandle(handle))
    return {
      state: 'skipped',
      detail: '기록된 이전 탭 정보가 터미널 핸들 꼴이 아니라 닫지 않았어요. 탭을 직접 닫아 주세요',
    };
  if (opts.currentTab?.kind === 'terminal' && opts.currentTab.handle === handle)
    return {
      state: 'skipped',
      detail: '이전 탭이 지금 지휘자 탭과 같아 닫지 않았어요',
    };
  if (!opts.orcaCommand)
    return { state: 'skipped', detail: '오르카가 없어 이전 탭을 못 닫았어요. 직접 닫아 주세요' };
  const runner = opts.runner ?? execRunner;
  let r: CommandResult;
  try {
    // 핸들이 --로 시작해도 플래그로 안 읽히게 값을 붙여 넘긴다
    r = await runner(
      opts.orcaCommand,
      ['terminal', 'close', `--terminal=${handle}`, '--tab', '--json'],
      { ...(opts.cwd ? { cwd: opts.cwd } : {}), timeoutMs: CLOSE_TIMEOUT_MS },
    );
  } catch (err) {
    r = { code: 1, stdout: '', stderr: (err as Error).message };
  }
  if (r.code !== 0) {
    const head = (r.stderr || r.stdout).trim().split('\n').slice(0, 2).join(' ');
    return {
      state: 'failed',
      detail: `오르카 terminal close 실패(${r.code}): ${head}. 이전 탭을 직접 닫아 주세요`,
    };
  }
  return { state: 'closed', detail: `이전 지휘자 탭(${handle})을 닫았어요` };
}

/** tick 텍스트 출력 한 줄. 닫았으면 알림, 아니면 경고 */
export function handoffCloseLine(r: HandoffCloseResult): string {
  return r.state === 'closed'
    ? `이전 지휘자 세션 ${r.sessionId}: ${r.detail}`
    : `경고: 이전 지휘자 세션 ${r.sessionId}: ${r.detail}`;
}
