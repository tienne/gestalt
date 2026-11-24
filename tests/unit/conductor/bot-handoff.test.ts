import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  conductorBotHandoffCommand,
  conductorStatusCommand,
} from '../../../src/cli/commands/conductor.js';
import { handoffBot } from '../../../src/conductor/bot-handoff.js';
import { automationCoordinationRoot } from '../../../src/conductor/bot-handoff-coordination.js';
import { runAutomationEdit } from '../../../src/conductor/bot-handoff-edit.js';
import {
  assertBotOwner,
  changeBotOwner,
  readBotOwnership,
  writeBotOwnership,
} from '../../../src/conductor/bot-owner.js';
import { acquireLock, tick } from '../../../src/conductor/engine.js';
import {
  OrcaAutomationEditRejected,
  readScheduledBotAutomation,
} from '../../../src/conductor/orca-automation.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import { loadConfig } from '../../../src/core/config.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';

vi.mock('../../../src/conductor/bot-handoff-coordination.js', async (original) => ({
  ...(await original<typeof import('../../../src/conductor/bot-handoff-coordination.js')>()),
  automationCoordinationRoot: vi.fn(),
}));

const source = { botId: 'ops-bot', name: 'Conductor', chatId: 'old-chat' };
const target = { ...source, chatId: 'new-chat' };
const options = {
  automation: 'existing-automation',
  bot: source.name,
  fromChat: source.chatId,
  chat: target.chatId,
  request: 'handoff-test',
};
const now = Date.parse('2026-11-25T00:00:00Z');
const nextRunAt = now + 25 * 60 * 1000;
const originalExitCode = process.exitCode;

function fixture() {
  const dir = tempStateDir();
  const automation = {
    id: options.automation,
    enabled: true,
    rrule: 'FREQ=MINUTELY;INTERVAL=25',
    precheck: { command: 'check-conductor', timeoutMs: 20_000 },
    prompt: 'Run the conductor check',
    nextRunAt,
    bot: {
      botId: source.botId,
      runsIn: 'chat',
      chat: { sessionId: source.chatId },
      resultsTo: 'none',
    },
  };
  // 기존 리비전 없는 운영권 파일도 그대로 인계할 수 있어야 한다.
  writeFileSync(join(dir, 'bot-owner.json'), JSON.stringify({ active: source, retired: [] }));
  const write = vi.fn(writeBotOwnership);
  const retarget = vi.fn(async (_id: string, chat: string) => {
    automation.bot.chat.sessionId = chat;
  });
  const deps = {
    chat: vi.fn(async (name: string, id: string) => ({ botId: source.botId, name, chatId: id })),
    show: vi.fn(async () => readScheduledBotAutomation({ automation })),
    retarget,
    launchEdit: (job: Parameters<typeof runAutomationEdit>[0]) => runAutomationEdit(job, retarget),
    write,
    now: () => now,
    coordinationRoot: () => join(dir, 'shared'),
  };
  const run = (overrides?: Partial<typeof options> & { approve?: string; cancel?: boolean }) =>
    handoffBot(dir, { ...options, ...overrides }, deps);
  const approval = async () => {
    const preview = await run();
    expect(preview).toMatchObject({
      status: 'ready',
      ownerRevision: 0,
      responsibleChatId: source.chatId,
      verifiedNextRunAt: nextRunAt,
    });
    expect(preview.approval).toBeTruthy();
    return preview.approval!;
  };
  return { dir, deps, automation, run, approval };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = originalExitCode;
  cleanupStateDirs();
});

