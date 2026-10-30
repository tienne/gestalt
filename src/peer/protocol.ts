import type { ToolsLevel } from './redact.js';
import type { ShareStatus } from './feed.js';
import type { MemberInfo, TeamStatus } from './network.js';
import type { AskResult } from './questions.js';
import type { MessageStatus } from './message.js';
import type { TranscriptFormat } from './share.js';

export type { AskResult, MemberInfo, TeamStatus, TranscriptFormat };

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
      /** 대화 기록 형식. 기본 claude. codex면 메시지를 안 받고 sessionId를 받지 않는다 */
      format?: TranscriptFormat;
      /** true면 보는 쪽 에이전트가 ges_peer peek으로 요약을 가져갈 수 있다. 기본은 꺼짐 */
      agentPeek?: boolean;
    }
  | { op: 'unshare'; id: string }
  | { op: 'init'; person: string; relay: string }
  | { op: 'invite'; person: string }
  | { op: 'join'; code: string; timeoutMs?: number }
  | { op: 'remove'; person: string }
  | { op: 'members' }
  /** configDir은 명령을 친 쪽의 Claude Code 설정 디렉토리. 발췌를 넣을 내 세션 목록을 거기서도 찾는다 */
  | { op: 'watch'; link: string; configDir?: string }
  | { op: 'watches' }
  | { op: 'unwatch'; id: string }
  /**
   * 보고 있는 원격 공유의 주인 세션에 메시지를 넣는다. origin이 정확히 agent면 에이전트 메시지로 보내고
   * 에이전트 상한을 탄다. 그 밖의 값은 사람 메시지다
   */
  | { op: 'send'; watch: string; body: string; origin?: 'agent' }
  /** watch가 있으면 그 보기에서 내가 보낸 메시지, 없으면 내 공유가 받은 메시지 기록 */
  | { op: 'messages'; watch?: string }
  /**
   * 그 사람을 내 공유에서 끊는다. share나 shares(한 세션으로 연 공유 여럿)가 없으면 열린 공유 전부다.
   * approve와 deny도 같다
   */
  | { op: 'kick'; person: string; share?: string; shares?: string[] }
  /** 처음 붙으려고 기다리는 사람을 받아 준다 */
  | { op: 'approve'; person: string; share?: string; shares?: string[] }
  /** 처음 붙으려고 기다리는 사람을 거절한다. 그 공유가 열려 있는 동안 다시 못 붙는다 */
  | { op: 'deny'; person: string; share?: string; shares?: string[] }
  /** firstWatch가 있으면 바꾸고 지금 설정을 돌려준다 */
  | { op: 'config'; firstWatch?: FirstWatchApproval }
  /**
   * 주인 세션 모델의 질문을 그 세션 공유를 보는 팀원에게 보낸다(ges_peer ask_user). to를 주면 그 사람만.
   * 답은 나중에 그 세션 인박스로 들어온다
   */
  | { op: 'ask'; sessionId: string; question: string; to?: string; timeoutSecs?: number }
  /**
   * 보고 있는 원격 공유의 요약을 주인 데몬에 청한다(ges_peer peek). share는 주인 쪽 공유 id이고 보기
   * id도 받는다. since는 앞 요약의 cursor다
   */
  | { op: 'peek'; share: string; since?: string }
  /**
   * 보는 쪽 에이전트가 보고 있는 원격 공유의 주인 세션에 `origin="agent"` 메시지를 넣는다(ges_peer
   * send). share는 주인 쪽 공유 id이고 보기 id도 받는다
   */
  | { op: 'agent_send'; share: string; body: string };

export type PeerResponse<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

export interface ShareInfo {
  id: string;
  sessionId: string | null;
  transcriptPath: string;
  tools: ToolsLevel;
  /** 대화 기록 형식 */
  format: TranscriptFormat;
  /** 팀원 메시지를 받는지 */
  messages: boolean;
  /** 보는 쪽 에이전트가 요약(peek)을 가져갈 수 있는지. `--agent-peek`으로 연 공유만 true */
  agentPeek: boolean;
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
  /** 최근 요약을 가져간 사람. 주인 세션에 알리는 시간(10분)이 지나면 빠진다 */
  peeks: PeekNotice[];
}

/** 요약을 가져간 사람 한 명. 이름은 명단에서 온 값을 한 줄 라벨로 정리한 것이다 */
export interface PeekNotice {
  person: string;
  /** 마지막으로 가져간 시각 */
  at: number;
}

/** ges_peer send의 답 */
export interface AgentSendResult {
  /** 메시지 id */
  id: string;
  status: MessageStatus;
  /** 주인 쪽 공유 id */
  share: string;
  /** 공유 주인 이름. 명단에서 온 값이다 */
  owner: string;
  /** 주인이 요약을 허락했는지. 이전 버전 주인 데몬이면 없다 */
  agentPeek?: boolean;
}

/** ges_peer peek의 답. text는 보는 쪽 에이전트에 그대로 넘기는 틀로 감싼 글자다 */
export interface PeekResult {
  share: string;
  owner: string;
  cursor: string;
  text: string;
}

export interface PendingWatcher {
  person: string;
  /** 처음 청한 시각 */
  at: number;
  /** 이때까지 안 받아 주면 approval_timeout으로 끝난다 */
  expiresAt: number;
  /** 훅이 긴 안내를 한동안 붙였으면 true. 그 뒤로는 짧은 한 줄만 붙인다 */
  brief?: boolean;
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
  /** 주인이 메시지를 받는지. 끝난 보기면 없다 */
  messages?: boolean;
  /** 주인이 요약을 허락했는지. 끝난 보기나 이전 버전 주인 데몬이면 없다 */
  agentPeek?: boolean;
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
