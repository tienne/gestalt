import { createHash } from 'node:crypto';
import type {
  ConductorSnapshot,
  Gate,
  SlackDraftReplacement,
  SlackPublicationEvidence,
} from './types.js';

export const SLACK_HOST_HANDOFF = 'host';
export const SLACK_UNVERIFIED_RESPONSE = 'unverified';
export const SUPERSEDED_PREFIX = 'superseded:';
export const SLACK_DELIVERY_EVENT = 'gestalt_conductor_slack_delivery';

export function slackDeliveryId(gate: Gate): string {
  return createHash('sha256')
    .update(JSON.stringify([gate.id, gate.orderId, gate.resolvedAt, gate.payload?.digest]))
    .digest('hex');
}

export function isSlackChannelId(channel: unknown): channel is string {
  return typeof channel === 'string' && /^[CGD][A-Z0-9]+$/.test(channel);
}

export function slackMessageKey(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

function approvalMatches(gate: Gate, evidence: SlackPublicationEvidence): boolean {
  return (
    gate.type === 'slack-post' &&
    gate.status === 'resolved' &&
    gate.decision === 'approved' &&
    isSlackChannelId(evidence.channel) &&
    evidence.channel === gate.payload?.channel &&
    evidence.deliveryId === slackDeliveryId(gate) &&
    evidence.threadTs === gate.payload?.threadTs &&
    typeof evidence.ts === 'string' &&
    /^\d+\.\d{6}$/.test(evidence.ts)
  );
}

export function slackClaimOwner(
  claim: ConductorSnapshot['slackMessageClaims'][string] | undefined,
) {
  return typeof claim === 'string' ? claim : claim?.gateId;
}

function replacementMatches(
  gate: Gate,
  next: Gate | undefined,
  proof: SlackDraftReplacement,
): boolean {
  const previous = gate.payload;
  const replacement = next?.payload;
  return (
    gate.type === 'slack-post' &&
    gate.status === 'resolved' &&
    gate.decision === 'approved' &&
    next?.type === 'slack-post' &&
    next.id === proof.replacementGateId &&
    next.id !== gate.id &&
    next.orderId === gate.orderId &&
    isSlackChannelId(previous?.channel) &&
    previous.channel === replacement?.channel &&
    previous.threadTs === replacement.threadTs &&
    typeof previous.draftFile === 'string' &&
    typeof replacement.draftFile === 'string' &&
    previous.draftFile !== replacement.draftFile &&
    slackDeliveryId(gate) === proof.approvedDeliveryId &&
    typeof previous.digest === 'string' &&
    previous.digest === proof.previousDigest &&
    typeof replacement.digest === 'string' &&
    replacement.digest === proof.replacementDigest &&
    previous.digest !== replacement.digest
  );
}

export function canReplaceSlackDraft(
  state: ConductorSnapshot,
  gate: Gate,
  proof: SlackDraftReplacement,
): boolean {
  const next = state.gates[proof.replacementGateId];
  return (
    !gate.slackReplacement &&
    state.slackPosted[gate.id] === undefined &&
    next?.status === 'open' &&
    replacementMatches(gate, next, proof)
  );
}

export function slackReplacementConfirmed(state: ConductorSnapshot, gate: Gate): boolean {
  const proof = gate.slackReplacement;
  return (
    proof !== undefined && replacementMatches(gate, state.gates[proof.replacementGateId], proof)
  );
}

export function slackPublicationMatches(
  state: ConductorSnapshot,
  gate: Gate,
  evidence: SlackPublicationEvidence,
): boolean {
  if (!approvalMatches(gate, evidence)) return false;
  const ref = state.slackPosted[gate.id];
  if (
    ref === undefined ||
    slackReplacementConfirmed(state, gate) ||
    slackPublicationConfirmed(state, gate)
  )
    return false;
  const claim = state.slackMessageClaims[slackMessageKey(evidence.channel, evidence.ts)];
  return claim === undefined || claim === gate.id;
}

export function slackPublicationConfirmed(state: ConductorSnapshot, gate: Gate): boolean {
  const ref = state.slackPosted[gate.id];
  const channel = gate.payload?.channel;
  if (!ref || !isSlackChannelId(channel)) return false;
  const claim = state.slackMessageClaims[slackMessageKey(channel, ref)];
  return (
    !!claim &&
    typeof claim !== 'string' &&
    claim.gateId === gate.id &&
    claim.ts === ref &&
    approvalMatches(gate, claim)
  );
}

export function approvedSlackUnrecorded(state: ConductorSnapshot, gate: Gate): boolean {
  return (
    gate.type === 'slack-post' &&
    gate.decision === 'approved' &&
    state.slackPosted[gate.id] === undefined &&
    !slackReplacementConfirmed(state, gate)
  );
}

export function slackPublicationBlocker(state: ConductorSnapshot, gate: Gate): string | undefined {
  if (gate.type !== 'slack-post' || gate.decision !== 'approved') return;
  if (slackReplacementConfirmed(state, gate) || slackPublicationConfirmed(state, gate)) return;
  const ref = state.slackPosted[gate.id];
  if (ref === undefined) return 'Slack 게시 결과를 기다리고 있어요';
  if (ref === SLACK_HOST_HANDOFF) return '호스트에 넘긴 Slack 게시의 증빙을 기다리고 있어요';
  if (ref === SLACK_UNVERIFIED_RESPONSE) return '직접 게시 응답에서 승인 범위를 확인하지 못했어요';
  if (ref.startsWith(SUPERSEDED_PREFIX))
    return '이전 Slack 기록에서 초안 교체 증빙을 확인하지 못했어요';
  return '이전 Slack 게시 기록에 채널, 스레드와 작업 증빙이 없어요';
}

export function slackAwaitingPublication(state: ConductorSnapshot, gate: Gate): boolean {
  return slackPublicationBlocker(state, gate) !== undefined;
}

export function orderSlackBlocker(state: ConductorSnapshot, orderId: string): string | undefined {
  for (const gate of Object.values(state.gates)) {
    if (gate.orderId !== orderId || gate.type !== 'slack-post') continue;
    if (gate.status === 'open') return 'Slack 초안 승인을 기다리고 있어요';
    const reason = slackPublicationBlocker(state, gate);
    if (reason) return reason;
  }
}

export function orderHasPendingSlack(state: ConductorSnapshot, orderId: string): boolean {
  return orderSlackBlocker(state, orderId) !== undefined;
}
