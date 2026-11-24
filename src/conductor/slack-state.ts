import type { ConductorSnapshot, Gate } from './types.js';

export const SLACK_HOST_HANDOFF = 'host';

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
