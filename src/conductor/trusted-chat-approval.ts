import { createHash } from 'node:crypto';
import { isPlainObject } from '../core/json-file.js';
import type { BotOwner } from './bot-owner.js';
import { InputError } from './input-error.js';
import type { ChatApprovalOffer, Gate } from './types.js';

export type MergeApprovalPolicy = 'signed' | 'trusted-chat';

/** 신뢰 채팅은 레포별 명시 설정만 허용한다. 알 수 없는 값은 서명 정책으로 숨기지 않는다. */
export function mergeApprovalPolicy(
  policy: Record<string, unknown> | undefined,
  repo: string,
): MergeApprovalPolicy {
  const table = policy?.['mergeApprovalPolicy'];
  if (table === undefined) return 'signed';
  if (
    !isPlainObject(table) ||
    Object.entries(table).some(
      ([key, value]) =>
        !/^[\w.-]+\/[\w.-]+$/.test(key) ||
        key !== key.toLowerCase() ||
        (value !== 'signed' && value !== 'trusted-chat'),
    )
  )
    throw new InputError(
      'mergeApprovalPolicy는 소문자 레포별 signed 또는 trusted-chat 설정이어야 해요',
    );
  return Object.hasOwn(table, repo.toLowerCase())
    ? (table[repo.toLowerCase()] as MergeApprovalPolicy)
    : 'signed';
}

export const TRUSTED_CHAT_OFF = '이 레포는 운영 채팅 문구를 신뢰하는 승인을 켜지 않았어요';

export function requireTrustedChat(policy: Record<string, unknown> | undefined, repo: string) {
  if (mergeApprovalPolicy(policy, repo) !== 'trusted-chat') throw new InputError(TRUSTED_CHAT_OFF);
}

/** 인용이나 본문에서 명령을 추출하지 않고 전체 메시지가 합의한 한 줄인지 확인한다. */
export function chatApprovalId(message: string): string {
  const match = /^([A-Za-z0-9_-]+) 승인해줘$/.exec(message);
  if (!match) throw new InputError('승인 요청은 <ID> 승인해줘 한 줄이어야 해요');
  return match[1]!;
}

export function chatApprovalCandidates(
  gates: Iterable<Gate>,
  id: string,
  owner: Pick<BotOwner, 'botId' | 'chatId'>,
): Gate[] {
  return [...gates].filter((gate) => {
    if (gate.type !== 'merge') return false;
    const offer = gate.chatApprovalOffer;
    return (
      gate.id === id ||
      gate.orderId === id ||
      (offer?.botId === owner.botId &&
        offer.chatId === owner.chatId &&
        offer.item !== undefined &&
        String(offer.item.number) === id)
    );
  });
}

/** 채팅 승인 후보가 바로 승인되지 않는 이유. 판정 순서대로 적었다 */
export type ChatOfferReason =
  | 'closed'
  | 'unavailable'
  | 'policy-off'
  | 'no-offer'
  | 'other-chat'
  | 'stale';

/** 안내로 승인할 수 없으면 이유와 문구를 돌려준다. 승인할 수 있으면 undefined다 */
export function chatOfferProblem(
  offer: ChatApprovalOffer | undefined,
  owner: BotOwner,
  target: string,
): { reason: ChatOfferReason; message: string } | undefined {
  if (!offer)
    return {
      reason: 'no-offer',
      message: '먼저 chat-offer로 PR과 HEAD를 안내한 뒤 승인을 받아 주세요',
    };
  if (offer.botId !== owner.botId || offer.chatId !== owner.chatId)
    return {
      reason: 'other-chat',
      message:
        '다른 운영 채팅에서 안내한 승인이에요. 변경을 확인하고 chat-offer --refresh로 현재 채팅에서 다시 안내해 주세요',
    };
  if (offer.target !== target)
    return {
      reason: 'stale',
      message: '안내한 게이트나 PR, 워커가 바뀌었어요. 다시 안내한 뒤 승인받아 주세요',
    };
  return undefined;
}

export function verifyChatOffer(
  offer: ChatApprovalOffer | undefined,
  owner: BotOwner,
  target: string,
): ChatApprovalOffer {
  const problem = chatOfferProblem(offer, owner, target);
  if (problem) throw new InputError(problem.message);
  return offer!;
}

export function chatDecisionId(offer: ChatApprovalOffer): string {
  return createHash('sha256')
    .update(
      JSON.stringify(['gestalt/trusted-chat/v1', offer.id, offer.botId, offer.chatId, 'approved']),
    )
    .digest('hex');
}
