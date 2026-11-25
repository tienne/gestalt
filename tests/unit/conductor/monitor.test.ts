import { describe, expect, it, vi } from 'vitest';
import { readConductorMonitor } from '../../../src/conductor/monitor.js';
import type { CommandRunner } from '../../../src/conductor/launcher.js';

const owner = { botId: 'bot-test', name: '컨덕터 fixture', chatId: 'chat-test' };
const precheck = 'test "$(( $(date +%s) % 1500 ))" -lt 300';
const slot = 1_795_537_500_000;
const automation = {
  id: 'automation-test',
  bot: { botId: owner.botId, runsIn: 'chat', resultsTo: 'chat', chat: { sessionId: owner.chatId } },
  rrule: '*/5 * * * *',
  precheck: { command: precheck },
  nextRunAt: slot + 300_000,
  enabled: true,
};
const run = {
  id: 'run-test',
  automationId: automation.id,
  trigger: 'scheduled',
  scheduledFor: slot,
  dispatchedAt: slot + 20,
  chatSessionId: owner.chatId,
};
const postFailed = {
  ...run,
  status: 'dispatch_failed',
  error:
    "This run's message was answered together with another message, so its result wasn't posted.",
  outputSnapshot: null,
};
const chatUnavailable = {
  ...run,
  status: 'dispatch_failed',
  dispatchedAt: null,
  chatSessionId: null,
  error:
    '컨덕터 fixture has no chat chat:chat-test that takes mail, so pick one that `orca bot chats --bot "컨덕터 fixture"` lists.',
};
const skipped = {
  ...run,
  id: 'run-skip',
  scheduledFor: slot + 300_000,
  status: 'skipped_precheck',
  dispatchedAt: null,
  chatSessionId: null,
  precheckResult: { command: precheck, exitCode: 1, timedOut: false, error: null },
};
const completed = {
  ...run,
  status: 'completed',
  error: null,
  outputSnapshot: { format: 'plain_text', content: '합성 결과', capturedAt: slot + 9_000 },
};

function cli(rows: unknown[], automations: unknown[] = [automation]) {
  return vi.fn<CommandRunner>(async (_command, args) => ({
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      result: args[1] === 'list' ? { automations } : { runs: rows },
    }),
    stderr: '',
  }));
}

describe('readConductorMonitor', () => {
  it('닫힌 채팅으로 인해 실행되지 않은 기록과 게시하지 못한 기록을 구분한다', async () => {
    for (const [row, state] of [
      [chatUnavailable, 'chat-unavailable'],
      [postFailed, 'post-failed'],
    ] as const) {
      const result = await readConductorMonitor(owner, 'orca-fixture', cli([row]));
      expect(result?.latestPosting).toEqual({ id: run.id, at: slot, state });
    }
  });

  it('최근 점검이 건너뜀이어도 직전 결과와 실제 25분 정책의 다음 슬롯을 보여준다', async () => {
    const fake = cli([skipped, completed]);
    const result = await readConductorMonitor(owner, 'orca-fixture', fake);
    expect(result).toEqual({
      automationId: automation.id,
      nextCheckAt: slot + 1_500_000,
      latestRun: { id: 'run-skip', at: slot + 300_000, state: 'precheck-skipped' },
      latestPosting: { id: run.id, at: slot, state: 'completed' },
    });
    expect(fake.mock.calls.map(([, args]) => args)).toEqual([
      ['automations', 'list', '--environment', 'local', '--json'],
      [
        'automations',
        'runs',
        '--id',
        automation.id,
        '--limit',
        '25',
        '--environment',
        'local',
        '--json',
      ],
    ]);
  });

  it('실행 대상을 확인할 수 없으면 성공을 추정하지 않는다', async () => {
    const result = await readConductorMonitor(
      owner,
      'orca-fixture',
      cli([
        { ...completed, chatSessionId: 'different-chat' },
        { ...completed, automationId: 'unrelated-automation' },
      ]),
    );
    expect(result?.latestPosting?.state).toBe('unknown');
    expect(
      (
        await readConductorMonitor(
          owner,
          'orca-fixture',
          cli([{ ...completed, outputSnapshot: null }]),
        )
      )?.latestPosting?.state,
    ).toBe('unknown');
  });

  it('운영 자동화가 둘이거나 정책을 식별할 수 없으면 Orca 실행 이력을 요청하지 않는다', async () => {
    const ambiguous = cli([completed], [automation, { ...automation, id: 'other' }]);
    expect(await readConductorMonitor(owner, 'orca-fixture', ambiguous)).toBeNull();
    expect(ambiguous).toHaveBeenCalledTimes(1);
    expect(
      await readConductorMonitor(owner, 'orca-fixture', cli([], [{ ...automation, precheck: {} }])),
    ).toBeNull();
  });

  it('Orca 조회 실패와 비활성 일정은 알 수 없음으로 남긴다', async () => {
    const broken = vi.fn<CommandRunner>().mockRejectedValue(new Error('unavailable'));
    expect(await readConductorMonitor(owner, 'orca-fixture', broken)).toBeNull();
    const result = await readConductorMonitor(
      owner,
      'orca-fixture',
      cli([], [{ ...automation, enabled: false }]),
    );
    expect(result).toMatchObject({ nextCheckAt: null, latestRun: null, latestPosting: null });
  });
});
