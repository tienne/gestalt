import { isPlainObject } from '../core/json-file.js';
import type { BotGate } from './bot-approval.js';
import type { BotOwner } from './bot-owner.js';
import { detectOrca, execRunner, type CommandRunner } from './launcher.js';
import type { OrcaItemSource } from './types.js';

/**
 * Orca 항목 답을 게이트 결정으로 읽는 경로.
 *
 * Orca 1.4.269의 항목 이벤트는 답한 쪽을 `actor.kind: 'owner'`로만 남긴다. 사람마다 다른 식별자도,
 * 레포별 권한도, Gestalt가 따로 확인할 서명도 없다. 이 정보만으로는 봇 채팅의 에이전트가 같은 계정으로
 * 만든 기록과 사람이 화면에서 누른 답을 가를 수 없어서 답 본문에 기존 승인자 서명이 함께 있을 때만 받는다.
 * Orca가 아래 계약을 주면 서명 없는 답도 열 수 있다.
 */
export const ORCA_APPROVAL_CONTRACT = [
  '답한 사람마다 다른 승인자 식별자(지금은 owner 하나뿐)',
  '레포별 승인 권한을 Orca 쪽에서 확인한 결과',
  '항목, 질문, 답 이벤트와 결정을 묶어 Orca 밖에서 확인할 수 있는 서명',
] as const;

export const ORCA_ITEM_BINDING = 'gestalt/orca-item/v1';

/** 질문에 그대로 실을 한 줄. 게이트를 다시 열거나 PR HEAD가 바뀌면 값이 달라져 옛 질문의 답이 안 맞는다 */
export function itemBinding(target: BotGate, head: string | undefined): string {
  const { gate, repo, ref } = target;
  return JSON.stringify([
    ORCA_ITEM_BINDING,
    gate.id,
    gate.type,
    gate.openedAt,
    repo.toLowerCase(),
    ...(gate.type === 'merge' ? [ref ?? '', head ?? ''] : []),
  ]);
}

export interface OrcaItemEvent {
  id: string;
  kind: string;
  actor: Record<string, unknown>;
  data: Record<string, unknown>;
}

export interface OrcaItemShow {
  item: { uid: string; number: number; botId: string; chatId: string };
  events: OrcaItemEvent[];
}

export function parseItemShow(value: unknown): OrcaItemShow {
  const fail = () => new Error('Orca 항목을 읽을 수 없어요');
  if (!isPlainObject(value) || !isPlainObject(value['item']) || !Array.isArray(value['events']))
    throw fail();
  const item = value['item'];
  const owner = item['owner'];
  const chat = item['chat'];
  if (
    typeof item['uid'] !== 'string' ||
    typeof item['number'] !== 'number' ||
    !isPlainObject(owner) ||
    typeof owner['botId'] !== 'string' ||
    !isPlainObject(chat) ||
    typeof chat['id'] !== 'string'
  )
    throw fail();
  const events = value['events'].flatMap((row: unknown): OrcaItemEvent[] =>
    isPlainObject(row) &&
    typeof row['id'] === 'string' &&
    typeof row['kind'] === 'string' &&
    isPlainObject(row['actor']) &&
    isPlainObject(row['data'])
      ? [{ id: row['id'], kind: row['kind'], actor: row['actor'], data: row['data'] }]
      : [],
  );
  return {
    item: { uid: item['uid'], number: item['number'], botId: owner['botId'], chatId: chat['id'] },
    events,
  };
}

/** 봇 채팅의 말 대신 Orca가 저장한 항목을 직접 읽는다 */
export async function readOrcaItem(
  item: number,
  cli: { command: string; run: CommandRunner } | undefined = orcaCli(),
): Promise<OrcaItemShow> {
  if (!cli) throw new Error('Orca CLI에서 항목을 확인해야 해요');
  const result = await cli.run(
    cli.command,
    ['bot', 'item', 'show', String(item), '--environment', 'local', '--json'],
    { timeoutMs: 5000 },
  );
  let body: unknown;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    throw new Error('Orca 항목을 읽을 수 없어요');
  }
  if (result.code !== 0 || !isPlainObject(body) || body['ok'] !== true)
    throw new Error(`Orca 항목 ${item}을 찾지 못했어요`);
  return parseItemShow(body['result']);
}

