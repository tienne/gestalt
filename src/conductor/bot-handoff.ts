import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  automationCoordinationRoot,
  handoffCancellationPending,
  lockAutomationHandoff,
  matchesApproval,
} from './bot-handoff-coordination.js';
import {
  hasEditAttempts,
  launchAutomationEdit,
  lockEditAttempt,
  readEditReceipt,
} from './bot-handoff-edit.js';
import { handoffApproval } from './bot-handoff-record.js';
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
  launchEdit: typeof launchAutomationEdit;
  write: typeof writeBotOwnership;
  now: () => number;
  coordinationRoot: () => string;
}

const defaultDeps: HandoffDeps = {
  chat: targetBotOwner,
  show: showScheduledBotAutomation,
  launchEdit: launchAutomationEdit,
  write: writeBotOwnership,
  now: Date.now,
  coordinationRoot: automationCoordinationRoot,
};

type Stage =
  | 'preflight'
  | 'coordinate'
  | 'write-intent'
  | 'retarget'
  | 'reconcile-edit'
  | 'verify'
  | 'commit-owner'
  | 'cancel';

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
  editAttemptId?: string;
  editDispatchedAt?: string;
  cancelScope?: 'gestalt';
  orcaVerification?: 'observed' | 'not-checked';
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
    ...(record.outcome === 'completed'
      ? { automationChatId: record.to }
      : { cancelScope: 'gestalt', orcaVerification: 'not-checked' }),
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
    const store = realpathSync(dir);
    const coordination = lockAutomationHandoff(deps.coordinationRoot(), options.automation);
    if (!coordination) {
      return {
        ...resultBase(options, readBotOwnership(dir)),
        status: 'blocked',
        retryStage: 'coordinate',
        detail: '같은 Orca 자동화 인계가 다른 프로세스에서 진행 중이에요',
      };
    }
    try {
      return await handoffLocked(store, options, deps, coordination);
    } finally {
      coordination.release();
    }
  } finally {
    lock.release();
  }
}

