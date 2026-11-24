import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAutomationClaim } from '../../../src/conductor/bot-handoff-coordination.js';
import { readEditReceipt } from '../../../src/conductor/bot-handoff-edit.js';
import { changeBotOwner, readBotOwnership } from '../../../src/conductor/bot-owner.js';
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
import { writeBotOwnership } from ${JSON.stringify(sourceModule('bot-owner'))};
import { readScheduledBotAutomation } from ${JSON.stringify(sourceModule('orca-automation'))};
const { dir, shared, schedule, editing, options, phase, source } = JSON.parse(process.argv[1]);
const killSelf = () => process.kill(process.pid, 'SIGKILL');
let reads = 0;
let chats = 0;
const result = await handoffBot(dir, options, {
  coordinationRoot: () => shared,
  now: Date.now,
  chat: async (name, chatId) => {
    if (phase === 'cancel-source-closes' && ++chats === 2) throw new Error('기존 채팅 닫힘');
    return { name, chatId, botId: source.botId };
  },
  show: async () => {
    const automation = JSON.parse(readFileSync(schedule, 'utf8'));
    if (phase === 'cancel-late-move' && ++reads === 2) {
      automation.bot.chat.sessionId = options.chat;
      writeFileSync(schedule, JSON.stringify(automation));
    }
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
    writeBotOwnership(dir, value);
    if (phase === 'before-claim') killSelf();
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
  return { dir, shared, editing, release, invoke, approve, setChat };
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

  it('담당 예약 없는 옛 로컬 요청은 두 번째 저장소의 기록을 건드리지 않고 취소한다', async () => {
    const { dir, invoke, approve, editing } = fixture();
    const approval = await approve();
    expect(await invoke({ approve: approval, phase: 'before-claim' })).toBe('killed');
    const other = resolve(tempStateDir());
    writeFileSync(join(other, 'bot-owner.json'), JSON.stringify({ active: source, retired: [] }));
    const preview = (await invoke({ store: other })) as Result;
    expect(preview).toMatchObject({ status: 'ready' });
    expect(await invoke({ store: other, approve: preview.approval! })).toMatchObject({
      status: 'completed',
    });
    const cancelled = await invoke({ approve: approval, cancel: true });
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(cancelled).not.toHaveProperty('automationChatId');
    changeBotOwner(dir, source.chatId);
    expect(await invoke({ store: other, approve: preview.approval! })).toMatchObject({
      status: 'completed',
      replayed: true,
    });
    expect(readFileSync(editing, 'utf8')).toBe('edit\n');
  }, 20_000);

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
