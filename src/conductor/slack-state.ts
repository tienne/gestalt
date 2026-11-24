import { createHash } from 'node:crypto';
import type { ConductorSnapshot, Gate, SlackPublicationEvidence } from './types.js';

export const SLACK_HOST_HANDOFF = 'host';
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

export function slackPublicationMatches(
  state: ConductorSnapshot,
  gate: Gate,
  evidence: SlackPublicationEvidence,
): boolean {
  return (
    gate.type === 'slack-post' &&
    gate.status === 'resolved' &&
    gate.decision === 'approved' &&
    state.slackPosted[gate.id] === SLACK_HOST_HANDOFF &&
    isSlackChannelId(evidence.channel) &&
    evidence.channel === gate.payload?.channel &&
    evidence.deliveryId === slackDeliveryId(gate) &&
    evidence.threadTs === gate.payload?.threadTs &&
    typeof evidence.ts === 'string' &&
    /^\d+\.\d{6}$/.test(evidence.ts) &&
    !Object.hasOwn(state.slackMessageClaims, slackMessageKey(evidence.channel, evidence.ts))
  );
}

export function approvedSlackUnrecorded(
  state: Pick<ConductorSnapshot, 'slackPosted'>,
  gate: Gate,
): boolean {
  return (
    gate.type === 'slack-post' &&
    gate.decision === 'approved' &&
    state.slackPosted[gate.id] === undefined
  );
}

export function slackAwaitingPublication(
  state: Pick<ConductorSnapshot, 'slackPosted'>,
  gate: Gate,
): boolean {
  return (
    approvedSlackUnrecorded(state, gate) ||
    (gate.type === 'slack-post' &&
      gate.decision === 'approved' &&
      state.slackPosted[gate.id] === SLACK_HOST_HANDOFF)
  );
}

export function orderHasPendingSlack(state: ConductorSnapshot, orderId: string): boolean {
  return Object.values(state.gates).some(
    (gate) =>
      gate.orderId === orderId &&
      gate.type === 'slack-post' &&
      (gate.status === 'open' || slackAwaitingPublication(state, gate)),
  );
}
