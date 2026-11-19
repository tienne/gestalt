import { type SendResult, type SessionPidCache, sendToSession } from '../digest/session-request.js';
import { findSessionSocket } from '../peer/inbox.js';
import {
  claudeConfigDir,
  findSessionByPid,
  findSessionInAncestors,
  type SessionRecord,
} from '../peer/locate.js';

/** 라이브 서버가 세션과 주고받는 길. 테스트가 바꿔 끼운다 */
export interface LiveSessionBridge {
  /** 질문을 넣을 세션이 지금 떠 있는지. 뷰어가 입력창을 띄울지 정할 때 쓴다 */
  alive(): boolean;
  send(text: string): Promise<SendResult>;
}

/** 못 찾은 결과를 기억하는 시간. 입력창 감시가 요청마다 부모 프로세스를 다 훑지 않게 한다 */
const MISS_MS = 30_000;

/**
 * 라이브 서버를 띄운 프로세스(MCP 서버)의 부모를 따라 올라가 Claude Code 세션을 찾는다.
 * 쓰는 길은 digest serve의 sendToSession을 그대로 쓰고 같은 pid 기억을 나눠 쓴다
 */
export function defaultLiveSessionBridge(now: () => number = Date.now): LiveSessionBridge {
  const cache: SessionPidCache = {};
  const locate = (): SessionRecord | null => {
    const configDir = claudeConfigDir();
    if (cache.pid !== undefined) {
      const hit = findSessionByPid(cache.pid, configDir);
      if (hit) return hit;
      cache.pid = undefined;
    }
    if (cache.missUntil !== undefined && now() < cache.missUntil) return null;
    const found = findSessionInAncestors(process.pid, configDir);
    cache.pid = found?.pid;
    cache.missUntil = found ? undefined : now() + MISS_MS;
    return found;
  };
  return {
    alive() {
      const session = locate();
      return session !== null && findSessionSocket(session.sessionId, [claudeConfigDir()]).ok;
    },
    send: (text) => sendToSession(text, { cache, now }),
  };
}
