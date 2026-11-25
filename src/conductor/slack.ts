import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isPlainObject } from '../core/json-file.js';
import {
  approvedSlackUnrecorded,
  canReplaceSlackDraft,
  isSlackChannelId,
  openSlackReplacementCandidates,
  SLACK_AMBIGUOUS_REPLACEMENT,
  SLACK_DELIVERY_EVENT,
  SLACK_HOST_HANDOFF,
  SLACK_UNVERIFIED_RESPONSE,
  SUPERSEDED_PREFIX,
  slackClaimOwner,
  slackDeliveryId,
  slackMessageKey,
  slackPublicationBlocker,
  slackPublicationConfirmed,
  slackPublicationMatches,
} from './slack-state.js';
import { newId, type ConductorStore } from './store.js';
import type { Gate, SlackPublicationEvidence } from './types.js';

export interface SlackDelivery {
  gateId: string;
  deliveryId: string;
  orderId?: string;
  metadata: { event_type: typeof SLACK_DELIVERY_EVENT; event_payload: { delivery_id: string } };
}

/** 슬랙에 실제로 쓰는 어댑터. 컨덕터는 승인된 초안만 이걸로 보낸다 */
export interface SlackClient {
  /** 직접 게시했으면 Slack 원본 응답을 돌려준다. 호스트가 맡으면 기록 뒤 호출할 enqueue를 돌려준다 */
  post(
    message: { channel: string; text: string; threadTs?: string },
    delivery: SlackDelivery,
  ): Promise<unknown>;
}

export interface SlackDraftInput {
  orderId?: string;
  channel: string;
  text: string;
  threadTs?: string;
}

/**
 * 슬랙 초안을 파일로 남기고 slack-post 게이트를 연다.
 *
 * 본문은 게이트에 싣지 않고 파일 경로만 둔다. 컨덕터가 게이트 목록을 볼 때 초안 본문이 대화로 딸려 오지 않게 하려는 것이다.
 * 같은 채널에 같은 본문을 다시 맡기면 열린 게이트를 다시 쓴다.
 * 주문 상태는 바꾸지 않는다. 슬랙 게시를 기다리느라 워커가 멈출 이유가 없어서다.
 */
export function draftSlack(
  store: ConductorStore,
  input: SlackDraftInput,
  draftDir: string,
): { gate: Gate; reused: boolean } {
  const digest = draftDigest(input.channel, input.threadTs, input.text);
  const existing = store
    .openGates()
    .find(
      (g) => g.type === 'slack-post' && g.orderId === input.orderId && g.payload?.digest === digest,
    );
  if (existing) return { gate: existing, reused: true };

  const id = newId('gate');
  mkdirSync(draftDir, { recursive: true });
  const draftFile = join(draftDir, `${id}.md`);
  writeFileSync(draftFile, input.text);
  const gate: Gate = {
    id,
    ...(input.orderId ? { orderId: input.orderId } : {}),
    type: 'slack-post',
    status: 'open',
    reason: `슬랙 게시 승인: ${input.channel}`,
    refs: [draftFile],
    payload: {
      channel: input.channel,
      draftFile,
      digest,
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
    },
    openedAt: store.timestamp(),
  };
  store.openGate(gate);
  return { gate, reused: false };
}

function draftDigest(channel: string, threadTs: string | undefined, text: string): string {
  return createHash('sha256')
    .update(`${channel}\n${threadTs ?? ''}\n${text}`)
    .digest('hex')
    .slice(0, 16);
}

export { SUPERSEDED_PREFIX };

function slackDelivery(gate: Gate): SlackDelivery {
  const deliveryId = slackDeliveryId(gate);
  return {
    gateId: gate.id,
    deliveryId,
    ...(gate.orderId ? { orderId: gate.orderId } : {}),
    metadata: { event_type: SLACK_DELIVERY_EVENT, event_payload: { delivery_id: deliveryId } },
  };
}

function approvedSlackGate(store: ConductorStore, gateId: string): Gate {
  const gate = store.snapshot.gates[gateId];
  if (gate?.type !== 'slack-post' || gate.status !== 'resolved' || gate.decision !== 'approved')
    throw new Error('현재 승인된 Slack 게시 게이트가 아니에요');
  return gate;
}