describe('Orca 봇 정기 자동화 인계', () => {
  it('운영자 명령에서만 Orca CLI의 기존 자동화 대상 편집을 호출한다', async () => {
    const { automation, dir } = fixture();
    vi.mocked(automationCoordinationRoot).mockReturnValue(join(dir, 'shared'));
    automation.nextRunAt = Date.now() + 25 * 60 * 1000;
    const state = resolve(dir, 'automation.json');
    const edits = resolve(dir, 'edits.json');
    const orca = resolve(dir, 'orca.cjs');
    const mode = resolve(dir, 'mode');
    const closure = resolve(dir, 'closed');
    writeFileSync(state, JSON.stringify(automation));
    writeFileSync(mode, 'normal');
    writeFileSync(
      orca,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = ${JSON.stringify(state)};
const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8');
const closure = ${JSON.stringify(closure)};
const automation = JSON.parse(fs.readFileSync(state, 'utf8'));
const [group, action] = args;
const bots = [{ id: ${JSON.stringify(source.botId)}, name: ${JSON.stringify(source.name)}, paused: false }];
const chats = [
  { id: ${JSON.stringify(source.chatId)}, closed: false, self: true },
  { id: ${JSON.stringify(target.chatId)}, closed: mode !== 'normal' && fs.existsSync(closure) }
];
let result;
if (group === 'bot' && action === 'list') result = { bots };
else if (group === 'bot' && action === 'chats') result = { bot: bots[0].name, chats };
else if (group === 'automations' && action === 'show') {
  if (mode === 'close-on-show') fs.writeFileSync(closure, '');
  result = { automation };
}
else if (group === 'automations' && action === 'edit') {
  fs.writeFileSync(${JSON.stringify(edits)}, JSON.stringify(args));
  automation.bot.chat.sessionId = args[5].slice('chat:'.length);
  fs.writeFileSync(state, JSON.stringify(automation));
  if (mode === 'close-on-edit') fs.writeFileSync(closure, '');
  result = { automation };
} else process.exit(2);
console.log(JSON.stringify({ ok: true, result }));
`,
      { mode: 0o700 },
    );
    vi.stubEnv('ORCA_CLI_COMMAND', orca);
    vi.stubEnv('ORCA_AGENT_SESSION_TOOL_TOKEN', undefined);
    vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', undefined);
    vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const command = { ...options, json: true, stateDir: dir };
    const competingDir = tempStateDir();
    writeFileSync(
      join(competingDir, 'bot-owner.json'),
      JSON.stringify({ active: source, retired: [] }),
    );
    const competing = { ...command, stateDir: competingDir, request: 'competing-cli' };
    const last = () => JSON.parse(output.mock.lastCall![0] as string);
    await conductorBotHandoffCommand(command);
    const preview = last() as { approval: string };
    expect(preview).toMatchObject({ status: 'ready', approval: expect.any(String) });
    await conductorBotHandoffCommand(competing);
    const competingApproval = last().approval;
    expect(competingApproval).toEqual(expect.any(String));
    vi.stubEnv('ORCA_AGENT_SESSION_ID', source.chatId);
    await expect(
      conductorBotHandoffCommand({ ...command, approve: preview.approval }),
    ).rejects.toThrow('exit');
    expect(() => readFileSync(edits)).toThrow();

    vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined);
    writeFileSync(mode, 'close-on-edit');
    await conductorBotHandoffCommand({ ...command, approve: preview.approval });
    expect(last()).toMatchObject({ status: 'partial', retryStage: 'verify' });
    const attempt = last().editAttemptId;
    conductorStatusCommand({ stateDir: dir, json: true });
    expect(last()).toMatchObject({
      conductor: { botHandoff: { status: 'partial', editAttemptId: attempt } },
    });
    await conductorBotHandoffCommand({ ...competing, approve: competingApproval });
    expect(last()).toMatchObject({ status: 'blocked', retryStage: 'coordinate' });

    rmSync(closure);
    writeFileSync(mode, 'close-on-show');
    await conductorBotHandoffCommand({ ...command, approve: preview.approval });
    expect(last()).toMatchObject({
      status: 'partial',
      retryStage: 'verify',
      responsibleChatId: source.chatId,
    });
    writeFileSync(mode, 'normal');
    await conductorBotHandoffCommand({ ...command, approve: preview.approval });
    expect(last()).toMatchObject({
      status: 'completed',
      automationChatId: target.chatId,
      responsibleChatId: target.chatId,
    });
    expect(JSON.parse(readFileSync(edits, 'utf8'))).toEqual([
      'automations',
      'edit',
      '--id',
      options.automation,
      '--runs-in',
      `chat:${target.chatId}`,
      '--environment',
      'local',
      '--json',
    ]);
    conductorStatusCommand({ stateDir: dir, json: true });
    expect(last()).toMatchObject({
      conductor: { botHandoff: { requestId: options.request, status: 'completed' } },
    });
  }, 15_000);

  it('한 번 승인하면 같은 ID와 설정을 유지하고 다음 실행과 새 책임 채팅을 확인한다', async () => {
    const { dir, deps, automation, run, approval } = fixture();
    const approve = await approval();
    const before = structuredClone(automation);
    expect(deps.write).not.toHaveBeenCalled();
    const result = await run({ approve });
    expect(result).toMatchObject({
      status: 'completed',
      automationId: before.id,
      automationChatId: target.chatId,
      responsibleChatId: target.chatId,
      ownerRevision: 1,
      schedule: before.rrule,
      verifiedNextRunAt: nextRunAt,
    });
    before.bot.chat.sessionId = target.chatId;
    expect(automation).toEqual(before);
    expect(await run({ approve })).toMatchObject({ status: 'completed', replayed: true });
    expect(deps.retarget).toHaveBeenCalledExactlyOnceWith(options.automation, target.chatId);
    expect(readBotOwnership(dir).handoffs).toHaveLength(1);
  });

  it.each(['closed', 'foreign-bot', 'other-id', 'wrong-target', 'disabled', 'no-next-run'])(
    '사전 검증에서 %s 조건을 발견하면 쓰지 않는다',
    async (failure) => {
      const { deps, automation, run } = fixture();
      if (failure === 'closed') deps.chat.mockRejectedValueOnce(new Error('채팅 닫힘'));
      if (failure === 'foreign-bot') automation.bot.botId = 'other-bot';
      if (failure === 'other-id') automation.id = 'other-automation';
      if (failure === 'wrong-target') automation.bot.chat.sessionId = 'other-chat';
      if (failure === 'disabled') automation.enabled = false;
      if (failure === 'no-next-run') automation.nextRunAt = now;
      expect(await run()).toMatchObject({ status: 'blocked', retryStage: 'preflight' });
      expect(deps.retarget).not.toHaveBeenCalled();
      expect(deps.write).not.toHaveBeenCalled();
    },
  );

  it('승인 사이 설정이나 운영권 리비전이 바뀌면 이전 승인값을 거절한다', async () => {
    const { dir, deps, automation, run, approval } = fixture();
    const approve = await approval();
    automation.precheck.command = 'changed';
    expect(await run({ approve })).toMatchObject({ status: 'blocked', retryStage: 'preflight' });
    automation.precheck.command = 'check-conductor';
    writeBotOwnership(dir, { ...readBotOwnership(dir), revision: 1 });
    expect(await run({ approve })).toMatchObject({ status: 'blocked', retryStage: 'preflight' });
    expect(deps.retarget).not.toHaveBeenCalled();
  });

  it.each(['write-intent', 'retarget', 'verify', 'commit-owner'] as const)(
    '%s 실패 후 기존 채팅에 책임을 남기고 같은 요청으로 끝낸다',
    async (stage) => {
      const { dir, deps, automation, run, approval } = fixture();
      const approve = await approval();
      const fail = () => {
        throw new Error('injected failure');
      };
      if (stage === 'write-intent') deps.write.mockImplementationOnce(fail);
      if (stage === 'retarget')
        deps.retarget.mockRejectedValueOnce(new OrcaAutomationEditRejected('접근 거절'));
      if (stage === 'verify') {
        deps.show.mockImplementationOnce(async () => readScheduledBotAutomation({ automation }));
        deps.show.mockImplementationOnce(fail);
      }
      if (stage === 'commit-owner')
        deps.write.mockImplementation((path, value) => {
          if (value.active?.chatId === target.chatId) {
            deps.write.mockImplementation(writeBotOwnership);
            return fail();
          }
          writeBotOwnership(path, value);
        });
      const result = await run({ approve });
      expect(result).toMatchObject({
        status: stage === 'write-intent' ? 'blocked' : 'partial',
        retryStage: stage,
        responsibleChatId: source.chatId,
      });
      expect(() => assertBotOwner(dir, source)).not.toThrow();
      expect(() => assertBotOwner(dir, target)).toThrow('운영권');
      if (stage !== 'write-intent') {
        expect(() => changeBotOwner(dir, source.chatId)).toThrow('진행 중');
        expect(await run({ request: 'other-request' })).toMatchObject({ status: 'blocked' });
      }
      expect(await run({ approve })).toMatchObject({ status: 'completed' });
      expect(deps.retarget).toHaveBeenCalledTimes(stage === 'retarget' ? 2 : 1);
    },
  );

  it('편집 응답이 끊기면 새 대상이 보여도 해당 요청의 운영권을 확정하지 않는다', async () => {
    const { deps, automation, run, approval } = fixture();
    const approve = await approval();
    deps.retarget.mockImplementationOnce(async (_id, chat) => {
      automation.bot.chat.sessionId = chat;
      throw new Error('connection closed');
    });
    expect(await run({ approve })).toMatchObject({
      status: 'partial',
      retryStage: 'reconcile-edit',
    });
    expect(await run({ approve })).toMatchObject({
      status: 'partial',
      retryStage: 'reconcile-edit',
      automationChatId: target.chatId,
      responsibleChatId: source.chatId,
    });
    expect(deps.retarget).toHaveBeenCalledTimes(1);
  });

  it('편집 도중 새 채팅이 닫히면 운영권을 유지하고 채팅이 준비된 뒤 이어 간다', async () => {
    const { deps, dir, automation, run, approval } = fixture();
    const approve = await approval();
    deps.retarget.mockImplementationOnce(async (_id, chat) => {
      automation.bot.chat.sessionId = chat;
      deps.chat.mockRejectedValueOnce(new Error('채팅 닫힘'));
    });
    expect(await run({ approve })).toMatchObject({
      status: 'partial',
      retryStage: 'verify',
      automationChatId: target.chatId,
      responsibleChatId: source.chatId,
    });
    expect(readBotOwnership(dir).active).toEqual(source);
    expect(await run({ approve })).toMatchObject({ status: 'completed' });
    expect(deps.retarget).toHaveBeenCalledTimes(1);
  });

  it('이미 편집된 요청도 운영권 확정 직전에 새 채팅이 닫히면 책임 채팅을 유지한다', async () => {
    const { deps, dir, automation, run, approval } = fixture();
    const approve = await approval();
    deps.retarget.mockImplementationOnce(async (_id, chat) => {
      automation.bot.chat.sessionId = chat;
      deps.chat.mockRejectedValueOnce(new Error('첫 검증에서 닫힘'));
    });
    expect(await run({ approve })).toMatchObject({ status: 'partial', retryStage: 'verify' });
    deps.chat.mockResolvedValueOnce(target).mockRejectedValueOnce(new Error('재시도 중에 닫힘'));
    expect(await run({ approve })).toMatchObject({
      status: 'partial',
      retryStage: 'verify',
      automationChatId: target.chatId,
      responsibleChatId: source.chatId,
    });
    expect(readBotOwnership(dir).active).toEqual(source);
    expect(await run({ approve })).toMatchObject({ status: 'completed' });
    expect(deps.retarget).toHaveBeenCalledTimes(1);
  });

  it('다른 편집과 늦은 반영은 이 요청의 응답이 없어 재편집과 최종 취소를 막는다', async () => {
    const { deps, dir, automation, run, approval } = fixture();
    const approve = await approval();
    deps.retarget.mockRejectedValueOnce(new Error('응답 시간 초과'));
    const first = await run({ approve });
    expect(first).toMatchObject({
      status: 'partial',
      retryStage: 'reconcile-edit',
      editAttemptId: expect.any(String),
    });
    expect(await run({ approve, cancel: true })).toMatchObject({
      status: 'partial',
      retryStage: 'reconcile-edit',
      responsibleChatId: source.chatId,
    });
    expect(await run({ approve })).toMatchObject({
      status: 'partial',
      retryStage: 'reconcile-edit',
    });
    expect(readBotOwnership(dir).handoffs[0]).toMatchObject({ editAttempt: first.editAttemptId });
    vi.mocked(automationCoordinationRoot).mockReturnValue(join(dir, 'shared'));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    conductorStatusCommand({ stateDir: dir, json: true });
    expect(JSON.parse(output.mock.lastCall![0] as string)).toMatchObject({
      conductor: {
        botHandoff: {
          retryStage: 'reconcile-edit',
          editReceipt: 'dispatched',
          editAttemptId: first.editAttemptId,
          editDispatchedAt: expect.any(String),
        },
      },
    });
    expect(deps.retarget).toHaveBeenCalledTimes(1);
    automation.bot.chat.sessionId = target.chatId;
    expect(await run({ approve, cancel: true })).toMatchObject({
      status: 'partial',
      retryStage: 'reconcile-edit',
      automationChatId: target.chatId,
    });
    automation.bot.chat.sessionId = source.chatId;
    expect(await run({ approve, cancel: true })).toMatchObject({
      status: 'partial',
      retryStage: 'reconcile-edit',
    });
    expect(readBotOwnership(dir).handoffs[0]?.outcome).toBeUndefined();
  });

  it('서로 다른 저장소가 같은 자동화에 경합하면 최초 저장소만 인계를 확정한다', async () => {
    const { deps, dir, automation, run, approval } = fixture();
    const other = tempStateDir();
    writeFileSync(join(other, 'bot-owner.json'), JSON.stringify({ active: source, retired: [] }));
    const competing = { ...options, request: 'competing-handoff', chat: 'other-chat' };
    const runOther = (approve?: string) =>
      handoffBot(other, { ...competing, ...(approve ? { approve } : {}) }, deps);
    const approve = await approval();
    const preview = await runOther();
    expect(preview.status).toBe('ready');
    deps.retarget.mockImplementationOnce(async (_id, chat) => {
      expect(await runOther(preview.approval)).toMatchObject({
        status: 'blocked',
        retryStage: 'coordinate',
      });
      automation.bot.chat.sessionId = chat;
    });
    expect(await run({ approve })).toMatchObject({ status: 'completed' });
    automation.bot.chat.sessionId = source.chatId;
    expect(await runOther(preview.approval)).toMatchObject({
      status: 'blocked',
      retryStage: 'coordinate',
      detail: expect.stringContaining(options.request),
    });
    expect(readBotOwnership(dir).active).toEqual(target);
    expect(readBotOwnership(other).active).toEqual(source);
    expect(deps.retarget).toHaveBeenCalledTimes(1);
  });

  it('Orca에 도달하지 못한 첫 요청을 취소하면 공유 담당 기록도 해제한다', async () => {
    const { deps, run, approval } = fixture();
    const approve = await approval();
    deps.retarget.mockRejectedValueOnce(new OrcaAutomationEditRejected('접근 거절'));
    expect(await run({ approve })).toMatchObject({ status: 'partial', retryStage: 'retarget' });
    const other = tempStateDir();
    writeFileSync(join(other, 'bot-owner.json'), JSON.stringify({ active: source, retired: [] }));
    const competing = { ...options, request: 'after-cancel' };
    expect(await handoffBot(other, competing, deps)).toMatchObject({ status: 'blocked' });
    expect(await run({ approve, cancel: true })).toMatchObject({ status: 'cancelled' });
    const preview = await handoffBot(other, competing, deps);
    expect(preview.status).toBe('ready');
    expect(
      await handoffBot(other, { ...competing, approve: preview.approval! }, deps),
    ).toMatchObject({ status: 'completed' });
  });

  it('편집 뒤 보고 정책이 달라졌으면 책임을 유지하고 운영자가 복구한 뒤 취소할 수 있다', async () => {
    const { dir, deps, automation, run, approval } = fixture();
    const approve = await approval();
    deps.retarget.mockImplementationOnce(async (_id, chat) => {
      automation.bot.chat.sessionId = chat;
      automation.bot.resultsTo = 'chat';
    });
    expect(await run({ approve })).toMatchObject({ status: 'partial', retryStage: 'verify' });
    expect(await run({ approve, cancel: true })).toMatchObject({ status: 'partial' });
    automation.bot.chat.sessionId = source.chatId;
    automation.bot.resultsTo = 'none';
    expect(await run({ approve, cancel: true })).toMatchObject({
      status: 'cancelled',
      responsibleChatId: source.chatId,
    });
    expect(await run({ approve })).toMatchObject({ status: 'cancelled', replayed: true });
    expect(readBotOwnership(dir).active).toEqual(source);
    expect(deps.retarget).toHaveBeenCalledTimes(1);
  });

  it('동시 요청과 두 채팅의 tick이 같은 잠금을 사용한다', async () => {
    const { dir, deps, automation, run, approval } = fixture();
    const approve = await approval();
    const store = ConductorStore.open(dir);
    const engine = { config: loadConfig().conductor, env: {}, launchers: {}, orcaAvailable: false };
    const operate = (owner: typeof source) =>
      tick(store, engine, { force: true, admit: () => assertBotOwner(dir, owner) });
    const held = acquireLock(dir);
    if (!held.ok) throw new Error('fixture lock');
    try {
      expect(await run({ approve })).toMatchObject({ status: 'blocked' });
    } finally {
      held.release();
    }
    deps.retarget.mockImplementationOnce(async (_id, chat) => {
      expect(await run({ approve })).toMatchObject({ status: 'blocked' });
      expect(await operate(source)).toMatchObject({ skipped: true });
      expect(await operate(target)).toMatchObject({ skipped: true });
      automation.bot.chat.sessionId = chat;
    });
    expect(await run({ approve })).toMatchObject({ status: 'completed' });
    await expect(operate(source)).rejects.toThrow('인계한');
    await expect(operate(target)).resolves.not.toHaveProperty('skipped', true);
    expect(deps.retarget).toHaveBeenCalledTimes(1);
  });
});
