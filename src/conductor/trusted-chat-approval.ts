import { createHash } from 'node:crypto';
import { isPlainObject } from '../core/json-file.js';
import type { BotOwner } from './bot-owner.js';
import { InputError } from './input-error.js';
import type { ChatApprovalOffer, Gate, GateType } from './types.js';

/** 봇 채팅에서 닫을 수 있는 게이트. 머지 외에는 워커를 멈춰 세우는 확인 자리만 넣었다 */
export const BOT_GATE_TYPES: readonly GateType[] = [
  'merge',
  'file-overlap',
  'review-manual-switch',
];

export type ApprovalPolicy = 'signed' | 'trusted-chat';

const REPO_KEY = /^[\w.-]+\/[\w.-]+$/;
const isMode = (value: unknown): value is ApprovalPolicy =>
  value === 'signed' || value === 'trusted-chat';

function repoTable(policy: Record<string, unknown> | undefined, field: string) {
  const table = policy?.[field];
  if (table === undefined) return undefined;
  if (
    !isPlainObject(table) ||
    Object.entries(table).some(
      ([key, value]) => !REPO_KEY.test(key) || key !== key.toLowerCase() || !isMode(value),
    )
  )
    throw new InputError(`${field}는 소문자 레포별 signed 또는 trusted-chat 설정이어야 해요`);
  return table as Record<string, ApprovalPolicy>;
}

/** 정책 파일이 기본값을 안 정하면 채팅 승인이다. 서명은 레포나 기본값에서 signed를 골라야 쓴다 */
export function defaultApprovalPolicy(policy: Record<string, unknown> | undefined): ApprovalPolicy {
  const value = policy?.['defaultApprovalPolicy'];
  if (value === undefined) return 'trusted-chat';
  if (!isMode(value))
    throw new InputError('defaultApprovalPolicy는 signed 또는 trusted-chat이어야 해요');
  return value;
}

/**
 * 봇이 닫는 게이트를 레포에서 어떻게 승인할지 정한 정책. approvalPolicy, 예전 칸인 mergeApprovalPolicy, defaultApprovalPolicy 순서로 본다.
 * 알 수 없는 값은 어느 정책으로도 숨기지 않고 오류로 낸다.
 */
export function approvalPolicy(
  policy: Record<string, unknown> | undefined,
  repo: string,
): ApprovalPolicy {
  const key = repo.toLowerCase();
  const tables = [repoTable(policy, 'approvalPolicy'), repoTable(policy, 'mergeApprovalPolicy')];
  const fallback = defaultApprovalPolicy(policy);
  for (const table of tables) if (table && Object.hasOwn(table, key)) return table[key]!;
  return fallback;
}

export const TRUSTED_CHAT_OFF =
  '이 레포는 운영 채팅 문구 승인 대신 서명 승인을 쓰도록 설정돼 있어요';

export function requireTrustedChat(policy: Record<string, unknown> | undefined, repo: string) {
  if (approvalPolicy(policy, repo) !== 'trusted-chat') throw new InputError(TRUSTED_CHAT_OFF);
}

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
    if (!BOT_GATE_TYPES.includes(gate.type)) return false;
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
      message: '먼저 chat-offer로 승인 대상을 안내한 뒤 승인을 받아 주세요',
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
      message:
        '안내한 게이트나 PR, 워커가 바뀌었어요. 변경을 확인하고 chat-offer --refresh로 다시 안내해 주세요',
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
