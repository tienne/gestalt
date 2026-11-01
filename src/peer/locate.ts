import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Claude Code 대화 기록 위치 찾기.
 *
 * `sessions/<pid>.json`과 `projects/<슬러그>/<sessionId>.jsonl` 둘 다 문서화되지 않은
 * 형식이다. 그래서 형식이 예상과 다르면 던지지 않고 이유를 담아 돌려준다 — 부르는 쪽이
 * "어디서 무엇을 찾다 못 찾았는지"를 사람에게 그대로 보여줄 수 있어야 한다.
 */

export type LocateResult =
  | { ok: true; path: string; sessionId: string; configDir: string; cwd?: string }
  | { ok: false; reason: string; configDir: string; sessionId?: string };

export interface SessionRecord {
  sessionId: string;
  cwd: string;
  pid?: number;
  /** 세션의 인박스 소켓(cross-session messaging 수신구). 메시지를 넣을 때 쓴다 */
  messagingSocketPath?: string;
}

/** 설정 디렉토리. Orca 프로필처럼 `CLAUDE_CONFIG_DIR`로 옮겨 둔 경우가 있다 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['CLAUDE_CONFIG_DIR'];
  if (raw && isAbsolute(raw)) return raw;
  return join(homedir(), '.claude');
}

/**
 * cwd를 `projects/` 아래 디렉토리 이름으로 바꾼다. 실제 이름을 보면 영숫자와 `-`
 * 말고는 전부 `-`가 된다(`/Users/a/.x` → `-Users-a--x`, 한글도 `-`).
 */
export function cwdSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

/** sessionId가 경로 조각으로 쓰이므로 `..`이나 `/`가 들어오면 안 된다 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

/** `sessions/<pid>.json` 하나를 읽는다. 형식이 다르면 null */
export function readSessionFile(path: string): SessionRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  const sessionId = rec['sessionId'];
  const cwd = rec['cwd'];
  if (typeof sessionId !== 'string' || typeof cwd !== 'string') return null;
  const pid = typeof rec['pid'] === 'number' ? rec['pid'] : undefined;
  const sock = rec['messagingSocketPath'];
  const messagingSocketPath = typeof sock === 'string' && isAbsolute(sock) ? sock : undefined;
  return { sessionId, cwd, pid, ...(messagingSocketPath ? { messagingSocketPath } : {}) };
}

/** 부모 pid로 세션을 찾는다. MCP 서버처럼 세션의 자식이 쓴다 */
export function findSessionByPid(pid: number, configDir = claudeConfigDir()): SessionRecord | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return readSessionFile(join(configDir, 'sessions', `${pid}.json`));
}

/**
 * 명령을 친 Claude Code 세션의 id. Bash 도구가 띄운 셸은 `CLAUDE_PID`와 `CLAUDE_CODE_SESSION_ID`를 물려받는다.
 * `/clear`나 다시 이어 받기로 세션 id가 바뀌면 `sessions/<pid>.json`이 따라 바뀌므로 그쪽을 먼저 본다.
 * 세션이 비정상 종료해 남은 파일을 다른 프로세스가 같은 pid로 물려받았을 수 있어서 파일의 pid가
 * `CLAUDE_PID`와 같고 그 프로세스가 살아 있을 때만 믿는다. 아니면 `CLAUDE_CODE_SESSION_ID`로 간다.
 * `ges_peer ask_user`의 MCP 서버는 부모와 조부모 pid까지 훑고 환경 변수로는 안 돌아간다. MCP 서버는
 * 세션의 자식이라 pid를 따라가면 되고 Bash 셸은 사이에 낀 프로세스가 정해져 있지 않아서다.
 */
export function findCurrentSession(
  env: NodeJS.ProcessEnv = process.env,
  configDir = claudeConfigDir(env),
  alive: (pid: number) => boolean = isAlive,
): { ok: true; sessionId: string } | { ok: false; reason: string } {
  const pid = Number(env['CLAUDE_PID']);
  const rec = findSessionByPid(pid, configDir);
  if (rec && rec.pid === pid && alive(pid) && isSessionId(rec.sessionId)) {
    return { ok: true, sessionId: rec.sessionId };
  }
  const fromEnv = env['CLAUDE_CODE_SESSION_ID'];
  if (fromEnv && isSessionId(fromEnv)) return { ok: true, sessionId: fromEnv };
  return {
    ok: false,
    reason:
      'Claude Code 세션 안에서 친 명령이 아니에요. 세션 밖에서는 --session <sessionId>로 고르세요',
  };
}

/** 그 pid의 프로세스가 있는지. 권한이 없어 신호를 못 보내도(EPERM) 프로세스는 있는 것이다 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function findSessionById(sessionId: string, configDir: string): SessionRecord | null {
  const dir = join(configDir, 'sessions');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const rec = readSessionFile(join(dir, name));
    if (rec?.sessionId === sessionId) return rec;
  }
  return null;
}

/** `sessions/*.json`에 적힌 세션 전부. 형식이 다른 파일은 건너뛴다 */
export function listSessions(configDir: string): SessionRecord[] {
  const dir = join(configDir, 'sessions');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^\d+\.json$/.test(name))
    .map((name) => readSessionFile(join(dir, name)))
    .filter((rec): rec is SessionRecord => rec !== null && isSessionId(rec.sessionId));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * sessionId로 대화 기록 경로를 찾는다.
 *
 * 1. `sessions/*.json`에서 그 세션의 cwd를 찾아 슬러그 경로를 본다
 * 2. 없으면(세션이 끝났거나 슬러그 규칙이 다르면) `projects/*` 아래를 훑는다
 */
export function locateTranscript(sessionId: string, configDir = claudeConfigDir()): LocateResult {
  if (!isSessionId(sessionId)) {
    return { ok: false, reason: 'sessionId 형식이 아니에요', configDir };
  }
  if (!existsSync(configDir)) {
    return { ok: false, reason: '설정 디렉토리가 없어요', configDir, sessionId };
  }

  const session = findSessionById(sessionId, configDir);
  if (session) {
    const bySlug = join(configDir, 'projects', cwdSlug(session.cwd), `${sessionId}.jsonl`);
    if (isFile(bySlug)) return { ok: true, path: bySlug, sessionId, configDir, cwd: session.cwd };
  }

  const projects = join(configDir, 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return { ok: false, reason: 'projects 디렉토리를 못 읽었어요', configDir, sessionId };
  }
  for (const dir of dirs) {
    const candidate = join(projects, dir, `${sessionId}.jsonl`);
    if (isFile(candidate)) {
      return { ok: true, path: candidate, sessionId, configDir, cwd: session?.cwd };
    }
  }

  return {
    ok: false,
    reason: session
      ? '세션은 있는데 대화 기록 파일을 못 찾았어요'
      : '그 sessionId의 세션도 대화 기록도 못 찾았어요',
    configDir,
    sessionId,
  };
}
