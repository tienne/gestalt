import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostSlackClient } from '../../../src/conductor/adapters.js';
import { resolveGate } from '../../../src/conductor/gates.js';
import {
  draftSlack,
  publishApprovedSlack,
  SUPERSEDED_PREFIX,
  type SlackClient,
} from '../../../src/conductor/slack.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import type { HostAction } from '../../../src/conductor/launcher.js';
import { cleanupStateDirs, slackSuccess, tempStateDir } from './fixtures.js';

afterEach(cleanupStateDirs);

function fakeSlack() {
  const sent: { channel: string; text: string }[] = [];
  const client: SlackClient = {
    post: async (m, delivery) => {
      sent.push(m);
      return slackSuccess(m, delivery, `12345.${String(sent.length).padStart(6, '0')}`);
    },
  };
  return { sent, client };
}

describe('슬랙 초안', () => {
  it('인계 기록을 쓰지 못하면 호스트에 게시 작업을 넘기지 않는다', async () => {
    const dir = tempStateDir();
    const store = ConductorStore.open(dir);
    const { gate } = draftSlack(store, { channel: 'C123', text: '게시할 본문' }, dir);
    resolveGate(store, gate.id, 'approved');
    const actions: HostAction[] = [];
    const append = vi.spyOn(store, 'append').mockImplementationOnce(() => {
      throw new Error('인계 기록 실패');
    });
    const result = await publishApprovedSlack(store, hostSlackClient(actions));
    append.mockRestore();
    expect(result.failed).toEqual([{ gateId: gate.id, error: '인계 기록 실패' }]);
    expect(actions).toEqual([]);
    const restarted = ConductorStore.open(dir);
    await publishApprovedSlack(restarted, hostSlackClient(actions));
    expect(actions).toHaveLength(1);
    expect(restarted.snapshot.slackPosted[gate.id]).toBe('host');
  });

  it('초안은 게이트로 올리고 승인 전에는 보내지 않으며 승인되면 한 번만 보낸다', async () => {
    const dir = tempStateDir();
    const s = ConductorStore.open(dir);
    const { sent, client } = fakeSlack();
    const { gate } = draftSlack(s, { channel: 'C123', text: '배포 끝났어요~' }, join(dir, 'slack'));
    expect(
      draftSlack(s, { channel: 'C123', text: '배포 끝났어요~' }, join(dir, 'slack')).reused,
    ).toBe(true);
    expect(gate.reason).not.toContain('배포 끝났어요');

    await publishApprovedSlack(s, client);
    expect(sent).toEqual([]);

    resolveGate(s, gate.id, 'approved');
    const r = await publishApprovedSlack(s, client);
    const restarted = ConductorStore.open(dir);
    await publishApprovedSlack(restarted, client);
    expect(r.posted).toEqual([{ gateId: gate.id, ref: '12345.000001' }]);
    expect(sent).toEqual([{ channel: 'C123', text: '배포 끝났어요~' }]);
    expect(restarted.snapshot.slackPosted[gate.id]).toBe('12345.000001');
  });

  it('거절한 초안은 보내지 않고 게시 실패는 다음 tick에 다시 시도한다', async () => {
    const dir = tempStateDir();
    const s = ConductorStore.open(dir);
    const rejected = draftSlack(s, { channel: 'C123', text: '하나' }, join(dir, 'slack')).gate;
    const approved = draftSlack(s, { channel: 'C123', text: '둘' }, join(dir, 'slack')).gate;
    resolveGate(s, rejected.id, 'rejected');
    resolveGate(s, approved.id, 'approved');

    let fail = true;
    const sent: string[] = [];
    const client: SlackClient = {
      post: async (m, delivery) => {
        if (fail) throw new Error('rate limited');
        sent.push(m.text);
        return slackSuccess(m, delivery);
      },
    };
    expect((await publishApprovedSlack(s, client)).failed[0]?.error).toBe('rate limited');
    fail = false;
    await publishApprovedSlack(s, client);
    expect(sent).toEqual(['둘']);
  });

  it('승인 뒤 초안 파일이 바뀌면 보내지 않고 바뀐 본문으로 새 확인 자리를 연다', async () => {
    const dir = tempStateDir();
    const s = ConductorStore.open(dir);
    const { sent, client } = fakeSlack();
    const { gate } = draftSlack(
      s,
      { channel: 'C123', text: '배포 끝났어요', orderId: 'ord-1' },
      join(dir, 'slack'),
    );
    resolveGate(s, gate.id, 'approved');
    writeFileSync(String(gate.payload?.draftFile), '바꿔치기한 본문');

    const r = await publishApprovedSlack(s, client);
    expect(sent).toEqual([]);
    expect(r.reopened).toHaveLength(1);
    const newGateId = r.reopened[0]!.newGateId;
    expect(s.snapshot.slackPosted[gate.id]).toBe(`${SUPERSEDED_PREFIX}${newGateId}`);
    const reopened = s.openGates().find((g) => g.id === newGateId);
    expect(reopened?.type).toBe('slack-post');
    expect(reopened?.orderId).toBe('ord-1');

    const again = await publishApprovedSlack(s, client);
    expect(again.reopened).toEqual([]);
    expect(sent).toEqual([]);

    resolveGate(s, newGateId, 'approved');
    await publishApprovedSlack(s, client);
    expect(sent).toEqual([{ channel: 'C123', text: '바꿔치기한 본문' }]);
  });
});
