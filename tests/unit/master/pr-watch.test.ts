import { afterEach, describe, expect, it } from 'vitest';
import { pollPrs, type PrWatchSource, type WatchedPr } from '../../../src/master/pr-watch.js';
import { MasterStore } from '../../../src/master/store.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';

afterEach(cleanupStateDirs);

const config = { defaultScope: 'approval' as const };

function source(authored: WatchedPr[], reviewing: WatchedPr[]): PrWatchSource {
  return { authored: async () => authored, reviewing: async () => reviewing };
}

const base = { repo: 'acme/app', title: '배너', headSha: 'b' };

describe('PR 감시', () => {
  it('내 PR에 새 코멘트가 오면 review-reply 주문을 한 번 만든다', async () => {
    const s = MasterStore.open(tempStateDir());
    const src = source([{ ...base, ref: 'acme/app#1', latestOtherCommentId: 'c1' }], []);
    const first = await pollPrs(s, src, config);
    await pollPrs(s, src, config);
    expect(first.created).toHaveLength(1);
    expect(first.created[0]).toMatchObject({
      source: 'pr-watch',
      skillChain: ['review-reply'],
      prRef: 'acme/app#1',
    });
    expect(s.orders()).toHaveLength(1);
    expect(
      (
        await pollPrs(
          s,
          source(
            [{ ...base, ref: 'acme/app#9', unansweredThreads: 2 }],
            [{ ...base, ref: 'acme/app#8', unansweredThreads: 1 }],
          ),
          config,
        )
      ).unansweredThreads,
    ).toBe(3);

    s.updateOrder(first.created[0]!.id, { status: 'done' });
    const next = await pollPrs(
      s,
      source([{ ...base, ref: 'acme/app#1', latestOtherCommentId: 'c2' }], []),
      config,
    );
    expect(next.created).toHaveLength(1);
  });

  it('도는 주문이 있는 PR은 건드리지 않는다', async () => {
    const s = MasterStore.open(tempStateDir());
    await pollPrs(
      s,
      source([{ ...base, ref: 'acme/app#1', latestOtherCommentId: 'c1' }], []),
      config,
    );
    const r = await pollPrs(
      s,
      source([{ ...base, ref: 'acme/app#1', latestOtherCommentId: 'c2' }], []),
      config,
    );
    expect(r.created).toEqual([]);
  });

  it('사람 결정을 기다리는 escalated 주문의 PR에도 새 주문을 만들지 않는다', async () => {
    const s = MasterStore.open(tempStateDir());
    const first = await pollPrs(
      s,
      source([{ ...base, ref: 'acme/app#1', latestOtherCommentId: 'c1' }], []),
      config,
    );
    s.updateOrder(first.created[0]!.id, { status: 'escalated' });
    const r = await pollPrs(
      s,
      source([{ ...base, ref: 'acme/app#1', latestOtherCommentId: 'c2' }], []),
      config,
    );
    expect(r.created).toEqual([]);
  });

  it('리뷰한 PR은 head가 바뀌면 재리뷰 주문, 답만 오면 사람에게 한 번 올린다', async () => {
    const s = MasterStore.open(tempStateDir());
    const moved = await pollPrs(
      s,
      source([], [{ ...base, ref: 'acme/app#2', headSha: 'new', reviewedHeadSha: 'old' }]),
      config,
    );
    expect(moved.created[0]).toMatchObject({ skillChain: ['review-loop'], prRef: 'acme/app#2' });

    const repliesOnly = source(
      [],
      [{ ...base, ref: 'acme/app#3', reviewedHeadSha: 'b', repliesSinceReview: 2 }],
    );
    const r = await pollPrs(s, repliesOnly, config);
    await pollPrs(s, repliesOnly, config);
    expect(r.gated.map((g) => g.type)).toEqual(['review-manual-switch']);
    expect(s.openGates().filter((g) => g.type === 'review-manual-switch')).toHaveLength(1);
  });
});
