import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAutomationClaim } from '../../../src/conductor/bot-handoff-coordination.js';
import { readEditReceipt } from '../../../src/conductor/bot-handoff-edit.js';
import { handoffApproval } from '../../../src/conductor/bot-handoff-record.js';
import {
  changeBotOwner,
  readBotOwnership,
  writeBotOwnership,
} from '../../../src/conductor/bot-owner.js';
import { digest } from '../../../src/conductor/orca-automation.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';

const source = { botId: 'test-bot', name: 'Conductor', chatId: 'source-chat' };
const options = {
  request: 'interrupted-handoff',
  automation: 'isolated-automation',
  bot: source.name,
  fromChat: source.chatId,
  chat: 'destination-chat',
};
const sourceModule = (name: string) =>
  new URL(`../../../src/conductor/${name}.ts`, import.meta.url).href;
const tsxLoader = createRequire(import.meta.url).resolve('tsx');
const runner = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { handoffBot } from ${JSON.stringify(sourceModule('bot-handoff'))};
import { automationCoordinationDir } from ${JSON.stringify(sourceModule('bot-handoff-coordination'))};
import { launchAutomationEdit } from ${JSON.stringify(sourceModule('bot-handoff-edit'))};
import { changeBotOwner, writeBotOwnership } from ${JSON.stringify(sourceModule('bot-owner'))};
import { readScheduledBotAutomation } from ${JSON.stringify(sourceModule('orca-automation'))};
const { dir, shared, schedule, editing, options, phase, source } = JSON.parse(process.argv[1]);
const killSelf = () => process.kill(process.pid, 'SIGKILL');
let reads = 0;
let chats = 0;
let closed = false;
let clock;
if (phase === 'owner-release' || phase === 'owner-bind') {
  try {
    changeBotOwner(dir, source.chatId, phase === 'owner-bind' ? { ...source, chatId: options.chat } : undefined, shared);
    console.log(JSON.stringify({ status: 'owner-changed' }));
  } catch (error) {
    console.log(JSON.stringify({ status: 'blocked', detail: error.message }));
  }
  process.exit(0);
}
const result = await handoffBot(dir, options, {
  coordinationRoot: () => shared,
  now: () => clock ?? Date.now(),
  chat: async (name, chatId) => {
    if (phase === 'no-orca-reads') throw new Error('Orca를 조회하면 안 된다');
    ++chats;
    if (closed || (phase === 'cancel-source-closes' && chats === 2)) throw new Error('기존 채팅 닫힘');
    if (chats === 2 && ['cancel-last-chat-moves', 'cancel-last-chat-expires'].includes(phase)) {
      const automation = JSON.parse(readFileSync(schedule, 'utf8'));
      if (phase === 'cancel-last-chat-moves') {
        automation.bot.chat.sessionId = options.chat;
        writeFileSync(schedule, JSON.stringify(automation));
      } else {
        clock = automation.nextRunAt + 1;
        automation.nextRunAt = clock + 1_000;
        writeFileSync(schedule, JSON.stringify(automation));
      }
    }
    return { name, chatId, botId: source.botId };
  },
  show: async () => {
    if (phase === 'no-orca-reads') throw new Error('Orca를 조회하면 안 된다');
    const automation = JSON.parse(readFileSync(schedule, 'utf8'));
    ++reads;
    if (phase === 'cancel-late-move' && reads === 2) {
      automation.bot.chat.sessionId = options.chat;
      writeFileSync(schedule, JSON.stringify(automation));
    }
    if (phase === 'cancel-last-show-closes-source' && reads === 2) closed = true;
    if (phase === 'cancel-third-show-closes-source' && reads === 3) closed = true;
    if (phase === 'cancel-claim-changes' && reads === 2)
      writeFileSync(join(automationCoordinationDir(shared, options.automation), 'claim.json'),
        JSON.stringify({ store: join(dir, 'another-store'), request: 'another-owner' }));
    const record = readScheduledBotAutomation({ automation });
    if (phase === 'shared-only') {
      const intent = {
        id: options.request, approval: options.approve, automationId: options.automation,
        from: options.fromChat, to: options.chat, botId: source.botId,
        settings: record.settings, revision: 0,
      };
      writeFileSync(join(automationCoordinationDir(shared, options.automation), 'claim.json'),
        JSON.stringify({ store: dir, request: options.request, intent }));
      killSelf();
    }
    return record;
  },
  write: (dir, value) => {
    if (phase === 'after-claim' && value.handoffs.some(record => record.editAttempt)) killSelf();
    if (phase === 'after-clear' && value.handoffs.some(record => record.outcome === 'cancelled')) killSelf();
    writeBotOwnership(dir, value);
    if (phase === 'before-claim') killSelf();
    if (phase === 'before-clear' && value.handoffs.some(record => record.cancelPending)) killSelf();
  },
  launchEdit: async (job) => {
    if (phase === 'before-edit') killSelf();
    const launched = launchAutomationEdit(job);
    if (phase === 'during-edit') {
      while (!existsSync(editing)) await delay(10);
      killSelf();
    }
    await launched;
  },
});
console.log(JSON.stringify(result));
`;

interface Result {
  status: string;
  approval?: string;
  editAttemptId?: string;
}

function fixture() {
  const dir = resolve(tempStateDir());
  const schedule = join(dir, 'automation.json');
  const shared = join(dir, 'shared');
  const editing = join(dir, 'editing');
  const release = join(dir, 'release');
  const orca = join(dir, 'orca.cjs');
  const automation = {
    id: options.automation,
    enabled: true,
    rrule: 'FREQ=MINUTELY;INTERVAL=25',
    nextRunAt: Date.now() + 25 * 60_000,
    bot: {
      botId: source.botId,
      runsIn: 'chat',
      chat: { sessionId: source.chatId },
      resultsTo: 'none',
    },
  };
  const setChat = (sessionId: string) => {
    automation.bot.chat.sessionId = sessionId;
    writeFileSync(schedule, JSON.stringify(automation));
  };
  setChat(source.chatId);
  writeFileSync(join(dir, 'bot-owner.json'), JSON.stringify({ active: source, retired: [] }));
  writeFileSync(
    orca,
    `#!/usr/bin/env node
