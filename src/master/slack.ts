import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId, type MasterStore } from './store.js';
import type { Gate } from './types.js';

/** 슬랙에 실제로 쓰는 어댑터. 마스터는 승인된 초안만 이걸로 보낸다 */
export interface SlackClient {
  /** 게시한 메시지의 참조(퍼머링크나 ts)를 돌려준다 */
  post(message: { channel: string; text: string; threadTs?: string }): Promise<string>;
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
 * 본문은 게이트에 싣지 않고 파일 경로만 둔다. 마스터가 게이트 목록을 볼 때 초안 본문이 대화로 딸려 오지 않게 하려는 것이다.
 * 같은 채널에 같은 본문을 다시 맡기면 열린 게이트를 다시 쓴다.
 * 주문 상태는 바꾸지 않는다. 슬랙 게시를 기다리느라 워커가 멈출 이유가 없어서다.
 */
export function draftSlack(
  store: MasterStore,
  input: SlackDraftInput,
  draftDir: string,
): { gate: Gate; reused: boolean } {
  const digest = createHash('sha256')
    .update(`${input.channel}\n${input.threadTs ?? ''}\n${input.text}`)
    .digest('hex')
    .slice(0, 16);
  const existing = store
    .openGates()
    .find((g) => g.type === 'slack-post' && g.payload?.digest === digest);
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

export interface PublishResult {
  posted: { gateId: string; ref: string }[];
  failed: { gateId: string; error: string }[];
}

/**
 * 승인된 슬랙 초안을 한 번씩만 게시한다.
 *
 * 게시했는지는 slack-posted 이벤트로 남기고 다음 tick에는 건너뛴다. 거절된 초안은 게시하지 않는다.
 * 승인 뒤에 사람이 초안 파일을 고쳤으면 고친 본문을 보낸다.
 */
export async function publishApprovedSlack(
  store: MasterStore,
  client: SlackClient,
  readDraft: (file: string) => string = (f) => readFileSync(f, 'utf-8'),
): Promise<PublishResult> {
  const result: PublishResult = { posted: [], failed: [] };
  const pending = Object.values(store.snapshot.gates).filter(
    (g) =>
      g.type === 'slack-post' &&
      g.status === 'resolved' &&
      g.decision === 'approved' &&
      store.snapshot.slackPosted[g.id] === undefined,
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
      const ref = await client.post({
        channel,
        text: readDraft(draftFile),
        ...(threadTs ? { threadTs } : {}),
      });
      store.append({ type: 'slack-posted', at: store.timestamp(), gateId: gate.id, ref });
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
