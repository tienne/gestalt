import type { SignedRoster } from './roster.js';
import { canonical } from './seal.js';

/**
 * 데몬과 릴레이 사이 프레임. 한 WebSocket 글자 메시지가 JSON 하나다.
 *
 * 릴레이가 보는 건 보낸 기기, 받는 기기, 공유 id, 크기, 시각이다. `data`는 데몬끼리
 * 봉인한 바이트를 base64url로 쓴 것이라 릴레이는 못 연다.
 */

export type HelloMode = 'member' | 'join';

export type ClientFrame =
  | { t: 'hello'; team: string; key: string; mode: HelloMode; sig: string; roster?: SignedRoster }
  /** ack가 false면 릴레이가 답을 안 보낸다. 공유 스트림 프레임처럼 자주 가는 것에 쓴다 */
  | { t: 'send'; id: number; to: string; data: string; ack?: false }
  | { t: 'resolve'; id: number; share: string }
  /** 이 기기가 지금 연 공유 id 전부. 받을 때마다 통째로 바꾼다 */
  | { t: 'announce'; shares: string[] }
  | { t: 'roster'; roster: SignedRoster }
  /** join 모드 전용. 초대한 관리자에게 봉인한 요청 */
  | { t: 'join'; to: string; data: string };

export type ServerFrame =
  | { t: 'challenge'; nonce: string }
  | { t: 'welcome'; roster: SignedRoster; online: string[] }
  /** join 모드로 붙어 명단에 오르기를 기다리는 중 */
  | { t: 'pending' }
  | { t: 'error'; code: RelayErrorCode; message: string }
  | { t: 'recv'; from: string; data: string }
  | { t: 'ack'; id: number; ok: boolean; error?: string }
  | { t: 'resolved'; id: number; owner: string | null }
  | { t: 'roster'; roster: SignedRoster }
  | { t: 'presence'; key: string; online: boolean }
  | { t: 'join'; from: string; data: string };

export type RelayErrorCode =
  | 'bad_frame'
  | 'bad_signature'
  | 'wrong_team'
  | 'not_member'
  | 'no_roster'
  | 'rate_limited';

/** 명단에서 빠진 기기를 끊을 때 쓰는 WebSocket close 코드 */
export const CLOSE_REMOVED = 4003;
/** 핸드셰이크 실패 */
export const CLOSE_REJECTED = 4001;

/** hello에 서명할 글자. 릴레이가 준 nonce를 넣어 다른 접속의 서명을 다시 못 쓰게 한다 */
export function helloSigned(team: string, nonce: string, mode: HelloMode): string {
  return `gestalt-peer-relay-hello-v1\n${canonical({ team, nonce, mode })}`;
}