const fs = require('node:fs');
const delay = require('node:timers/promises').setTimeout;
const [group, command, flag, id, mode, destination] = process.argv.slice(2);
const file = ${JSON.stringify(schedule)};
const editing = ${JSON.stringify(editing)};
const release = ${JSON.stringify(release)};
(async () => {
  if (group !== 'automations' || command !== 'edit' || flag !== '--id' ||
      id !== ${JSON.stringify(options.automation)} || mode !== '--runs-in') process.exit(2);
  fs.appendFileSync(editing, 'edit\\n');
  if (process.env.HANDOFF_FIXTURE_MODE === 'lost') process.exit(1);
  if (process.env.HANDOFF_FIXTURE_MODE === 'hold') {
    while (!fs.existsSync(release)) await delay(10);
  }
  const automation = JSON.parse(fs.readFileSync(file, 'utf8'));
  automation.bot.chat.sessionId = destination.slice('chat:'.length);
  fs.writeFileSync(file, JSON.stringify(automation));
  if (process.env.HANDOFF_FIXTURE_MODE === 'mismatch') automation.id = 'different-automation';
  console.log(JSON.stringify({ ok: true, result: { automation } }));
})().catch(() => { process.exitCode = 1; });
`,
    { mode: 0o700 },
  );
  const invoke = (
    input: {
      approve?: string;
      cancel?: boolean;
      phase?: string;
      mode?: string;
      store?: string;
      request?: string;
    } = {},
  ) => {
    const { phase, mode, store, ...flags } = input;
    const data = JSON.stringify({
      dir: store ?? dir,
      shared,
      schedule,
      editing,
      source,
      phase,
      options: { ...options, ...flags },
    });
    const env = { ...process.env, ORCA_CLI_COMMAND: orca, HANDOFF_FIXTURE_MODE: mode };
    delete env['ORCA_AGENT_SESSION_ID'];
    delete env['ORCA_AGENT_SESSION_TOOL_TOKEN'];
    delete env['GESTALT_CONDUCTOR_WORKER_ID'];
    return new Promise<Result | 'killed'>((resolve, reject) => {
      execFile(
        process.execPath,
        ['--import', tsxLoader, '--input-type=module', '-e', runner, data],
        { env, timeout: 15_000 },
        (error, stdout, stderr) => {
          if (error?.signal === 'SIGKILL') resolve('killed');
          else if (error) reject(new Error(stderr || error.message));
          else resolve(JSON.parse(stdout) as Result);
        },
      );
    });
  };
  const approve = async () => {
    const preview = await invoke();
    expect(preview).toMatchObject({ status: 'ready', approval: expect.any(String) });
    return (preview as Result).approval!;
  };
  return { dir, shared, schedule, editing, release, invoke, approve, setChat };
}

afterEach(cleanupStateDirs);

describe('Orca 인계 프로세스 중단 복구', () => {
  it.each(['before-claim', 'after-claim', 'before-edit', 'shared-only'])(
    '%s에서 프로세스가 멈춰도 같은 요청을 재개해 편집을 한 번만 보낸다',
    async (phase) => {
      const { dir, editing, invoke, approve } = fixture();
      const approval = await approve();
      expect(await invoke({ approve: approval, phase })).toBe('killed');
      expect(existsSync(editing)).toBe(false);
      const attempt = readBotOwnership(dir).handoffs[0]?.editAttempt;
      expect(await invoke({ approve: approval })).toMatchObject({ status: 'completed' });
      if (attempt) expect(readBotOwnership(dir).handoffs[0]?.editAttempt).toBe(attempt);
      expect(readFileSync(editing, 'utf8')).toBe('edit\n');
    },
    20_000,
  );

  it.each(['after-claim', 'before-edit', 'shared-only'])(
    '%s에서 멈춘 요청은 Orca 편집을 보내지 않고 취소한 뒤 운영권을 해제할 수 있다',
    async (phase) => {
      const { dir, editing, invoke, approve } = fixture();
      const approval = await approve();
      expect(await invoke({ approve: approval, phase })).toBe('killed');
      expect(await invoke({ approve: approval, cancel: true })).toMatchObject({
        status: 'cancelled',
      });
      changeBotOwner(dir, source.chatId);
      expect(readBotOwnership(dir).active).toBeUndefined();
      expect(existsSync(editing)).toBe(false);
    },
    20_000,
  );

  it.each(['after-claim', 'before-edit', 'shared-only'])(
    '%s에서 외부 편집으로 대상이 바뀌면 기존 책임 채팅으로 돌아오기 전까지 취소를 보류한다',
    async (phase) => {
      const { dir, shared, editing, invoke, approve, setChat } = fixture();
      const approval = await approve();
      expect(await invoke({ approve: approval, phase })).toBe('killed');
      const claimDir = join(shared, digest(options.automation));
      setChat(options.chat);
      expect(await invoke({ approve: approval, cancel: true })).toMatchObject({
        status: 'partial',
        retryStage: 'reconcile-edit',
        automationChatId: options.chat,
        responsibleChatId: source.chatId,
      });
      setChat(source.chatId);
      expect(
        await invoke({ approve: approval, cancel: true, phase: 'cancel-late-move' }),
      ).toMatchObject({
        status: 'partial',
        retryStage: 'reconcile-edit',
        automationChatId: options.chat,
      });
      setChat(source.chatId);
      expect(
        await invoke({ approve: approval, cancel: true, phase: 'cancel-source-closes' }),
      ).toMatchObject({
        status: 'partial',
        retryStage: 'reconcile-edit',
      });
      expect(
        await invoke({ approve: approval, cancel: true, phase: 'cancel-last-show-closes-source' }),
      ).toMatchObject({ status: 'partial', retryStage: 'reconcile-edit' });
      expect(readAutomationClaim(claimDir)?.store).toBe(dir);
      expect(() => changeBotOwner(dir, source.chatId)).toThrow('진행 중');
      expect(await invoke({ approve: approval, cancel: true })).toMatchObject({
        status: 'cancelled',
        automationChatId: source.chatId,
      });
      expect(readAutomationClaim(claimDir)).toBeUndefined();
      expect(existsSync(editing)).toBe(false);
    },
    25_000,
  );

  it('다른 저장소가 인계한 자동화는 옛 로컬 요청의 취소도 보류한다', async () => {
    const { dir, shared, invoke, approve, editing } = fixture();
    const approval = await approve();
    expect(await invoke({ approve: approval, phase: 'before-claim' })).toBe('killed');
    const other = resolve(tempStateDir());
    writeFileSync(join(other, 'bot-owner.json'), JSON.stringify({ active: source, retired: [] }));
    const preview = (await invoke({ store: other })) as Result;
    expect(preview).toMatchObject({ status: 'ready' });
    expect(await invoke({ store: other, approve: preview.approval! })).toMatchObject({
      status: 'completed',
    });
    const claimDir = join(shared, digest(options.automation));
    const foreignClaim = readAutomationClaim(claimDir);
    const cancelled = await invoke({ approve: approval, cancel: true });
    expect(cancelled).toMatchObject({
      status: 'partial',
      retryStage: 'reconcile-edit',
      automationChatId: options.chat,
    });
    expect(readAutomationClaim(claimDir)).toEqual(foreignClaim);
    expect(() => changeBotOwner(dir, source.chatId)).toThrow('진행 중');
    expect(await invoke({ store: other, approve: preview.approval! })).toMatchObject({
      status: 'completed',
      replayed: true,
    });
    expect(readFileSync(editing, 'utf8')).toBe('edit\n');
  }, 20_000);

  it('다른 저장소가 같은 책임 채팅을 유지할 때 옛 로컬 요청만 취소한다', async () => {
    const { dir, shared, invoke, approve, editing } = fixture();
    const approval = await approve();
    expect(await invoke({ approve: approval, phase: 'before-claim' })).toBe('killed');
    const other = resolve(tempStateDir());
    writeFileSync(join(other, 'bot-owner.json'), JSON.stringify({ active: source, retired: [] }));
    const preview = (await invoke({ store: other })) as Result;
    expect(await invoke({ store: other, approve: preview.approval!, phase: 'after-claim' })).toBe(
      'killed',
    );
    const claimDir = join(shared, digest(options.automation));
    const foreignClaim = readAutomationClaim(claimDir);
    expect(foreignClaim?.store).toBe(other);
    expect(await invoke({ approve: approval, cancel: true })).toMatchObject({
      status: 'cancelled',
      automationChatId: source.chatId,
    });
    expect(readAutomationClaim(claimDir)).toEqual(foreignClaim);
    changeBotOwner(dir, source.chatId);
    expect(await invoke({ store: other, approve: preview.approval! })).toMatchObject({
      status: 'completed',
    });
    expect(readFileSync(editing, 'utf8')).toBe('edit\n');
  }, 20_000);

  it('다른 저장소의 편집 응답 대기 중에는 대상이 기존 채팅이어도 취소를 보류한다', async () => {
    const { shared, release, invoke, approve } = fixture();
    const approval = await approve();
    expect(await invoke({ approve: approval, phase: 'before-claim' })).toBe('killed');
    const other = resolve(tempStateDir());
    writeFileSync(join(other, 'bot-owner.json'), JSON.stringify({ active: source, retired: [] }));
    const preview = (await invoke({ store: other })) as Result;
    try {
      expect(
        await invoke({
          store: other,
          approve: preview.approval!,
          phase: 'during-edit',
          mode: 'hold',
        }),
      ).toBe('killed');
      const claimDir = join(shared, digest(options.automation));
      const foreignClaim = readAutomationClaim(claimDir);
      expect(await invoke({ approve: approval, cancel: true })).toMatchObject({
        status: 'partial',
        retryStage: 'reconcile-edit',
        automationChatId: source.chatId,
      });
      expect(readAutomationClaim(claimDir)).toEqual(foreignClaim);
      writeFileSync(release, '');
      const attempt = readBotOwnership(other).handoffs[0]?.editAttempt;
      await vi.waitFor(() =>
        expect(readEditReceipt(claimDir, preview.approval!, attempt!)).toMatchObject({
          outcome: 'applied',
        }),
      );
    } finally {
      writeFileSync(release, '');
    }
  }, 20_000);

  it('취소를 검증하는 중 담당 예약이 달라지면 새 예약을 지우지 않는다', async () => {
    const { shared, invoke, approve } = fixture();
    const approval = await approve();
    expect(await invoke({ approve: approval, phase: 'after-claim' })).toBe('killed');
    expect(
      await invoke({ approve: approval, cancel: true, phase: 'cancel-claim-changes' }),
    ).toMatchObject({ status: 'partial', retryStage: 'reconcile-edit' });
    expect(readAutomationClaim(join(shared, digest(options.automation)))?.request).toBe(
      'another-owner',
    );
  }, 20_000);

  it('취소 저장 후 예약 해제 전에 중단된 요청도 현재 일정을 다시 대조한다', async () => {
    const { dir, shared, invoke, approve, setChat } = fixture();
    const approval = await approve();
    const competing = (await invoke({ request: 'next-handoff' })) as Result;
    expect(await invoke({ approve: approval, phase: 'after-claim' })).toBe('killed');
    const claimDir = join(shared, digest(options.automation));
    const claim = readAutomationClaim(claimDir);
    const ownership = readBotOwnership(dir);
    writeBotOwnership(dir, {
      ...ownership,
      handoffs: [{ ...ownership.handoffs[0]!, outcome: 'cancelled' }],
    });
    expect(await invoke()).toMatchObject({ status: 'partial', retryStage: 'reconcile-edit' });
    expect(await invoke({ approve: approval })).toMatchObject({ status: 'partial' });
    expect(await invoke({ request: 'next-handoff' })).toMatchObject({ status: 'blocked' });
    expect(await invoke({ request: 'next-handoff', approve: competing.approval! })).toMatchObject({
      status: 'blocked',
    });
    expect(await invoke({ phase: 'owner-release' })).toMatchObject({ status: 'blocked' });
    expect(await invoke({ phase: 'owner-bind' })).toMatchObject({ status: 'blocked' });
    setChat(options.chat);
    expect(await invoke({ approve: approval, cancel: true })).toMatchObject({
      status: 'partial',
      retryStage: 'reconcile-edit',
      automationChatId: options.chat,
    });
    expect(readAutomationClaim(claimDir)).toEqual(claim);
    setChat(source.chatId);
    expect(await invoke({ approve: approval, cancel: true })).toMatchObject({
      status: 'cancelled',
    });
    expect(readAutomationClaim(claimDir)).toBeUndefined();
  }, 20_000);

  it.each(['before-clear', 'after-clear'])(
    '%s에서 중단된 취소는 재시작 뒤 조회와 새 작업을 대기시키고 같은 승인으로 회복한다',
    async (phase) => {
      const { dir, shared, invoke, approve, setChat, editing } = fixture();
      const approval = await approve();
      expect(await invoke({ approve: approval, phase: 'after-claim' })).toBe('killed');
      expect(await invoke({ approve: approval, cancel: true, phase })).toBe('killed');
      const claimDir = join(shared, digest(options.automation));
      const claim = readAutomationClaim(claimDir);
      expect(Boolean(claim)).toBe(phase === 'before-clear');
      const pending = readBotOwnership(dir).handoffs[0];
      expect(pending?.cancelPending).toBe(true);
      expect(pending?.outcome).toBeUndefined();
      expect(await invoke()).toMatchObject({ status: 'partial', retryStage: 'reconcile-edit' });
      expect(await invoke({ request: 'next-handoff' })).toMatchObject({ status: 'blocked' });
      expect(await invoke({ phase: 'owner-release' })).toMatchObject({ status: 'blocked' });
      setChat(options.chat);
      if (phase === 'before-clear') {
        expect(await invoke({ approve: approval, cancel: true })).toMatchObject({
          status: 'partial',
          retryStage: 'reconcile-edit',
          automationChatId: options.chat,
        });
        expect(readAutomationClaim(claimDir)).toEqual(claim);
        setChat(source.chatId);
        expect(await invoke({ approve: approval, cancel: true })).toMatchObject({
          status: 'cancelled',
          cancelScope: 'gestalt',
          orcaVerification: 'observed',
        });
      } else {
        const result = await invoke({ approve: approval, cancel: true, phase: 'no-orca-reads' });
        expect(result).toMatchObject({
          status: 'cancelled',
          cancelScope: 'gestalt',
          orcaVerification: 'not-checked',
        });
        expect(result).not.toHaveProperty('automationChatId');
      }
      expect(await invoke()).toMatchObject({ status: 'cancelled', replayed: true });
      expect(readAutomationClaim(claimDir)).toBeUndefined();
      expect(await invoke({ phase: 'owner-release' })).toMatchObject({ status: 'owner-changed' });
      expect(existsSync(editing)).toBe(false);
    },
    25_000,
  );

  it.each(['reserved', 'completed', 'legacy-completed'])(
    '예약 해제 뒤 %s인 다른 저장소와 Orca 일정을 보존하며 로컬 취소 복구를 끝낸다',
    async (foreignStatus) => {
      const { dir, shared, invoke, approve, editing } = fixture();
      const approval = await approve();
      expect(await invoke({ approve: approval, phase: 'after-claim' })).toBe('killed');
      expect(await invoke({ approve: approval, cancel: true, phase: 'after-clear' })).toBe(
        'killed',
      );
      const claimDir = join(shared, digest(options.automation));
      const releaseReceipt = join(claimDir, 'released', `${approval}.json`);
      expect(existsSync(releaseReceipt)).toBe(true);
      expect(readAutomationClaim(claimDir)).toBeUndefined();
      if (foreignStatus === 'legacy-completed') rmSync(releaseReceipt);

      const other = resolve(tempStateDir());
      writeFileSync(join(other, 'bot-owner.json'), JSON.stringify({ active: source, retired: [] }));
      const preview = (await invoke({ store: other, request: 'foreign-handoff' })) as Result;
      const foreign = {
        store: other,
        request: 'foreign-handoff',
        approve: preview.approval!,
      };
      if (foreignStatus === 'reserved')
        expect(await invoke({ ...foreign, phase: 'after-claim' })).toBe('killed');
      else expect(await invoke(foreign)).toMatchObject({ status: 'completed' });
      const claim = readAutomationClaim(claimDir);
      const otherOwner = readBotOwnership(other);
      const editLog = existsSync(editing) ? readFileSync(editing, 'utf8') : undefined;
      expect(claim?.store).toBe(other);
      const recovered = await invoke({ approve: approval, cancel: true, phase: 'no-orca-reads' });
      expect(recovered).toMatchObject({
        status: 'cancelled',
        cancelScope: 'gestalt',
        orcaVerification: 'not-checked',
      });
      expect(recovered).not.toHaveProperty('automationChatId');
      expect(readBotOwnership(dir).active).toEqual(source);
      expect(await invoke({ phase: 'owner-release' })).toMatchObject({ status: 'owner-changed' });
      expect(readAutomationClaim(claimDir)).toEqual(claim);
      expect(readBotOwnership(other)).toEqual(otherOwner);
      expect(existsSync(editing) ? readFileSync(editing, 'utf8') : undefined).toBe(editLog);
    },
    25_000,
  );

  it('다른 승인으로 저장된 활성 예약은 취소를 재개해도 해제하지 않는다', async () => {
    const { dir, shared, schedule, editing, invoke, approve } = fixture();
    const approval = await approve();
    expect(await invoke({ approve: approval, phase: 'after-claim' })).toBe('killed');
    expect(await invoke({ approve: approval, cancel: true, phase: 'before-clear' })).toBe(
      'killed',
    );
    const claimDir = join(shared, digest(options.automation));
    const claimFile = join(claimDir, 'claim.json');
    const original = readFileSync(claimFile, 'utf8');
    const claim = readAutomationClaim(claimDir)!;
    const intent = { ...claim.intent!, settings: 'another-approved-schedule' };
    intent.approval = handoffApproval(dir, intent);
    expect(intent.approval).not.toBe(approval);
    const changed = JSON.stringify({ ...claim, intent });
    writeFileSync(claimFile, changed);
    const ownerFile = join(dir, 'bot-owner.json');
    const owner = readFileSync(ownerFile, 'utf8');
    const automation = readFileSync(schedule, 'utf8');

    expect(await invoke({ approve: approval, cancel: true, phase: 'no-orca-reads' })).toMatchObject({
      status: 'partial',
      retryStage: 'reconcile-edit',
      detail: expect.stringContaining('공유 예약의 승인 스냅샷'),
    });
    expect(readFileSync(claimFile, 'utf8')).toBe(changed);
    expect(readFileSync(ownerFile, 'utf8')).toBe(owner);
    expect(readFileSync(schedule, 'utf8')).toBe(automation);
    expect(existsSync(join(claimDir, 'released', `${approval}.json`))).toBe(false);
    expect(existsSync(editing)).toBe(false);
    expect(await invoke({ phase: 'owner-release' })).toMatchObject({ status: 'blocked' });

    writeFileSync(claimFile, original);
    expect(await invoke({ approve: approval, cancel: true })).toMatchObject({ status: 'cancelled' });
  }, 20_000);

  it('해제 기록의 스냅샷이 달라지면 타 저장소의 인계 완료 후에도 로컬 취소를 보류한다', async () => {
    const { dir, shared, schedule, editing, invoke, approve } = fixture();
    const approval = await approve();
    expect(await invoke({ approve: approval, phase: 'after-claim' })).toBe('killed');
    expect(await invoke({ approve: approval, cancel: true, phase: 'after-clear' })).toBe('killed');
    const claimDir = join(shared, digest(options.automation));
    const releaseFile = join(claimDir, 'released', `${approval}.json`);
    const original = readFileSync(releaseFile, 'utf8');
    const released = JSON.parse(original);
    released.intent.settings = 'unapproved-settings';
    writeFileSync(releaseFile, JSON.stringify(released));

    const other = resolve(tempStateDir());
    const otherOwner = join(other, 'bot-owner.json');
    writeFileSync(otherOwner, JSON.stringify({ active: source, retired: [] }));
    const foreign = { store: other, request: 'foreign-handoff' };
    const preview = (await invoke(foreign)) as Result;
    expect(await invoke({ ...foreign, approve: preview.approval! })).toMatchObject({
      status: 'completed',
    });
    const localOwner = join(dir, 'bot-owner.json');
    const preserved = [join(claimDir, 'claim.json'), otherOwner, schedule, editing];
    const before = preserved.map((path) => readFileSync(path, 'utf8'));
    const localBefore = readFileSync(localOwner, 'utf8');
    const cancel = { approve: approval, cancel: true, phase: 'no-orca-reads' };
    expect(await invoke(cancel)).toMatchObject({
      status: 'partial',
      retryStage: 'reconcile-edit',
      detail: expect.stringContaining('해제 기록의 승인 스냅샷'),
    });
    expect(readFileSync(localOwner, 'utf8')).toBe(localBefore);
    expect(preserved.map((path) => readFileSync(path, 'utf8'))).toEqual(before);

    writeFileSync(releaseFile, original);
    expect(await invoke(cancel)).toMatchObject({
      status: 'cancelled',
      orcaVerification: 'not-checked',
    });
    expect(await invoke({ phase: 'owner-release' })).toMatchObject({ status: 'owner-changed' });
    expect(preserved.map((path) => readFileSync(path, 'utf8'))).toEqual(before);
  }, 20_000);

  it('마지막 일정 조회 중 기존 채팅이 닫히면 공유 예약을 해제하지 않는다', async () => {
    const { dir, shared, invoke, approve, editing } = fixture();
    const approval = await approve();
    expect(await invoke({ approve: approval, phase: 'after-claim' })).toBe('killed');
    const claimDir = join(shared, digest(options.automation));
    const claim = readAutomationClaim(claimDir);
    expect(
      await invoke({ approve: approval, cancel: true, phase: 'cancel-third-show-closes-source' }),
    ).toMatchObject({ status: 'partial', retryStage: 'reconcile-edit' });
    expect(readBotOwnership(dir).handoffs[0]?.outcome).toBeUndefined();
    expect(readAutomationClaim(claimDir)).toEqual(claim);
    expect(existsSync(join(claimDir, 'released', `${approval}.json`))).toBe(false);
    expect(await invoke({ approve: approval, cancel: true })).toMatchObject({
      status: 'cancelled',
      cancelScope: 'gestalt',
      orcaVerification: 'observed',
    });
    expect(existsSync(editing)).toBe(false);
  }, 20_000);

  it.each(['cancel-last-chat-moves', 'cancel-last-chat-expires'])(
    '%s이면 마지막 채팅 반환 후 일정과 시간을 확인해 취소 확정을 보류한다',
    async (phase) => {
      const { dir, shared, invoke, approve, setChat, editing } = fixture();
      const approval = await approve();
      expect(await invoke({ approve: approval, phase: 'after-claim' })).toBe('killed');
      const claimDir = join(shared, digest(options.automation));
      const claim = readAutomationClaim(claimDir);
      expect(await invoke({ approve: approval, cancel: true, phase })).toMatchObject({
        status: 'partial',
        retryStage: 'reconcile-edit',
        automationChatId: phase === 'cancel-last-chat-moves' ? options.chat : source.chatId,
      });
      expect(readBotOwnership(dir).handoffs[0]?.outcome).toBeUndefined();
      expect(readAutomationClaim(claimDir)).toEqual(claim);
      setChat(source.chatId);
      expect(await invoke({ approve: approval, cancel: true })).toMatchObject({
        status: 'cancelled',
      });
      expect(existsSync(editing)).toBe(false);
    },
    20_000,
  );

  it('Orca 호출 중 부모가 멈춰도 실행 프로세스가 남긴 늦은 응답으로 인계를 재개한다', async () => {
    const { dir, shared, editing, release, invoke, approve } = fixture();
    const approval = await approve();
    expect(await invoke({ approve: approval, phase: 'during-edit', mode: 'hold' })).toBe('killed');
    try {
      const receiptDir = join(shared, digest(options.automation));
      const attempt = readBotOwnership(dir).handoffs[0]?.editAttempt;
      expect(attempt).toBeTruthy();
      expect(readEditReceipt(receiptDir, approval, attempt!)).toMatchObject({
        outcome: 'dispatched',
      });
      expect(await invoke({ approve: approval, cancel: true })).toMatchObject({
        status: 'partial',
        retryStage: 'reconcile-edit',
      });
      writeFileSync(release, '');
      await vi.waitFor(() =>
        expect(readEditReceipt(receiptDir, approval, attempt!)).toMatchObject({
          outcome: 'applied',
        }),
      );
      expect(await invoke({ approve: approval })).toMatchObject({ status: 'completed' });
      expect(readFileSync(editing, 'utf8')).toBe('edit\n');
    } finally {
      writeFileSync(release, '');
    }
  }, 20_000);

  it('Orca 응답이 사라진 뒤 다른 편집과 늦은 반영이 교차해도 취소를 확정하지 않는다', async () => {
    const { dir, editing, invoke, approve, setChat } = fixture();
    const approval = await approve();
    const initial = await invoke({ approve: approval, mode: 'lost' });
    expect(initial).toMatchObject({ status: 'partial', retryStage: 'reconcile-edit' });
    for (const current of [options.chat, source.chatId, options.chat]) {
      setChat(current);
      expect(await invoke({ approve: approval, cancel: true })).toMatchObject({
        status: 'partial',
        retryStage: 'reconcile-edit',
        automationChatId: current,
      });
    }
    expect(readBotOwnership(dir).active).toEqual(source);
    expect(readFileSync(editing, 'utf8')).toBe('edit\n');
  }, 20_000);

  it('다른 자동화를 가리키는 성공 응답도 요청의 편집 완료 증거로 쓰지 않는다', async () => {
    const { dir, invoke, approve, setChat } = fixture();
    const approval = await approve();
    expect(await invoke({ approve: approval, mode: 'mismatch' })).toMatchObject({
      status: 'partial',
      retryStage: 'reconcile-edit',
    });
    setChat(source.chatId);
    expect(await invoke({ approve: approval, cancel: true })).toMatchObject({
      status: 'partial',
      retryStage: 'reconcile-edit',
    });
    expect(readBotOwnership(dir).active).toEqual(source);
  }, 20_000);
});
