import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** 세션마다 기억하는 포인터 수. 넘으면 오래된 것부터 잊는다 */
export const MAX_REMEMBERED = 40;

/** 이보다 오래 안 쓰인 세션 상태 파일은 SessionStart 때 지운다 */
const SESSION_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionState {
  /** UserPromptSubmit에서 넣은 포인터. 키는 `상대경로#심볼이름` */
  pointers: string[];
  /** PostToolUse에서 영향 범위를 넣은 파일 */
  impacts: string[];
}

export function hooksDir(repoRoot: string): string {
  return join(repoRoot, '.gestalt', 'hooks');
}

function sessionsDir(repoRoot: string): string {
  return join(hooksDir(repoRoot), 'sessions');
}

/** session_id는 밖에서 들어온 값이라 파일 이름에 쓸 수 있는 글자만 남긴다 */
function sessionFile(repoRoot: string, sessionId: string): string | null {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
  if (!safe) return null;
  return join(sessionsDir(repoRoot), `${safe}.json`);
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function readSessionState(repoRoot: string, sessionId: string): SessionState {
  const file = sessionFile(repoRoot, sessionId);
  if (!file) return { pointers: [], impacts: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<
      Record<keyof SessionState, unknown>
    >;
    return { pointers: asStrings(raw.pointers), impacts: asStrings(raw.impacts) };
  } catch {
    return { pointers: [], impacts: [] };
  }
}

/** 새 키를 뒤에 붙이고 MAX_REMEMBERED만 남긴다 */
export function remember(list: string[], keys: string[]): string[] {
  const merged = [...list.filter((k) => !keys.includes(k)), ...keys];
  return merged.slice(-MAX_REMEMBERED);
}

/**
 * 임시 파일에 쓰고 rename한다. 같은 세션의 훅 둘이 겹쳐 돌아도 반쯤 쓴 JSON을
 * 읽지 않게 하려는 것이다. 겹친 쪽 하나의 기록이 사라질 수는 있는데, 그러면 포인터가
 * 한 번 더 들어갈 뿐이라 락까지는 안 잡는다.
 */
export function writeSessionState(repoRoot: string, sessionId: string, state: SessionState): void {
  const file = sessionFile(repoRoot, sessionId);
  if (!file) return;
  mkdirSync(sessionsDir(repoRoot), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}

export function pruneSessionStates(repoRoot: string, now = Date.now()): void {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir(repoRoot));
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(sessionsDir(repoRoot), name);
    try {
      if (now - statSync(path).mtimeMs > SESSION_STATE_TTL_MS) unlinkSync(path);
    } catch {
      // 다른 세션이 먼저 지웠다
    }
  }
}
