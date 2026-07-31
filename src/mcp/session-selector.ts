import { readActiveSession } from '../execute/rule-writer.js';

export type SessionKind = 'interview' | 'execute';

export interface SessionRef {
  sessionId: string;
  updatedAt: string;
}

export interface SelectorDeps {
  listInterviewSessions?: () => SessionRef[];
  listExecuteSessions?: () => SessionRef[];
  cwd?: string;
}

export type SessionSelectorResult = { ok: true; sessionId: string } | { ok: false; error: string };

const ACTIVE = 'active';
const LATEST = 'latest';

const ERR_NO_ACTIVE =
  '활성 실행 세션이 없습니다. ges_execute action=start로 실행을 시작하거나, sessionId에 UUID를 직접 넣으세요.';
const ERR_ACTIVE_ON_INTERVIEW =
  'active는 실행 세션에만 쓸 수 있습니다. 인터뷰 세션은 latest를 쓰거나 UUID를 직접 넣으세요.';
const ERR_NO_INTERVIEW_SESSION =
  '기록된 인터뷰 세션이 없습니다. ges_interview action=start로 인터뷰를 시작하세요.';
const ERR_NO_EXECUTE_SESSION =
  '기록된 실행 세션이 없습니다. ges_execute action=start로 실행을 시작하세요.';
const ERR_NO_ANY_SESSION =
  '기록된 세션이 없습니다. ges_interview action=start로 인터뷰를 시작하거나 ges_execute action=start로 실행을 시작하세요.';

/** 셀렉터 키워드인지 판별한다. UUID는 false. */
export function isSessionSelector(input: string): boolean {
  const normalized = normalize(input);
  return normalized === ACTIVE || normalized === LATEST;
}

/**
 * sessionId 입력을 실제 UUID로 해석한다.
 * `active`와 `latest`만 셀렉터로 다루고 나머지는 그대로 통과시킨다.
 *
 * `active`는 `.gestalt/active-session.json`이 실행 세션만 가리키므로 실행 세션 전용이다.
 * 인터뷰에 들어오면 조용히 `latest`로 바꾸지 않고 에러로 거절한다.
 */
export function resolveSessionId(
  input: string,
  kind: SessionKind,
  deps: SelectorDeps,
): SessionSelectorResult {
  const normalized = normalize(input);

  if (normalized === ACTIVE) {
    if (kind === 'interview') return { ok: false, error: ERR_ACTIVE_ON_INTERVIEW };
    return resolveActive(deps);
  }

  if (normalized === LATEST) {
    return resolveLatest(kind, deps);
  }

  return { ok: true, sessionId: input };
}

/**
 * ges_status용 해석. sessionType이 'all'이면 종류를 확정할 수 없으므로
 * `active`는 실행 세션으로, `latest`는 두 종류 중 updatedAt이 더 최근인 쪽으로 해석한다.
 */
export function resolveStatusSessionId(
  input: string,
  sessionType: 'interview' | 'execute' | 'all',
  deps: SelectorDeps,
): SessionSelectorResult {
  const normalized = normalize(input);
  if (!isSessionSelector(input)) return { ok: true, sessionId: input };

  if (sessionType !== 'all') return resolveSessionId(input, sessionType, deps);

  // sessionType='all' — active-session.json은 실행 세션만 가리킨다.
  if (normalized === ACTIVE) return resolveActive(deps);

  const newestInterview = newest(deps.listInterviewSessions?.() ?? []);
  const newestExecute = newest(deps.listExecuteSessions?.() ?? []);
  if (!newestInterview && !newestExecute) return { ok: false, error: ERR_NO_ANY_SESSION };
  if (!newestInterview) return { ok: true, sessionId: newestExecute!.sessionId };
  if (!newestExecute) return { ok: true, sessionId: newestInterview.sessionId };

  return {
    ok: true,
    sessionId:
      newestExecute.updatedAt.localeCompare(newestInterview.updatedAt) >= 0
        ? newestExecute.sessionId
        : newestInterview.sessionId,
  };
}

export interface SessionLister {
  listSessions(): SessionRef[];
}

/**
 * 인터뷰 도구용 래퍼. sessionId가 없으면 그대로 통과시켜 각 액션의 필수값 검사를 그대로 남긴다.
 */
export function resolveInterviewSessionId(
  engine: SessionLister,
  sessionId: string | undefined,
): { ok: true; sessionId: string | undefined } | { ok: false; error: string } {
  if (!sessionId) return { ok: true, sessionId };
  const resolved = resolveSessionId(sessionId, 'interview', {
    listInterviewSessions: () => engine.listSessions(),
  });
  return resolved.ok ? { ok: true, sessionId: resolved.sessionId } : resolved;
}

function resolveActive(deps: SelectorDeps): SessionSelectorResult {
  const active = readActiveSession(deps.cwd ?? process.cwd());
  if (!active?.sessionId) return { ok: false, error: ERR_NO_ACTIVE };
  return { ok: true, sessionId: active.sessionId };
}

function resolveLatest(kind: SessionKind, deps: SelectorDeps): SessionSelectorResult {
  const sessions =
    kind === 'interview'
      ? (deps.listInterviewSessions?.() ?? [])
      : (deps.listExecuteSessions?.() ?? []);
  const picked = newest(sessions);
  if (!picked) {
    return {
      ok: false,
      error: kind === 'interview' ? ERR_NO_INTERVIEW_SESSION : ERR_NO_EXECUTE_SESSION,
    };
  }
  return { ok: true, sessionId: picked.sessionId };
}

/**
 * updatedAt 내림차순 첫 항목.
 * SessionManager.list()는 createdAt 정렬이라 그대로 쓸 수 없어 여기서 다시 정렬한다.
 */
function newest(sessions: SessionRef[]): SessionRef | undefined {
  return sessions.reduce<SessionRef | undefined>((best, s) => {
    if (!best) return s;
    return s.updatedAt.localeCompare(best.updatedAt) > 0 ? s : best;
  }, undefined);
}

function normalize(input: string): string {
  return input.trim().toLowerCase();
}
