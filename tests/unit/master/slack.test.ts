import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGate } from '../../../src/master/gates.js';
import { draftSlack, publishApprovedSlack, type SlackClient } from '../../../src/master/slack.js';
import { MasterStore } from '../../../src/master/store.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';

afterEach(cleanupStateDirs);

function fakeSlack() {
  const sent: { channel: string; text: string }[] = [];
  const client: SlackClient = {
    post: async (m) => {
      sent.push(m);
      return `ts-${sent.length}`;
    },
  };
  return { sent, client };
}

describe('슬랙 초안', () => {
  it('초안은 게이트로 올리고 승인 전에는 보내지 않으며 승인되면 한 번만 보낸다', async () => {
    const dir = tempStateDir();
    const s = MasterStore.open(dir);
    const { sent, client } = fakeSlack();
    const { gate } = draftSlack(
      s,
      { channel: '#release', text: '배포 끝났어요~' },
      join(dir, 'slack'),
    );
    expect(
      draftSlack(s, { channel: '#release', text: '배포 끝났어요~' }, join(dir, 'slack')).reused,
    ).toBe(true);
    expect(gate.reason).not.toContain('배포 끝났어요');

    await publishApprovedSlack(s, client);
    expect(sent).toEqual([]);

    resolveGate(s, gate.id, 'approved');
    const r = await publishApprovedSlack(s, client);
    await publishApprovedSlack(s, client);
    expect(r.posted).toEqual([{ gateId: gate.id, ref: 'ts-1' }]);
    expect(sent).toEqual([{ channel: '#release', text: '배포 끝났어요~' }]);
    expect(MasterStore.open(dir).snapshot.slackPosted[gate.id]).toBe('ts-1');
  });

  it('거절한 초안은 보내지 않고 게시 실패는 다음 tick에 다시 시도한다', async () => {
    const dir = tempStateDir();
    const s = MasterStore.open(dir);
    const rejected = draftSlack(s, { channel: '#a', text: '하나' }, join(dir, 'slack')).gate;
    const approved = draftSlack(s, { channel: '#a', text: '둘' }, join(dir, 'slack')).gate;
    resolveGate(s, rejected.id, 'rejected');
    resolveGate(s, approved.id, 'approved');

    let fail = true;
    const sent: string[] = [];
    const client: SlackClient = {
      post: async (m) => {
        if (fail) throw new Error('rate limited');
        sent.push(m.text);
        return 'ts';
      },
    };
    expect((await publishApprovedSlack(s, client)).failed[0]?.error).toBe('rate limited');
    fail = false;
    await publishApprovedSlack(s, client);
    expect(sent).toEqual(['둘']);
  });
});