async function handoffLocked(
  dir: string,
  options: BotHandoffOptions,
  deps: HandoffDeps,
  coordination: NonNullable<ReturnType<typeof lockAutomationHandoff>>,
): Promise<BotHandoffResult> {
  const ownership = readBotOwnership(dir);
  const base = resultBase(options, ownership);
  let journal = ownership.handoffs.find((entry) => entry.id === options.request);
  let stage: Stage = 'preflight';
  let observed: ScheduledBotAutomation | undefined;
  let receipt: ReturnType<typeof readEditReceipt>;
  let cancelLock: ReturnType<typeof lockEditAttempt> | undefined;
  let settlingCancellation = false;
  const save = (record: BotHandoffRecord, next = ownership) => {
    deps.write(dir, {
      ...next,
      handoffs: [...ownership.handoffs.filter((entry) => entry.id !== record.id), record],
    });
    journal = record;
  };
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
    stage = 'coordinate';
    const claim = coordination.read();
    const ownsInitialClaim = claim?.store === dir && claim.request === options.request;
    settlingCancellation =
      journal?.cancelPending === true || (journal?.outcome === 'cancelled' && ownsInitialClaim);
    if (settlingCancellation && !options.cancel) {
      stage = 'reconcile-edit';
      throw new Error('취소 복구가 남아 있어요. 기존 승인값으로 --cancel을 다시 실행해 주세요');
    }
    if (journal?.outcome === 'cancelled' && !settlingCancellation) {
      return { ...recordResult(ownership, options, journal), replayed: true };
    }
    if (options.cancel && journal?.cancelPending && !ownsInitialClaim) {
      stage = 'reconcile-edit';
      if (handoffApproval(dir, journal) !== journal.approval)
        throw new Error('로컬 취소 기록의 승인 스냅샷이 현재 요청과 달라요');
      const localReceipt = journal.editAttempt
        ? readEditReceipt(coordination.dir, journal.approval, journal.editAttempt)
        : undefined;
      if (journal.editUncertain !== undefined || localReceipt?.outcome === 'dispatched')
        throw new Error('이 요청의 Orca 편집 응답을 확인한 뒤 로컬 취소를 복구해 주세요');
      coordination.assertMatchingRelease(dir, journal);
      const source = assertSource(ownership, options, journal);
      if (source.name !== options.bot) throw new Error('현재 운영 봇 이름과 달라요');
      const { cancelPending: _cancelPending, ...intent } = journal;
      const cancelled = { ...intent, outcome: 'cancelled' } as const;
      save(cancelled);
      return {
        ...recordResult(ownership, options, cancelled),
        detail:
          '로컬 인계 요청의 취소를 복구했어요. Orca 일정을 조회하지 않고 현재 담당 예약을 보존했어요',
      };
    }
    let attempt = journal?.editAttempt;
    if (options.cancel && journal && (!journal.outcome || settlingCancellation)) {
      stage = 'reconcile-edit';
      if (ownsInitialClaim && !matchesApproval(claim, dir, journal))
        throw new Error('Orca 공유 예약의 승인 스냅샷이 현재 요청과 달라요');
      if (attempt) {
        cancelLock = lockEditAttempt(coordination.dir, journal.approval, attempt);
        if (!cancelLock.ok)
          throw new Error('Orca 편집 프로세스의 응답이 도착한 뒤 다시 확인해 주세요');
        receipt = readEditReceipt(coordination.dir, journal.approval, attempt);
      }
    }
    const foreignClaim = claim?.store !== dir ? claim : undefined;
    const cancelUnsentLocal =
      options.cancel &&
      foreignClaim &&
      journal &&
      (settlingCancellation ||
        (!attempt &&
          journal.editUncertain === undefined &&
          !hasEditAttempts(coordination.dir, journal.approval)));
    if (foreignClaim && !cancelUnsentLocal)
      throw new Error(
        `다른 상태 저장소가 이 Orca 자동화를 맡고 있어요 (${foreignClaim.store}, 요청 ${foreignClaim.request})`,
      );
    if (!journal && claim?.request === options.request && claim.intent && options.approve) {
      const intent = claim.intent;
      if (
        intent.approval !== options.approve ||
        intent.automationId !== options.automation ||
        intent.from !== options.fromChat ||
        intent.to !== options.chat
      )
        throw new Error('예약한 인계 요청 또는 승인값과 달라요');
      if (options.cancel && !matchesApproval(claim, dir, intent)) {
        stage = 'reconcile-edit';
        throw new Error('Orca 공유 예약의 승인 스냅샷이 현재 요청과 달라요');
      }
      if (hasEditAttempts(coordination.dir, intent.approval)) {
        stage = 'reconcile-edit';
        throw new Error(
          '로컬 인계 기록은 없지만 공유 편집 기록이 남아 있어요. Orca 운영자에게 확인을 요청해 주세요',
        );
      }
      const source = assertSource(ownership, options, intent);
      if (source.name !== options.bot) throw new Error('현재 운영 봇 이름과 달라요');
      save(intent);
    }
    if (journal?.outcome && !settlingCancellation) {
      return { ...recordResult(ownership, options, journal), replayed: true };
    }
    if (
      claim &&
      !cancelUnsentLocal &&
      claim.request !== options.request &&
      !ownership.handoffs.some(
        (entry) =>
          entry.id === claim.request &&
          entry.outcome &&
          !handoffCancellationPending(dir, entry, deps.coordinationRoot()),
      )
    )
      throw new Error(`공유 담당 기록의 요청 ${claim.request}을 먼저 이어가거나 취소해 주세요`);
    stage = 'preflight';
    if (
      ownership.handoffs.some(
        (entry) =>
          entry.id !== options.request &&
          (!entry.outcome || handoffCancellationPending(dir, entry, deps.coordinationRoot())),
      )
    )
      throw new Error('진행 중인 인계를 먼저 완료하거나 취소해 주세요');

    const source = assertSource(ownership, options, journal);
    if (source.name !== options.bot) throw new Error('현재 운영 봇 이름과 달라요');
    if (journal) stage = options.cancel ? 'reconcile-edit' : 'verify';
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
    if (!options.cancel && attempt)
      receipt = readEditReceipt(coordination.dir, journal!.approval, attempt);
    const unresolved = journal?.editUncertain !== undefined || receipt?.outcome === 'dispatched';
    if (options.cancel || unresolved) stage = 'reconcile-edit';
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
    const approval = handoffApproval(dir, proposed);
    if (!options.approve) {
      return {
        ...base,
        status: journal || claim?.request === options.request ? 'partial' : 'ready',
        automationChatId: automation.chatId,
        schedule: automation.schedule,
        verifiedNextRunAt: automation.nextRunAt,
        approval,
        ...(attempt ? { editAttemptId: attempt } : {}),
        ...(receipt?.dispatchedAt ? { editDispatchedAt: receipt.dispatchedAt } : {}),
        ...(journal
          ? {
              retryStage:
                unresolved ||
                (automation.chatId === target.chatId && receipt?.outcome !== 'applied')
                  ? 'reconcile-edit'
                  : automation.chatId === target.chatId
                    ? 'verify'
                    : 'retarget',
            }
          : claim?.request === options.request
            ? { retryStage: 'write-intent' }
            : {}),
      };
    }
    if (approval !== options.approve)
      throw new Error('승인한 스냅샷이 바뀌었어요. 다시 미리보기를 확인해 주세요');
    if (unresolved) {
      stage = 'reconcile-edit';
      throw new Error(
        '이 요청의 Orca 편집 결과를 입증할 응답이 없어요. 같은 요청을 조회하거나 Orca 운영자에게 편집 시도 ID로 조사를 요청해 주세요',
      );
    }
    if (options.cancel) {
      if (!journal && claim?.request !== options.request)
        throw new Error('취소할 인계 요청이 없어요');
      stage = 'reconcile-edit';
      const verifyCancellationSchedule = (latest: ScheduledBotAutomation) => {
        verify(latest);
        if (latest.settings !== proposed.settings)
          throw new Error('취소 전에 승인된 Orca 자동화 설정을 복구해 주세요');
        if (latest.chatId !== source.chatId)
          throw new Error(
            receipt?.outcome === 'applied'
              ? '편집 응답을 확인했어요. 자동화를 기존 채팅으로 되돌린 뒤 취소해 주세요'
              : '자동화 대상이 기존 책임 채팅과 달라요. Orca에서 외부 편집을 확인하고 설정과 대상을 복구해 주세요',
          );
      };
      verifyCancellationSchedule(automation);
      const beforeChat = await show();
      observed = beforeChat;
      verifyCancellationSchedule(beforeChat);
      const receiving = await deps.chat(options.bot, source.chatId);
      if (receiving.botId !== source.botId || receiving.chatId !== source.chatId)
        throw new Error('취소 전에 기존 책임 채팅이 메일을 받을 수 있는지 확인해 주세요');
      observed = await show();
      verifyCancellationSchedule(observed);
      const lastReceiving = await deps.chat(options.bot, source.chatId);
      if (lastReceiving.botId !== receiving.botId || lastReceiving.chatId !== receiving.chatId)
        throw new Error('마지막 일정 조회 뒤 기존 책임 채팅이 메일을 받을 수 있는지 확인해 주세요');
      const currentClaim = coordination.read();
      if (digest(currentClaim ?? null) !== digest(claim ?? null))
        throw new Error('취소를 검증하는 동안 Orca 자동화의 담당 예약이 바뀌었어요');
      if (foreignClaim) {
        const foreign = readBotOwnership(foreignClaim.store);
        if (foreign.active?.chatId !== source.chatId || foreign.active.botId !== source.botId)
          throw new Error(
            `담당 저장소 ${foreignClaim.store}의 운영권과 현재 일정이 일치하는지 확인해 주세요`,
          );
        const foreignEdit = foreign.handoffs.find(
          (entry) =>
            entry.automationId === options.automation &&
            (!entry.outcome ||
              handoffCancellationPending(foreignClaim.store, entry, deps.coordinationRoot())),
        );
        const foreignReceipt = foreignEdit?.editAttempt
          ? readEditReceipt(coordination.dir, foreignEdit.approval, foreignEdit.editAttempt)
          : undefined;
        if (
          foreignEdit?.editUncertain !== undefined ||
          (foreignEdit?.editAttempt && (!foreignReceipt || foreignReceipt.outcome === 'dispatched'))
        )
          throw new Error('담당 저장소의 Orca 편집 결과를 확인한 뒤 취소해 주세요');
      }
      const current = readBotOwnership(dir);
      if (
        current.revision !== ownership.revision ||
        current.active?.chatId !== receiving.chatId ||
        current.active.botId !== receiving.botId
      )
        throw new Error('취소 전에 기존 책임 채팅의 운영권을 다시 확인해 주세요');
      verifyCancellationSchedule(beforeChat);
      verifyCancellationSchedule(observed);
      stage = 'cancel';
      const cancelRecord: BotHandoffRecord = journal ?? { ...proposed, approval };
      const { outcome: _outcome, cancelPending: _cancelPending, ...intent } = cancelRecord;
      if (ownsInitialClaim) {
        if (!journal?.cancelPending) save({ ...intent, cancelPending: true });
        coordination.releaseClaim(dir, intent);
      }
      save({ ...intent, outcome: 'cancelled' });
      return {
        ...base,
        status: 'cancelled',
        cancelScope: 'gestalt',
        orcaVerification: 'observed',
        automationChatId: observed.chatId,
      };
    }
    if (!journal) {
      stage = 'write-intent';
      const intent = { ...proposed, approval };
      save(intent);
    }
    stage = 'coordinate';
    if (!claim) coordination.claim(dir, { ...proposed, approval });
    let confirmed = automation;
    if (automation.chatId !== target.chatId) {
      if (!attempt || receipt) {
        stage = 'write-intent';
        attempt = randomUUID();
        save({ ...journal!, editAttempt: attempt });
      }
      stage = 'retarget';
      observed = undefined;
      let launchError: unknown;
      try {
        await deps.launchEdit({
          store: dir,
          coordinationDir: coordination.dir,
          request: options.request,
          approval,
          attempt,
        });
      } catch (error) {
        launchError = error;
      }
      receipt = readEditReceipt(coordination.dir, approval, attempt);
      if (receipt?.outcome !== 'applied') {
        stage = receipt?.outcome === 'dispatched' ? 'reconcile-edit' : 'retarget';
        throw new Error(
          receipt?.detail ??
            (launchError instanceof Error
              ? launchError.message
              : 'Orca 편집 응답을 아직 확인하지 못했어요'),
        );
      }
      stage = 'verify';
      observed = await show();
      verify(observed);
      if (observed.chatId !== target.chatId)
        throw new Error('Orca가 응답한 편집 대상을 다시 확인하지 못했어요');
      confirmed = observed;
    }
    if (receipt?.outcome !== 'applied') {
      stage = 'reconcile-edit';
      throw new Error(
        '새 대상이 조회됐지만 이 요청의 편집 응답이 없어요. Orca에서 요청을 확인해 주세요',
      );
    }
    stage = 'verify';
    const receiving = await deps.chat(options.bot, target.chatId);
    if (receiving.botId !== target.botId || receiving.chatId !== target.chatId)
      throw new Error('운영권을 넘기기 전에 인계 대상 채팅을 확인하지 못했어요');
    verify(confirmed);
    stage = 'commit-owner';
    const next = {
      ...ownership,
      active: target,
      retired: [...ownership.retired, source.chatId],
      revision: ownership.revision + 1,
    };
    const completed = {
      ...journal!,
      outcome: 'completed',
      nextRunAt: confirmed.nextRunAt,
    } as const;
    save(completed, next);
    return {
      ...recordResult(next, options, completed),
      schedule: confirmed.schedule,
    };
  } catch (error) {
    return {
      ...base,
      status: (journal && !journal.outcome) || settlingCancellation ? 'partial' : 'blocked',
      ...(observed ? { automationChatId: observed.chatId, schedule: observed.schedule } : {}),
      ...(journal?.editAttempt ? { editAttemptId: journal.editAttempt } : {}),
      ...(receipt?.dispatchedAt ? { editDispatchedAt: receipt.dispatchedAt } : {}),
      retryStage: stage,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (cancelLock?.ok) cancelLock.release();
  }
}
