import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../core/json-file.js';
import {
  handoffRecordPath,
  isSessionId,
  readSessionRegisteredAt,
  sessionDir,
  SESSIONS_DIR,
} from './handoff.js';

/**
 * 컨덕터 세션을 하나로 묶는다.
 *
 * tick을 부른 세션은 전부 컨덕터로 등록되므로 다른 탭에서 주문을 넣으려고 스킬을 부르면 그 탭도 컨덕터가 된다.
 * 그래서 처음 등록하려는 세션은 최근에 tick을 돌린 다른 세션이 있으면 거절한다. 등록에 성공하면
 * 나머지 세션을 넘겨받은 것으로 적어 그 세션의 tick도 거절한다.
 */

const LAST_TICK_FILE = 'last-tick';
const SUPERSEDED_FILE = 'superseded.json';

export interface ActiveConductor {
  sessionId: string;
  cwd?: string;
  lastTickAt: string;
}

export interface SupersededRecord {
  at: string;
  by: string;
}

/** tick을 돌릴 때마다 이 세션의 마지막 tick 시각을 남긴다. 건너뛴 tick도 세션이 살아 있다는 근거라 같이 적는다 */
export function touchSessionTick(stateDir: string, sessionId: string, now: Date): void {
  writeFileSync(join(sessionDir(stateDir, sessionId), LAST_TICK_FILE), now.toISOString(), 'utf-8');
}

function lastTickMs(stateDir: string, sessionId: string): number | undefined {
  try {
    const at = Date.parse(
      readFileSync(join(sessionDir(stateDir, sessionId), LAST_TICK_FILE), 'utf-8').trim(),
    );
    if (Number.isFinite(at)) return at;
  } catch {
    // last-tick을 남기기 전 판에서 등록된 세션은 등록 시각으로 본다
  }
  return readSessionRegisteredAt(stateDir, sessionId);
}

function readCwd(stateDir: string, sessionId: string): string | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(join(sessionDir(stateDir, sessionId), 'session.json'), 'utf-8'),
    ) as { cwd?: unknown };
    return typeof raw.cwd === 'string' ? raw.cwd : undefined;
  } catch {
    return undefined;
  }
}

/** 인계했거나 넘겨받힌 세션을 뺀 등록 세션 id. 자기 자신도 뺀다 */
function liveCandidates(stateDir: string, selfId: string): string[] {
  const root = join(stateDir, SESSIONS_DIR);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isSessionId(d.name) && d.name !== selfId)
    .map((d) => d.name)
    .filter(
      (id) => !existsSync(handoffRecordPath(stateDir, id)) && !readSupersededRecord(stateDir, id),
    );
}

/** windowMs 안에 tick을 돌린 다른 컨덕터 세션. 여럿이면 가장 최근 것 */
export function findActiveConductor(
  stateDir: string,
  selfId: string,
  nowMs: number,
  windowMs: number,
): ActiveConductor | undefined {
  let best: { id: string; at: number } | undefined;
  for (const id of liveCandidates(stateDir, selfId)) {
    const at = lastTickMs(stateDir, id);
    if (at === undefined || nowMs - at > windowMs) continue;
    if (!best || at > best.at) best = { id, at };
  }
  if (!best) return undefined;
  const cwd = readCwd(stateDir, best.id);
  return {
    sessionId: best.id,
    ...(cwd ? { cwd } : {}),
    lastTickAt: new Date(best.at).toISOString(),
  };
}

/** 새 컨덕터가 등록되면 나머지 세션을 넘겨받은 것으로 적는다. 적은 세션 id를 돌려준다 */
export function supersedeOthers(stateDir: string, selfId: string, now: Date): string[] {
  const ids = liveCandidates(stateDir, selfId);
  for (const id of ids) {
    const record: SupersededRecord = { at: now.toISOString(), by: selfId };
    writeJsonAtomic(supersededRecordPath(stateDir, id), record);
  }
  return ids;
}

export function supersededRecordPath(stateDir: string, sessionId: string): string {
  return join(sessionDir(stateDir, sessionId), SUPERSEDED_FILE);
}

export function readSupersededRecord(
  stateDir: string,
  sessionId: string,
): SupersededRecord | undefined {
  const file = supersededRecordPath(stateDir, sessionId);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as SupersededRecord;
  } catch {
    // 깨진 파일이어도 넘겨받힌 건 맞다. 거절 쪽으로 둔다
    return { at: '알 수 없음', by: '알 수 없음' };
  }
}