export function pendingSlackDelivery(store: ConductorStore, gateId: string) {
  const gate = approvedSlackGate(store, gateId);
  const pendingReason = slackPublicationBlocker(store.snapshot, gate);
  if (!pendingReason || store.snapshot.slackPosted[gateId] === undefined)
    throw new Error('게시 결과를 기다리는 Slack 게이트가 아니에요');
  const { channel, draftFile, threadTs, digest } = gate.payload ?? {};
  if (!isSlackChannelId(channel) || !draftFile)
    throw new Error('승인한 Slack 채널 ID나 초안이 없어요');
  const text = readFileSync(draftFile, 'utf-8');
  if (draftDigest(channel, threadTs, text) !== digest)
    throw new Error('승인한 Slack 초안과 현재 본문이 달라요');
  return {
    ...slackDelivery(gate),
    channel,
    text,
    pendingReason,
    ...(threadTs ? { threadTs } : {}),
  };
}

function parseSlackPublication(result: unknown): SlackPublicationEvidence {
  if (
    !isPlainObject(result) ||
    result.ok !== true ||
    !isSlackChannelId(result.channel) ||
    typeof result.ts !== 'string' ||
    !/^\d+\.\d{6}$/.test(result.ts) ||
    !isPlainObject(result.message) ||
    result.message.ts !== result.ts ||
    (result.message.thread_ts !== undefined && typeof result.message.thread_ts !== 'string') ||
    !isPlainObject(result.message.metadata) ||
    result.message.metadata.event_type !== SLACK_DELIVERY_EVENT ||
    !isPlainObject(result.message.metadata.event_payload) ||
    typeof result.message.metadata.event_payload.delivery_id !== 'string'
  )
    throw new Error('채널과 게시 작업 메타데이터가 들어 있는 Slack 성공 응답을 주세요');
  return {
    channel: result.channel,
    ts: result.ts,
    deliveryId: result.message.metadata.event_payload.delivery_id,
    ...(result.message.thread_ts !== undefined ? { threadTs: result.message.thread_ts } : {}),
  };
}

export function confirmSlackDelivery(
  store: ConductorStore,
  gateId: string,
  result: unknown,
): { recorded: boolean; ref: string } {
  const evidence = parseSlackPublication(result);
  const key = slackMessageKey(evidence.channel, evidence.ts);
  const recorded = store.appendIfCurrent(
    { type: 'slack-publication-confirmed', at: store.timestamp(), gateId, evidence },
    () => {
      const gate = approvedSlackGate(store, gateId);
      if (
        evidence.channel !== gate.payload?.channel ||
        evidence.threadTs !== gate.payload?.threadTs
      )
        throw new Error('Slack 응답의 채널이나 스레드가 승인 대상과 달라요');
      if (evidence.deliveryId !== slackDeliveryId(gate))
        throw new Error('Slack 응답의 게시 작업 식별자가 달라요');
      const claimed = store.snapshot.slackMessageClaims[key];
      if (
        slackClaimOwner(claimed) === gateId &&
        store.snapshot.slackPosted[gateId] === evidence.ts &&
        slackPublicationConfirmed(store.snapshot, gate)
      )
        return false;
      if (claimed !== undefined && slackClaimOwner(claimed) !== gateId)
        throw new Error('이미 다른 Slack 게시 작업에 연결된 메시지예요');
      if (!slackPublicationMatches(store.snapshot, gate, evidence))
        throw new Error('확인을 기다리는 Slack 게시에만 결과를 남길 수 있어요');
      return true;
    },
  );
  return { recorded, ref: evidence.ts };
}

export interface PublishResult {
  posted: { gateId: string; ref: string }[];
  failed: { gateId: string; error: string }[];
  /** 승인 뒤 초안이 바뀌어 다시 승인을 받으려고 연 게이트 */
  reopened: { gateId: string; newGateId: string }[];
}

function holdAmbiguousReplacement(store: ConductorStore, gate: Gate): never {
  store.appendIfCurrent(
    {
      type: 'slack-posted',
      at: store.timestamp(),
      gateId: gate.id,
      ref: SLACK_AMBIGUOUS_REPLACEMENT,
    },
    () => {
      const current = store.snapshot.gates[gate.id];
      return (
        current !== undefined &&
        approvedSlackUnrecorded(store.snapshot, current) &&
        slackDeliveryId(current) === slackDeliveryId(gate)
      );
    },
  );
  throw new Error('Slack 초안 교체 후보가 여러 개예요');
}

