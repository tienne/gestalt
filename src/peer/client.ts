import { createConnection } from 'node:net';
import type { PeerRequest, PeerResponse } from './protocol.js';

/**
 * 데몬이 없을 때 사람에게 띄우는 법을 알려 주는 말. 오류 메시지에는 넣지 않고 부르는 쪽이 고른다.
 * 띄워도 소용없는 명령(공유 닫기, 받아 주기 같은)이나 모델에게 가는 응답에는 붙이지 않는다
 */
export const DAEMON_NOT_RUNNING = '`gestalt peer daemon --detach`로 먼저 띄워 주세요';

export class DaemonUnavailableError extends Error {
  constructor(readonly socketPath: string) {
    super(`peer 데몬에 연결하지 못했어요 (${socketPath}).`);
    this.name = 'DaemonUnavailableError';
  }
}

/** 데몬에 요청 한 줄을 보내고 답 한 줄을 받는다 */
export function request<T = unknown>(
  sock: string,
  req: PeerRequest,
  timeoutMs = 5_000,
): Promise<PeerResponse<T>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sock);
    let buf = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`peer 데몬이 ${timeoutMs}ms 안에 답하지 않았어요`))),
      timeoutMs,
    );

    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(JSON.stringify(req) + '\n'));
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      finish(() => {
        try {
          resolve(JSON.parse(line) as PeerResponse<T>);
        } catch {
          reject(new Error('peer 데몬 답이 JSON이 아니에요'));
        }
      });
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
            ? new DaemonUnavailableError(sock)
            : err,
        ),
      );
    });
    socket.once('close', () =>
      finish(() => reject(new Error('peer 데몬이 답 없이 연결을 끊었어요'))),
    );
  });
}
