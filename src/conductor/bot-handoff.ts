import { realpathSync } from 'node:fs';
import {
  readBotOwnership,
  targetBotOwner,
  writeBotOwnership,
  type BotHandoffRecord,
  type BotOwner,
  type BotOwnership,
} from './bot-owner.js';
import { acquireLock } from './engine.js';
import { isSessionId } from './handoff.js';
import {
  digest,
  retargetBotAutomation,
  showScheduledBotAutomation,
  type ScheduledBotAutomation,
} from './orca-automation.js';

export interface BotHandoffOptions {
  request: string;
  automation: string;
  bot: string;
  fromChat: string;
  chat: string;
  approve?: string;
  cancel?: boolean;
}

interface HandoffDeps {
  chat: (name: string, id: string) => Promise<BotOwner>;
  show: (id: string) => Promise<ScheduledBotAutomation>;
  retarget: (id: string, chat: string) => Promise<void>;
  write: typeof writeBotOwnership;
  now: () => number;
}

const defaultDeps: HandoffDeps = {
  chat: targetBotOwner,
  show: showScheduledBotAutomation,
  retarget: retargetBotAutomation,
  write: writeBotOwnership,
  now: Date.now,
};

type Stage = 'preflight' | 'write-intent' | 'retarget' | 'verify' | 'commit-owner' | 'cancel';

export interface BotHandoffResult {
  status: 'ready' | 'blocked' | 'partial' | 'completed' | 'cancelled';
  requestId: string;
  automationId: string;
  fromChatId: string;
  toChatId: string;
  responsibleChatId?: string;
  ownerRevision: number;
  automationChatId?: string;
  schedule?: string;
  verifiedNextRunAt?: number;
  approval?: string;
  replayed?: boolean;
  retryStage?: Stage;
  detail?: string;
}

function resultBase(options: BotHandoffOptions, ownership: BotOwnership) {
  return {
    requestId: options.request,
    automationId: options.automation,
    fromChatId: options.fromChat,
    toChatId: options.chat,
    ownerRevision: ownership.revision,
    ...(ownership.active ? { responsibleChatId: ownership.active.chatId } : {}),
  };
}

function assertSource(
  ownership: BotOwnership,
  options: BotHandoffOptions,
  pending?: BotHandoffRecord,
) {
  if (ownership.active?.chatId !== options.fromChat) throw new Error('현재 운영 채팅이 바뀌었어요');
  if (pending && ownership.revision !== pending.revision)
    throw new Error('승인한 운영권 리비전과 달라요');
  if (ownership.retired.includes(options.chat))
    throw new Error('인계한 채팅은 다시 등록할 수 없어요');
  return ownership.active;
}

function recordResult(
  ownership: BotOwnership,
  options: BotHandoffOptions,
  record: BotHandoffRecord,
): BotHandoffResult {
  return {
    ...resultBase(options, ownership),
    status: record.outcome!,
    automationChatId: record.outcome === 'completed' ? record.to : record.from,
    ...(record.nextRunAt ? { verifiedNextRunAt: record.nextRunAt } : {}),
  };
}

/** Orca 변경 전 의도를 남긴 뒤 tick 잠금 안에서 운영권과 완료 기록을 한 번에 저장한다. */
export async function handoffBot(
  dir: string,
  options: BotHandoffOptions,
  deps: HandoffDeps = defaultDeps,
): Promise<BotHandoffResult> {
  if (
    ![options.request, options.automation, options.chat, options.fromChat].every(isSessionId) ||
    options.chat === options.fromChat ||
    (options.cancel && !options.approve)
  ) {
    throw new Error(
      '서로 다른 채팅 ID, 요청 ID, 자동화 ID를 적어 주세요. 취소에는 기존 승인값이 필요해요',
    );
  }
  const lock = acquireLock(dir);
  if (!lock.ok) {
    return {
      ...resultBase(options, readBotOwnership(dir)),
      status: 'blocked',
      retryStage: 'preflight',
      detail: 'tick 또는 다른 인계가 끝난 뒤 같은 요청으로 다시 시도해 주세요',
    };
  }
  try {
    return await handoffLocked(dir, options, deps);
  } finally {
    lock.release();
  }
}

