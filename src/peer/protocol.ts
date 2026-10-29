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
  | { op: 'messages'; watch?: string }
  /** 그 사람을 내 공유에서 끊는다. share가 없으면 열린 공유 전부다 */
  | { op: 'kick'; person: string; share?: string }
  /** 처음 붙으려고 기다리는 사람을 받아 준다 */
  | { op: 'approve'; person: string; share?: string }
  /** 처음 붙으려고 기다리는 사람을 거절한다. 그 공유가 열려 있는 동안 다시 못 붙는다 */
  | { op: 'deny'; person: string; share?: string }
  /** firstWatch가 있으면 바꾸고 지금 설정을 돌려준다 */
  | { op: 'config'; firstWatch?: FirstWatchApproval };

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
  /** 원격으로 보고 있는 사람 이름. 명단에서 온 값이다 */
  watchers: string[];
  /** 주인 승인을 기다리는 사람 */
  pending: PendingWatcher[];
  /** 이 공유에서 끊거나 거절해 다시 못 붙는 사람 */
  blocked: { person: string; reason: BlockReason }[];
}

export interface PendingWatcher {
  person: string;
  /** 처음 청한 시각 */
  at: number;
  /** 이때까지 안 받아 주면 approval_timeout으로 끝난다 */
  expiresAt: number;
}

export type BlockReason = 'kicked' | 'denied';

/** kick, approve, deny의 답 */
export interface ControlResult {
  person: string;
  /** 손댄 공유 id */
  shares: string[];
  /** kick이면 끊은 구독 수, approve와 deny면 처리한 요청 수 */
  count: number;
}

export interface PeerConfig {
  firstWatch: FirstWatchApproval;
  /** 바꿀 때만 있다. ask로 조여 승인을 거두고 끊은 구독 수 */
  revoked?: number;
}

export interface WatchResult {
  id: string;
  share: string;
  owner: string;
  url: string;
  /** 주인 승인을 기다리는 중이면 true. 받아 주면 뷰어에 대화가 보이기 시작한다 */
  waiting?: boolean;
}

export interface WatchListItem {
  id: string;
  share: string;
  owner: string;
  /** live, offline, waiting(주인 승인 기다리는 중) 같은 상태 */
  status: string;
  events: number;
  /** 끝난 보기면 없다 */
  url?: string;
  /** 끝난 보기면 그 이유(kicked, denied, approval_timeout, unshare 등) */
  closed?: string;
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
 * 기본은 ask다. 받아 준 사람은 그 공유가 열려 있는 동안만 기억한다.
 */
export type FirstWatchApproval = 'ask' | 'team';
export const DEFAULT_FIRST_WATCH_APPROVAL: FirstWatchApproval = 'ask';

/** 기본 만료. 설계 원문의 8시간 */
export const DEFAULT_EXPIRES_MINUTES = 8 * 60;

/** 만료 상한. 공유를 사실상 영구로 열어 두지 못하게 한다 */
export const MAX_EXPIRES_MINUTES = 7 * 24 * 60;
