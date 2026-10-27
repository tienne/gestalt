import type { ToolsLevel } from './redact.js';
import type { ShareStatus } from './share.js';

/** IPC 한 줄 요청. 줄 단위 JSON이다 */
export type PeerRequest =
  | { op: 'ping' }
  | { op: 'status' }
  | { op: 'shares' }
  | {
      op: 'share';
      transcriptPath: string;
      sessionId?: string;
      tools?: ToolsLevel;
      expiresMinutes?: number;
    }
  | { op: 'unshare'; id: string };

export type PeerResponse<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

export interface ShareInfo {
  id: string;
  sessionId: string | null;
  transcriptPath: string;
  tools: ToolsLevel;
  createdAt: number;
  expiresAt: number;
  status: ShareStatus;
  viewers: number;
  events: number;
  unknownLines: number;
  title?: string;
  url: string;
}

export interface DaemonStatus {
  pid: number;
  root: string;
  viewerPort: number;
  startedAt: number;
  shares: number;
  viewers: number;
}

/** 한 요청 줄의 한도. 소켓은 0600이지만 같은 사용자의 프로세스가 메모리를 못 불리게 둔다 */
export const MAX_REQUEST_BYTES = 64 * 1024;

/** 기본 만료. 설계 원문의 8시간 */
export const DEFAULT_EXPIRES_MINUTES = 8 * 60;

/** 만료 상한. 공유를 사실상 영구로 열어 두지 못하게 한다 */
export const MAX_EXPIRES_MINUTES = 7 * 24 * 60;
