import { isPlainObject } from '../core/json-file.js';
import type { BotOwner } from './bot-owner.js';
import { detectOrca, execRunner, type CommandRunner } from './launcher.js';

type RecordValue = Record<string, unknown>;
type RunState = 'chat-unavailable' | 'precheck-skipped' | 'post-failed' | 'completed' | 'unknown';
type Run = { id: string; at: number; state: RunState };
type Monitor = {
  automationId: string;
  nextCheckAt: number | null;
  latestRun: Run | null;
  latestPosting: Run | null;
};

const PRECHECK = 'test "$(( $(date +%s) % 1500 ))" -lt 300';
const PERIOD_MS = 25 * 60_000;
const POST_FAILED =
  "This run's message was answered together with another message, so its result wasn't posted.";
const time = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 8.64e15;
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(v);
const record = (v: unknown): RecordValue => (isPlainObject(v) ? v : {});

function targetAutomation(value: unknown, owner: BotOwner): RecordValue | undefined {
  const rows = record(value)['automations'];
  if (!Array.isArray(rows)) return undefined;
  const matches = rows.filter((row: unknown) => {
    const automation = record(row);
    const bot = record(automation['bot']);
    return (
      id(automation['id']) &&
      bot['botId'] === owner.botId &&
      bot['runsIn'] === 'chat' &&
      bot['resultsTo'] === 'chat' &&
      record(bot['chat'])['sessionId'] === owner.chatId &&
      automation['rrule'] === '*/5 * * * *' &&
      record(automation['precheck'])['command'] === PRECHECK
    );
  });
  return matches.length === 1 ? record(matches[0]) : undefined;
}

function nextCheck(automation: RecordValue): number | null {
  const at = automation['nextRunAt'];
  // Orca는 5분 트리거 시각을 준다. 같은 자동화의 25분 사전 검사 조건이 확인된 때만 통과할 슬롯을 표시한다.
  if (automation['enabled'] !== true || !time(at) || at % 300_000 !== 0) return null;
  const next = Math.ceil(at / PERIOD_MS) * PERIOD_MS;
  return time(next) ? next : null;
}

function runState(row: RecordValue, owner: BotOwner): RunState {
  const precheck = record(row['precheckResult']);
  const snapshot = record(row['outputSnapshot']);
  const dispatchedAt = row['dispatchedAt'];
  if (
    row['status'] === 'skipped_precheck' &&
    row['dispatchedAt'] === null &&
    precheck['command'] === PRECHECK &&
    precheck['exitCode'] === 1 &&
    precheck['timedOut'] === false &&
    precheck['error'] === null
  )
    return 'precheck-skipped';
  if (row['status'] === 'dispatch_failed') {
    if (time(dispatchedAt) && row['chatSessionId'] === owner.chatId && row['error'] === POST_FAILED)
      return 'post-failed';
    const target = `chat:${owner.chatId}`;
    const unavailable = `${owner.name} has no chat ${target} that takes mail, so pick one that \`orca bot chats --bot "${owner.name}"\` lists.`;
    if (
      row['dispatchedAt'] === null &&
      row['chatSessionId'] === null &&
      row['error'] === unavailable
    )
      return 'chat-unavailable';
  }
  if (
    row['status'] === 'completed' &&
    row['error'] === null &&
    time(dispatchedAt) &&
    row['chatSessionId'] === owner.chatId &&
    time(snapshot['capturedAt']) &&
    snapshot['capturedAt'] >= dispatchedAt &&
    snapshot['format'] === 'plain_text' &&
    typeof snapshot['content'] === 'string' &&
    snapshot['content'].trim()
  )
    return 'completed';
  return 'unknown';
}

function recentRuns(value: unknown, automationId: string, owner: BotOwner): Run[] {
  const rows = record(value)['runs'];
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((value: unknown) => {
    const row = record(value);
    const { id: runId, scheduledFor, automationId: rowId } = row;
    if (
      !id(runId) ||
      rowId !== automationId ||
      !time(scheduledFor) ||
      row['trigger'] !== 'scheduled'
    )
      return [];
    return [{ id: runId, at: scheduledFor, state: runState(row, owner) }];
  });
}

async function orcaResult(command: string, args: string[], run: CommandRunner): Promise<unknown> {
  try {
    const result = await run(
      command,
      ['automations', ...args, '--environment', 'local', '--json'],
      { timeoutMs: 3_000 },
    );
    if (result.code !== 0) return undefined;
    const body = record(JSON.parse(result.stdout));
    return body['ok'] === true ? body['result'] : undefined;
  } catch {
    return undefined;
  }
}

/** 기존 Orca CLI 인증 범위에서 운영 채팅과 일치하는 자동화의 일정과 실행 이력만 읽는다. */
export async function readConductorMonitor(
  owner: BotOwner | undefined,
  command = process.platform === 'linux' ? process.env['ORCA_CLI_COMMAND'] : detectOrca(),
  run: CommandRunner = execRunner,
): Promise<Monitor | null> {
  if (!owner || !command) return null;
  const automation = targetAutomation(await orcaResult(command, ['list'], run), owner);
  const automationId = automation?.['id'];
  if (!automation || !id(automationId)) return null;
  const runs = recentRuns(
    await orcaResult(command, ['runs', '--id', automationId, '--limit', '25'], run),
    automationId,
    owner,
  );
  return {
    automationId,
    nextCheckAt: nextCheck(automation),
    latestRun: runs[0] ?? null,
    latestPosting: runs.find((row) => row.state !== 'precheck-skipped') ?? null,
  };
}