async function handoffLocked(
  dir: string,
  options: BotHandoffOptions,
  deps: HandoffDeps,
): Promise<BotHandoffResult> {
  const ownership = readBotOwnership(dir);
  const base = resultBase(options, ownership);
  let journal = ownership.handoffs.find((entry) => entry.id === options.request);
  let stage: Stage = 'preflight';
  let observed: ScheduledBotAutomation | undefined;
  try {
    if (
      journal &&
      (journal.from !== options.fromChat ||
        journal.to !== options.chat ||
        journal.automationId !== options.automation ||
        (options.approve !== undefined && options.approve !== journal.approval))
    ) {
      throw new Error('이 요청 ID는 다른 인계 또는 승인값에 이미 쓰였어요');
    }
    if (journal?.outcome) return { ...recordResult(ownership, options, journal), replayed: true };
    if (ownership.handoffs.some((entry) => !entry.outcome && entry.id !== options.request))
      throw new Error('진행 중인 인계를 먼저 완료하거나 취소해 주세요');

    const source = assertSource(ownership, options, journal);
    if (source.name !== options.bot) throw new Error('현재 운영 봇 이름과 달라요');
    if (journal) stage = options.cancel ? 'cancel' : 'verify';
    const [from, target] = await Promise.all([
      !journal || options.cancel ? deps.chat(options.bot, options.fromChat) : source,
      options.cancel && journal
        ? { ...source, chatId: journal.to }
        : deps.chat(options.bot, options.chat),
    ]);
    if (
      from.botId !== source.botId ||
      from.chatId !== source.chatId ||
      target.botId !== source.botId ||
      target.chatId !== options.chat
    )
      throw new Error('두 채팅은 같은 활성 Orca 봇에 속해야 해요');

    const show = async () => {
      const latest = await deps.show(options.automation);
      if (latest.id !== options.automation || latest.botId !== source.botId)
        throw new Error('기존 자동화 ID 또는 소속 봇이 달라요');
      return latest;
    };
    const verify = (latest: ScheduledBotAutomation) => {
      if (journal && latest.settings !== journal.settings)
        throw new Error('정기 자동화 설정이 승인한 값에서 바뀌었어요');
      if (latest.nextRunAt <= deps.now()) throw new Error('앞으로 실행될 시각을 확인하지 못했어요');
    };
    const automation = await show();
    observed = automation;
    verify(automation);
    if (automation.chatId !== source.chatId && (!journal || automation.chatId !== target.chatId))
      throw new Error('자동화가 기존 운영 채팅 또는 승인된 인계 대상에 있지 않아요');

    const proposed = {
      id: options.request,
      automationId: automation.id,
      from: source.chatId,
      to: target.chatId,
      botId: source.botId,
      settings: automation.settings,
      revision: ownership.revision,
    };
    const approval = digest({ store: realpathSync(dir), ...proposed });
    if (!options.approve) {
      return {
        ...base,
        status: journal ? 'partial' : 'ready',
        automationChatId: automation.chatId,
        schedule: automation.schedule,
        verifiedNextRunAt: automation.nextRunAt,
        approval,
        ...(journal
          ? { retryStage: automation.chatId === target.chatId ? 'commit-owner' : 'retarget' }
          : {}),
      };
    }
    if (approval !== options.approve)
      throw new Error('승인한 스냅샷이 바뀌었어요. 다시 미리보기를 확인해 주세요');
    const save = (record: BotHandoffRecord, next = ownership) => {
      deps.write(dir, {
        ...next,
        handoffs: [...ownership.handoffs.filter((entry) => entry.id !== record.id), record],
      });
    };
    if (options.cancel) {
      stage = 'cancel';
      if (!journal || automation.chatId !== source.chatId)
        throw new Error('기존 채팅의 정기 자동화와 진행 중인 요청을 확인한 뒤 취소할 수 있어요');
      save({ ...journal, outcome: 'cancelled' });
      return { ...base, status: 'cancelled', automationChatId: automation.chatId };
    }
    if (!journal) {
      stage = 'write-intent';
      const intent = { ...proposed, approval };
      save(intent);
      journal = intent;
    }
    let confirmed = automation;
    if (automation.chatId !== target.chatId) {
      stage = 'retarget';
      observed = undefined;
      let editError: unknown;
      try {
        await deps.retarget(automation.id, target.chatId);
      } catch (error) {
        editError = error;
      }
      stage = 'verify';
      observed = await show();
      verify(observed);
      if (observed.chatId !== target.chatId) {
        stage = observed.chatId === source.chatId ? 'retarget' : 'verify';
        throw editError ?? new Error('Orca에서 인계 대상 채팅을 확인하지 못했어요');
      }
      confirmed = observed;
    }
    stage = 'commit-owner';
    const next = {
      ...ownership,
      active: target,
      retired: [...ownership.retired, source.chatId],
      revision: ownership.revision + 1,
    };
    const completed = { ...journal, outcome: 'completed', nextRunAt: confirmed.nextRunAt } as const;
    save(completed, next);
    return {
      ...recordResult(next, options, completed),
      schedule: confirmed.schedule,
    };
  } catch (error) {
    return {
      ...base,
      status: journal && !journal.outcome ? 'partial' : 'blocked',
      ...(observed ? { automationChatId: observed.chatId, schedule: observed.schedule } : {}),
      retryStage: stage,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
