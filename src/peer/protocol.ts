import type { ToolsLevel } from './redact.js';
import type { ShareStatus } from './feed.js';
import type { MemberInfo, TeamStatus } from './network.js';

export type { MemberInfo, TeamStatus };

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
      /** false면 이 공유는 팀원 메시지를 안 받는다. 기본은 받는다 */
      messages?: boolean;
    }
  | { op: 'unshare'; id: string }
  | { op: 'init'; person: string; relay: string }
  | { op: 'invite'; person: string }
  | { op: 'join'; code: string; timeoutMs?: number }
  | { op: 'remove'; person: string }
  | { op: 'members' }
  | { op: 'watch'; link: string }
  | { op: 'watches' }
  | { op: 'unwatch'; id: string }
  /** 보고 있는 원격 공유의 주인 세션에 메시지를 넣는다 */
  | { op: 'send'; watch: string; body: string }
  /** watch가 있으면 그 보기에서 내가 보낸 메시지, 없으면 내 공유가 받은 메시지 기록 */
  | { op: 'messages'; watch?: string };

export type PeerResponse<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

export interface ShareInfo {
  id: string;
  sessionId: string | null;
  transcriptPath: string;
  tools: ToolsLevel;
  /** 팀원 메시지를 받는지 */
  messages: boolean;
  createdAt: number;
  expiresAt: number;
  status: ShareStatus;
  viewers: number;
  events: number;
  unknownLines: number;
  /** 바꾸다 예외가 나서 버린 줄 */
  failedLines: number;
  /** 한 줄 상한을 넘어 버린 줄 */
  oversizedLines: number;
  /** 메모리 상한에 밀려 새 뷰어에게 다시 못 보내는 앞부분 이벤트 */
  droppedEvents: number;
  title?: string;
  url: string;
  /** 팀에 들었으면 팀원에게 건넬 링크. 공유 키가 `#` 뒤에 붙는다 */
  link?: string;
}

export interface WatchResult {
  id: string;
  share: string;
  owner: string;
  url: string;
}

export interface WatchListItem {
  id: string;
  share: string;
  owner: string;
  status: string;
  events: number;
  url: string;
}

export interface DaemonStatus {
  pid: number;
  root: string;
  viewerPort: number;
  startedAt: number;
  shares: number;
  viewers: number;
  /** 기기 id(Ed25519 공개키) */
  machineKey: string;
  team: TeamStatus | null;
}

/** 한 요청 줄의 한도. 소켓은 0600이지만 같은 사용자의 프로세스가 메모리를 못 불리게 둔다 */
export const MAX_REQUEST_BYTES = 64 * 1024;

/**
 * 처음 붙는 팀원을 받는 방식. ask는 주인이 받아 주고 team은 명단에 있으면 바로 받는다.
 * 기본은 ask다. 동작은 PR 4가 붙이고 지금은 명단에 있고 링크를 가진 팀원이면 바로 붙는다.
 */
export type FirstWatchApproval = 'ask' | 'team';
export const DEFAULT_FIRST_WATCH_APPROVAL: FirstWatchApproval = 'ask';

/** 기본 만료. 설계 원문의 8시간 */
export const DEFAULT_EXPIRES_MINUTES = 8 * 60;

/** 만료 상한. 공유를 사실상 영구로 열어 두지 못하게 한다 */
export const MAX_EXPIRES_MINUTES = 7 * 24 * 60;
