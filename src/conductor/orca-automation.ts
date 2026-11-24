import { createHash } from 'node:crypto';
import { isPlainObject } from '../core/json-file.js';
import { detectOrca, execRunner } from './launcher.js';

export interface ScheduledBotAutomation {
  id: string;
  botId: string;
  chatId: string;
  schedule: string;
  nextRunAt: number;
  settings: string;
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedJson(value[key])]),
  );
}

export function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortedJson(value)))
    .digest('hex');
}

const runtimeFields = new Set(['nextRunAt', 'lastRunAt', 'updatedAt']);

/** Orca show에 공개된 설정 전체를 비교하되 실행 시각과 바꿀 채팅은 제외한다. */
export function readScheduledBotAutomation(response: unknown): ScheduledBotAutomation {
  const automation = isPlainObject(response) ? response['automation'] : undefined;
  const bot = isPlainObject(automation) ? automation['bot'] : undefined;
  const chat = isPlainObject(bot) ? bot['chat'] : undefined;
  if (
    !isPlainObject(automation) ||
    typeof automation['id'] !== 'string' ||
    automation['enabled'] !== true ||
    typeof automation['rrule'] !== 'string' ||
    !automation['rrule'] ||
    typeof automation['nextRunAt'] !== 'number' ||
    !Number.isSafeInteger(automation['nextRunAt']) ||
    !isPlainObject(bot) ||
    typeof bot['botId'] !== 'string' ||
    !Object.hasOwn(bot, 'resultsTo') ||
    bot['runsIn'] !== 'chat' ||
    !isPlainObject(chat) ||
    typeof chat['sessionId'] !== 'string'
  ) {
    throw new Error('채팅 ID가 지정된 활성 Orca 봇 정기 자동화와 다음 실행 시각이 필요해요');
  }
  const settings = Object.fromEntries(
    Object.entries(automation).filter(([key]) => key !== 'bot' && !runtimeFields.has(key)),
  );
  settings['bot'] = Object.fromEntries(Object.entries(bot).filter(([key]) => key !== 'chat'));
  return {
    id: automation['id'],
    botId: bot['botId'],
    chatId: chat['sessionId'],
    schedule: automation['rrule'],
    nextRunAt: automation['nextRunAt'],
    settings: digest(settings),
  };
}

async function callOrcaAutomation(args: string[]): Promise<unknown> {
  const command = detectOrca();
  if (!command) throw new Error('Orca CLI가 필요해요');
  const result = await execRunner(
    command,
    ['automations', ...args, '--environment', 'local', '--json'],
    {
      timeoutMs: 10_000,
    },
  );
  let body: unknown;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    throw new Error('Orca 자동화 응답을 읽을 수 없어요');
  }
  if (isPlainObject(body) && body['ok'] === true && result.code === 0) return body['result'];
  const error = isPlainObject(body) ? body['error'] : undefined;
  const code = isPlainObject(error) ? error['code'] : undefined;
  throw new Error(
    `Orca 자동화 ${args[0]} 실패${typeof code === 'string' && /^[a-z_]+$/.test(code) ? ` (${code})` : ''}`,
  );
}

export async function showScheduledBotAutomation(id: string): Promise<ScheduledBotAutomation> {
  return readScheduledBotAutomation(await callOrcaAutomation(['show', '--id', id]));
}

export async function retargetBotAutomation(id: string, chat: string): Promise<void> {
  await callOrcaAutomation(['edit', '--id', id, '--runs-in', `chat:${chat}`]);
}