function orcaCli() {
  const command = detectOrca();
  return command ? { command, run: execRunner } : undefined;
}

export class OrcaContractError extends Error {
  readonly missing = ORCA_APPROVAL_CONTRACT;
  constructor() {
    super(
      `Orca 답에 승인자 서명이 없어 게이트에 반영하지 않았어요. 서명 없는 답을 받으려면 Orca가 ${ORCA_APPROVAL_CONTRACT.join(', ')}을 줘야 해요`,
    );
  }
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (isPlainObject(value)) return Object.values(value).flatMap(strings);
  return [];
}

const mentionsBinding = (e: OrcaItemEvent, line?: string) =>
  strings(e.data).some((text) =>
    text.split('\n').some((l) => (line ? l.trim() === line : l.includes(ORCA_ITEM_BINDING))),
  );

const DECISIONS: Record<string, 'approved' | 'rejected'> = {
  승인: 'approved',
  approved: 'approved',
  거절: 'rejected',
  rejected: 'rejected',
};

export interface ItemDecision {
  decision: 'approved' | 'rejected';
  signer: string;
  signature: string;
  source: OrcaItemSource;
}

/**
 * 답이 운영 봇의 항목에서 이 게이트를 묻는 마지막 질문에 사람이 단 것인지 본다.
 * 서명 확인은 호출한 쪽이 기존 승인자 정책으로 한다.
 */
export function readItemDecision(input: {
  show: OrcaItemShow;
  owner: BotOwner;
  item: number;
  question: string;
  answer: string;
  binding: string;
}): ItemDecision {
  const { show, owner, binding } = input;
  if (show.item.number !== input.item) throw new Error('요청한 Orca 항목이 아니에요');
  if (show.item.botId !== owner.botId || show.item.chatId !== owner.chatId)
    throw new Error('운영 봇 채팅이 만든 Orca 항목이 아니에요');
  const qi = show.events.findIndex((e) => e.id === input.question);
  const ai = show.events.findIndex((e) => e.id === input.answer);
  if (qi < 0 || ai < 0) throw new Error('질문이나 답 이벤트를 Orca 항목에서 찾지 못했어요');
  const question = show.events[qi]!;
  const answer = show.events[ai]!;
  if (
    question.kind !== 'commented' ||
    question.actor['kind'] !== 'bot' ||
    question.actor['botId'] !== owner.botId ||
    question.actor['chatId'] !== owner.chatId ||
    !mentionsBinding(question, binding)
  )
    throw new Error('지금 게이트와 PR HEAD를 묻는 운영 봇의 질문이 아니에요');
  if (ai <= qi) throw new Error('질문보다 먼저 남은 답이에요');
  if (
    show.events
      .slice(qi + 1, ai)
      .some((e) => e.kind === 'commented' && e.actor['kind'] !== 'owner' && mentionsBinding(e))
  )
    throw new Error('더 새 질문이 있어요. 마지막 질문에 단 답만 받아요');
  if (answer.kind !== 'commented' || answer.actor['kind'] !== 'owner')
    throw new Error('사람이 Orca 화면에서 단 답이 아니에요');
  const text = typeof answer.data['text'] === 'string' ? answer.data['text'] : '';
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const decision = lines[0] !== undefined ? DECISIONS[lines[0]] : undefined;
  if (!decision || lines.length > 2) throw new Error('승인이나 거절로 읽을 수 없는 답이에요');
  if (lines.length === 1) throw new OrcaContractError();
  const signed = /^(?:서명\s+)?(\S+)\s+([A-Za-z0-9+/]{86}==)$/.exec(lines[1]!);
  if (!signed) throw new Error('서명 줄은 "서명 <승인자-ID> <base64>" 꼴이어야 해요');
  return {
    decision,
    signer: signed[1]!,
    signature: signed[2]!,
    source: {
      kind: 'orca-item',
      botId: owner.botId,
      chatId: owner.chatId,
      item: show.item.number,
      itemUid: show.item.uid,
      question: question.id,
      answer: answer.id,
    },
  };
}
