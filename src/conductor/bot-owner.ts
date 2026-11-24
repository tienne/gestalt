import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPlainObject, writeJsonAtomic } from '../core/json-file.js';
import { acquireLock } from './engine.js';
import { isSessionId } from './handoff.js';
import { detectOrca, execRunner, type CommandRunner } from './launcher.js';

export interface BotOwner {
  botId: string;
  name: string;
  chatId: string;
}

export interface BotHandoffRecord {
  id: string;
  approval: string;
  automationId: string;
  from: string;
  to: string;
  botId: string;
  settings: string;
  revision: number;
  editUncertain?: boolean;
  outcome?: 'completed' | 'cancelled';
  nextRunAt?: number;
}

export interface BotOwnership {
  active?: BotOwner;
  retired: string[];
  revision: number;
  handoffs: BotHandoffRecord[];
}

function ownerRecord(value: unknown): value is BotOwner {
  return (
    isPlainObject(value) &&
    typeof value['botId'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['chatId'] === 'string' &&
    isSessionId(value['chatId'])
  );
}

const ownershipPath = (dir: string) => join(dir, 'bot-owner.json');

function handoffRecord(value: unknown): value is BotHandoffRecord {
  return (
    isPlainObject(value) &&
    ['id', 'approval', 'automationId', 'from', 'to', 'botId', 'settings'].every(
      (key) => typeof value[key] === 'string',
    ) &&
    typeof value['revision'] === 'number' &&
    Number.isSafeInteger(value['revision']) &&
    (value['editUncertain'] === undefined || typeof value['editUncertain'] === 'boolean') &&
    (value['outcome'] === undefined ||
      value['outcome'] === 'completed' ||
      value['outcome'] === 'cancelled') &&
    (value['nextRunAt'] === undefined || Number.isFinite(value['nextRunAt']))
  );
}

export function readBotOwnership(dir: string): BotOwnership {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(ownershipPath(dir), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { retired: [], revision: 0, handoffs: [] };
    throw err;
  }
  if (
    !isPlainObject(data) ||
    (data['active'] !== undefined && !ownerRecord(data['active'])) ||
    !Array.isArray(data['retired']) ||
    !data['retired'].every((id: unknown) => typeof id === 'string' && isSessionId(id)) ||
    (data['revision'] !== undefined &&
      (typeof data['revision'] !== 'number' ||
        !Number.isSafeInteger(data['revision']) ||
        data['revision'] < 0)) ||
    (data['handoffs'] !== undefined &&
      (!Array.isArray(data['handoffs']) || !data['handoffs'].every(handoffRecord)))
  ) {
    throw new Error('봇 운영권 파일을 읽을 수 있어야 컨덕터를 실행할 수 있어요');
  }
  return {
    ...(data['active'] ? { active: data['active'] } : {}),
    retired: data['retired'] as string[],
    revision: data['revision'] ?? 0,
    handoffs: data['handoffs'] ?? [],
  };
}

/** tick 잠금을 잡은 호출자만 운영권과 인계 기록을 함께 저장한다. */
export function writeBotOwnership(dir: string, ownership: BotOwnership): void {
  writeJsonAtomic(ownershipPath(dir), ownership, { mode: 0o600 });
}

/** 운영권 교체와 tick 진입이 같은 잠금을 써야 앞 채팅이 뒤늦게 tick을 시작할 수 없다. */
export function changeBotOwner(dir: string, previous: string | undefined, next?: BotOwner): void {
  const lock = acquireLock(dir);
  if (!lock.ok) throw new Error('tick이 끝난 뒤 운영권 변경을 다시 시도해 주세요');
  try {
    const { active, retired, revision, handoffs } = readBotOwnership(dir);
    if (handoffs.some((record) => !record.outcome))
      throw new Error('진행 중인 bot handoff를 먼저 완료하거나 취소해 주세요');
    if (active?.chatId !== previous) throw new Error('현재 운영 채팅이 바뀌었어요');
    if (next && retired.includes(next.chatId))
      throw new Error('인계한 채팅은 다시 등록할 수 없어요');
    if (active?.chatId === next?.chatId) return;
    const record: BotOwnership = {
      ...(next ? { active: next } : {}),
      retired: active ? [...retired, active.chatId] : retired,
      revision: revision + 1,
      handoffs,
    };
    writeBotOwnership(dir, record);
  } finally {
    lock.release();
  }
}

export function assertBotOwner(dir: string, caller: BotOwner | undefined): void {
  const { active, retired } = readBotOwnership(dir);
  if (caller && retired.includes(caller.chatId))
    throw new Error('이미 운영권을 인계한 봇 채팅이에요');
  if (active) {
    if (caller?.botId === active.botId && caller.chatId === active.chatId) return;
    throw new Error(`운영권은 Orca 봇 ${active.name}의 채팅 ${active.chatId}에 있어요`);
  }
  if (caller) throw new Error('먼저 bot bind로 이 채팅의 운영권을 등록해 주세요');
}

type BotCli = { command: string; run: CommandRunner };
function botCli(): BotCli | undefined {
  const command = detectOrca();
  return command ? { command, run: execRunner } : undefined;
}

async function orcaData(cli: BotCli, args: string[]): Promise<unknown> {
  const result = await cli.run(cli.command, ['bot', ...args, '--environment', 'local', '--json'], {
    timeoutMs: 5000,
  });
  const body: unknown = JSON.parse(result.stdout);
  if (!isPlainObject(body)) throw new Error('Orca CLI 응답을 읽을 수 없어요');
  if (result.code === 0 && body['ok'] === true) return body['result'];
  const error = body['error'];
  if (
    args.length === 1 &&
    args[0] === 'chats' &&
    isPlainObject(error) &&
    error['code'] === 'invalid_argument' &&
    error['message'] === 'Name the bot with --bot, or run this from the bot’s chat.'
  ) {
    return undefined;
  }
  throw new Error('Orca CLI에서 봇 채팅을 확인하지 못했어요');
}

async function resolveBot(
  cli: BotCli,
  chats: unknown,
  match: (row: Record<string, unknown>) => boolean,
): Promise<BotOwner> {
  if (!isPlainObject(chats) || typeof chats['bot'] !== 'string' || !Array.isArray(chats['chats']))
    throw new Error('Orca 봇 채팅 목록을 읽을 수 없어요');
  const rows = chats['chats'].filter(
    (row: unknown) => isPlainObject(row) && row['closed'] === false && match(row),
  );
  const chatId: unknown = rows.length === 1 ? rows[0]['id'] : undefined;
  if (typeof chatId !== 'string' || !isSessionId(chatId))
    throw new Error('메일을 받을 수 있는 Orca 봇 채팅이 하나여야 해요');
  const roster = await orcaData(cli, ['list']);
  if (!isPlainObject(roster) || !Array.isArray(roster['bots']))
    throw new Error('Orca 봇 목록을 읽을 수 없어요');
  const bots = roster['bots'].filter(
    (row: unknown) => isPlainObject(row) && row['name'] === chats['bot'] && row['paused'] === false,
  );
  const botId: unknown = bots.length === 1 ? bots[0]['id'] : undefined;
  if (typeof botId !== 'string') throw new Error('활성 Orca 봇이 하나여야 해요');
  return { botId, name: chats['bot'], chatId };
}

export async function currentBotOwner(): Promise<BotOwner | undefined> {
  if (!process.env['ORCA_AGENT_SESSION_ID'] && !process.env['ORCA_AGENT_SESSION_TOOL_TOKEN'])
    return undefined;
  const cli = botCli();
  if (!cli) throw new Error('Orca CLI에서 현재 세션을 확인해야 해요');
  const chats = await orcaData(cli, ['chats']);
  return chats === undefined ? undefined : resolveBot(cli, chats, (row) => row['self'] === true);
}

export async function targetBotOwner(
  name: string,
  chatId: string,
  cli = botCli(),
): Promise<BotOwner> {
  if (!cli) throw new Error('Orca CLI가 필요해요');
  const chats = await orcaData(cli, ['chats', '--bot', name]);
  return resolveBot(cli, chats, (row) => row['id'] === chatId);
}
