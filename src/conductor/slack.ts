import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvedSlackUnrecorded, SLACK_HOST_HANDOFF } from './slack-state.js';
import { newId, type ConductorStore } from './store.js';
import type { Gate } from './types.js';

export interface SlackDelivery {
  gateId: string;
  deliveryId: string;
  orderId?: string;
}

interface SlackHandoff {
  enqueue(): void;
}

/** 슬랙에 실제로 쓰는 어댑터. 컨덕터는 승인된 초안만 이걸로 보낸다 */
export interface SlackClient {
  /** 직접 게시했으면 참조를, 호스트가 맡으면 기록 뒤에 호출할 인계 함수를 돌려준다 */
  post(
    message: { channel: string; text: string; threadTs?: string },
    delivery: SlackDelivery,
  ): Promise<string | SlackHandoff>;
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

/** slackPosted에 남기는 표식. 승인 뒤 초안이 바뀌어 새 게이트로 넘겼다는 뜻이다 */
export const SUPERSEDED_PREFIX = 'superseded:';

function slackDelivery(gate: Gate): SlackDelivery {
  const deliveryId = createHash('sha256')
    .update(JSON.stringify([gate.id, gate.orderId, gate.resolvedAt, gate.payload?.digest]))
    .digest('hex');
  return { gateId: gate.id, deliveryId, ...(gate.orderId ? { orderId: gate.orderId } : {}) };
}

function approvedSlackGate(store: ConductorStore, gateId: string): Gate {
  const gate = store.snapshot.gates[gateId];
  if (gate?.type !== 'slack-post' || gate.status !== 'resolved' || gate.decision !== 'approved')
    throw new Error('현재 승인된 Slack 게시 게이트가 아니에요');
  return gate;
}

export function pendingSlackDelivery(store: ConductorStore, gateId: string) {
  const gate = approvedSlackGate(store, gateId);
  if (store.snapshot.slackPosted[gateId] !== SLACK_HOST_HANDOFF)
    throw new Error('게시 결과를 기다리는 Slack 게이트가 아니에요');
  const { channel, draftFile, threadTs, digest } = gate.payload ?? {};
  if (!channel || !draftFile) throw new Error('승인한 게시 대상이나 초안이 없어요');
  const text = readFileSync(draftFile, 'utf-8');
  if (draftDigest(channel, threadTs, text) !== digest)
    throw new Error('승인한 Slack 초안과 현재 본문이 달라요');
  return { ...slackDelivery(gate), channel, text, ...(threadTs ? { threadTs } : {}) };
}

export function confirmSlackDelivery(
  store: ConductorStore,
  gateId: string,
  deliveryId: string,
  ref: string,
): { recorded: boolean; ref: string } {
  const gate = approvedSlackGate(store, gateId);
  if (slackDelivery(gate).deliveryId !== deliveryId)
    throw new Error('Slack 게시 작업 식별자가 달라요');
  if (
    !/^\d+\.\d{6}$/.test(ref) &&
    !/^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+(?:\?[^\s]*)?$/.test(ref)
  )
    throw new Error('Slack 응답의 메시지 ts 또는 퍼머링크를 주세요');
  const previous = store.snapshot.slackPosted[gateId];
  if (previous === ref) return { recorded: false, ref };
  if (previous !== SLACK_HOST_HANDOFF)
    throw new Error('인계한 Slack 게시에만 결과를 남길 수 있어요');
  store.append({ type: 'slack-posted', at: store.timestamp(), gateId, ref });
  return { recorded: true, ref };
}

export interface PublishResult {
  posted: { gateId: string; ref: string }[];
  failed: { gateId: string; error: string }[];
  /** 승인 뒤 초안이 바뀌어 다시 승인을 받으려고 연 게이트 */
  reopened: { gateId: string; newGateId: string }[];
}

/**
 * 승인된 슬랙 초안을 한 번씩만 게시한다.
 *
 * 게시했는지는 slack-posted 이벤트로 남기고 다음 tick에는 건너뛴다. 거절된 초안은 게시하지 않는다.
 * 초안 파일은 워커도 쓸 수 있는 자리라 승인 때의 digest와 다르면 보내지 않는다. 바뀐 본문으로
 * 새 게이트를 열고 앞 게이트는 SUPERSEDED_PREFIX로 표시해 다음 tick이 다시 집지 않게 한다.
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
    if (!channel || !draftFile) {
      result.failed.push({ gateId: gate.id, error: '게이트에 채널이나 초안 경로가 없어요' });
      continue;
    }
    try {
      const threadTs = gate.payload?.threadTs;
      const text = readDraft(draftFile);
      if (draftDigest(channel, threadTs, text) !== gate.payload?.digest) {
        const { gate: next } = draftSlack(
          store,
          {
            channel,
            text,
            ...(gate.orderId ? { orderId: gate.orderId } : {}),
            ...(threadTs ? { threadTs } : {}),
          },
          dirname(draftFile),
        );
        store.append({
          type: 'slack-posted',
          at: store.timestamp(),
          gateId: gate.id,
          ref: `${SUPERSEDED_PREFIX}${next.id}`,
        });
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
      const ref = typeof posted === 'string' ? posted : SLACK_HOST_HANDOFF;
      store.append({ type: 'slack-posted', at: store.timestamp(), gateId: gate.id, ref });
      if (typeof posted !== 'string') posted.enqueue();
      result.posted.push({ gateId: gate.id, ref });
    } catch (err) {
      result.failed.push({
        gateId: gate.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
