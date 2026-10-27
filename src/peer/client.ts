import { createConnection } from 'node:net';
import type { PeerRequest, PeerResponse } from './protocol.js';

export const DAEMON_NOT_RUNNING = '`gestalt peer daemon`을 먼저 실행해 주세요';

export class DaemonUnavailableError extends Error {
  constructor(readonly socketPath: string) {
    super(`peer 데몬에 연결하지 못했어요 (${socketPath}). ${DAEMON_NOT_RUNNING}`);
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
      finish(() => reject(new Error('peer 데몬이 답 없이 연결을 닫았어요'))),
    );
  });
}