/**
 * 승인된 슬랙 초안을 한 번씩만 게시한다.
 *
 * 게시했는지는 slack-posted 이벤트로 남기고 다음 tick에는 건너뛴다. 거절된 초안은 게시하지 않는다.
 * 초안 파일은 워커도 쓸 수 있는 자리라 승인 때의 digest와 다르면 보내지 않는다. 바뀐 본문으로
 * 새 게이트를 열고 두 초안의 교체 관계를 남겨 다음 tick이 앞 게이트를 다시 집지 않게 한다.
 */
export async function publishApprovedSlack(
  store: ConductorStore,
  client: SlackClient,
  readDraft: (file: string) => string = (f) => readFileSync(f, 'utf-8'),
): Promise<PublishResult> {
  const result: PublishResult = { posted: [], failed: [], reopened: [] };
  const pending = Object.values(store.snapshot.gates).filter(
    (g) => g.status === 'resolved' && approvedSlackUnrecorded(store.snapshot, g),
  );
  for (const gate of pending) {
    const channel = gate.payload?.channel;
    const draftFile = gate.payload?.draftFile;
    if (!isSlackChannelId(channel) || !draftFile) {
      result.failed.push({ gateId: gate.id, error: '게이트에 Slack 채널 ID나 초안 경로가 없어요' });
      continue;
    }
    try {
      const threadTs = gate.payload?.threadTs;
      const text = readDraft(draftFile);
      const previousDigest = gate.payload?.digest;
      if (!previousDigest) throw new Error('승인한 Slack 초안의 해시가 없어요');
      const replacementDigest = draftDigest(channel, threadTs, text);
      if (replacementDigest !== previousDigest) {
        const candidates = openSlackReplacementCandidates(store.snapshot, gate, replacementDigest);
        if (candidates.length > 1) holdAmbiguousReplacement(store, gate);
        const next =
          candidates[0] ??
          draftSlack(
            store,
            {
              channel,
              text,
              ...(gate.orderId ? { orderId: gate.orderId } : {}),
              ...(threadTs ? { threadTs } : {}),
            },
            dirname(draftFile),
          ).gate;
        const replacement = {
          replacementGateId: next.id,
          approvedDeliveryId: slackDeliveryId(gate),
          previousDigest,
          replacementDigest,
        };
        const recorded = store.appendIfCurrent(
          { type: 'slack-draft-replaced', at: store.timestamp(), gateId: gate.id, replacement },
          () => {
            const current = store.snapshot.gates[gate.id];
            return (
              current !== undefined && canReplaceSlackDraft(store.snapshot, current, replacement)
            );
          },
        );
        if (!recorded) {
          const current = store.snapshot.gates[gate.id];
          if (
            current &&
            openSlackReplacementCandidates(store.snapshot, current, replacementDigest).length > 1
          )
            holdAmbiguousReplacement(store, gate);
          throw new Error('Slack 초안을 교체하는 사이 게이트가 바뀌었어요');
        }
        result.reopened.push({ gateId: gate.id, newGateId: next.id });
        result.failed.push({
          gateId: gate.id,
          error: `승인 뒤 초안이 바뀌어 보내지 않았어요. 새 확인 자리 ${next.id}를 열었어요`,
        });
        continue;
      }
      const posted = await client.post(
        { channel, text, ...(threadTs ? { threadTs } : {}) },
        slackDelivery(gate),
      );
      if (isPlainObject(posted) && typeof posted.enqueue === 'function') {
        store.append({
          type: 'slack-posted',
          at: store.timestamp(),
          gateId: gate.id,
          ref: SLACK_HOST_HANDOFF,
        });
        posted.enqueue();
      } else {
        // 응답을 검증하기 전에 대기를 남겨야 잘못된 응답이나 중단 뒤 다시 보내지 않는다.
        store.append({
          type: 'slack-posted',
          at: store.timestamp(),
          gateId: gate.id,
          ref: SLACK_UNVERIFIED_RESPONSE,
        });
        const confirmed = confirmSlackDelivery(store, gate.id, posted);
        if (confirmed.recorded) result.posted.push({ gateId: gate.id, ref: confirmed.ref });
      }
    } catch (err) {
      result.failed.push({
        gateId: gate.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
