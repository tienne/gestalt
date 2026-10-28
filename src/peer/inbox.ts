import { lstatSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { findSessionById, isSessionId } from './locate.js';

export type InboxResult = { ok: true } | { ok: false; reason: string };

/**
 * 대화 기록 경로에서 설정 디렉토리를 거꾸로 찾는다. 기록은
 * `<설정 디렉토리>/projects/<슬러그>/<sessionId>.jsonl`에 있다. 데몬과 공유를 연 쪽의
 * `CLAUDE_CONFIG_DIR`가 달라도(Orca 프로필) 이 경로가 그 세션의 설정 디렉토리를 가리킨다.
 */
export function configDirOf(transcriptPath: string): string {
  return dirname(dirname(dirname(transcriptPath)));
}

/**
 * 세션의 인박스 소켓을 찾는다. 세션이 다시 떠서 pid와 소켓이 바뀔 수 있어서 넣을 때마다
 * 찾는다. 소켓이 아니거나 남의 것이면 안 쓴다.
 */
export function findInboxSocket(
  transcriptPath: string,
  sessionId: string | null,
): InboxResult & { path?: string } {
  if (!sessionId || !isSessionId(sessionId)) {
    return {
      ok: false,
      reason: '세션을 모르는 공유라 메시지를 넣을 수 없어요 (--session으로 연 공유만 돼요)',
    };
  }
  const rec = findSessionById(sessionId, configDirOf(transcriptPath));
  if (!rec) return { ok: false, reason: '주인 세션이 떠 있지 않아요' };
  if (!rec.messagingSocketPath) return { ok: false, reason: '주인 세션에 인박스 소켓이 없어요' };
  try {
    const st = lstatSync(rec.messagingSocketPath);
    if (!st.isSocket()) return { ok: false, reason: '인박스 자리가 소켓이 아니에요' };
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid)
      return { ok: false, reason: '인박스 소켓의 주인이 내가 아니에요' };
  } catch {
    return { ok: false, reason: '인박스 소켓이 없어요' };
  }
  return { ok: true, path: rec.messagingSocketPath };
}

/**
 * 인박스 소켓에 메시지 한 줄을 쓴다. 데몬은 세션의 자식이 아니고 세션 토큰(auth 줄)도
 * 안 보내므로 Claude Code가 "다른 세션이 보낸 것"으로 다루고 `crossSessionInbound`를
 * 그대로 적용한다. 소켓은 받았는지 답하지 않는다. 들어갔는지는 대화 기록에서 본다.
 */
export function writeInbox(
  socketPath: string,
  text: string,
  timeoutMs = 5_000,
): Promise<InboxResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: InboxResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const c = createConnection(socketPath);
    const timer = setTimeout(() => {
      c.destroy();
      finish({ ok: false, reason: '인박스 소켓이 답하지 않았어요' });
    }, timeoutMs);
    c.once('error', (err) =>
      finish({ ok: false, reason: `인박스 소켓에 못 썼어요: ${err.message}` }),
    );
    c.once('connect', () => {
      const line =
        JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
      c.end(line, () => finish({ ok: true }));
    });
  });
}
