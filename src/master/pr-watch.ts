import { openOrReuse } from './gates.js';
import { intakeOrder } from './intake.js';
import type { MasterStore } from './store.js';
import { TERMINAL_ORDER_STATUSES, type Gate, type Order, type OrderScope } from './types.js';

/** 감시하는 PR 하나의 요약. 코멘트 본문은 싣지 않는다 */
export interface WatchedPr {
  /** `owner/name#번호` */
  ref: string;
  repo: string;
  title: string;
  headSha: string;
  /** 내가 아닌 사람이 단 코멘트 중 가장 최근 것의 id. 없으면 비운다 */
  latestOtherCommentId?: string;
  /** 내 마지막 리뷰가 본 head. 내가 리뷰한 PR에서만 채운다 */
  reviewedHeadSha?: string;
  /** 내 마지막 리뷰 뒤로 작성자가 답한 스레드 수. 내가 리뷰한 PR에서만 채운다 */
  repliesSinceReview?: number;
  /** 대응해야 하는데 아직 답이 없는 스레드 수. 처리 뒤에 몇 개가 남았는지 보고할 때 쓴다 */
  unansweredThreads?: number;
}

/** 원격 PR을 읽는 어댑터. 쓰기는 워커가 스킬로 하고 여기서는 읽기만 한다 */
export interface PrWatchSource {
  /** 내가 올린 열린 PR */
  authored(): Promise<WatchedPr[]>;
  /** 내가 리뷰를 맡은 열린 PR */
  reviewing(): Promise<WatchedPr[]>;
}

export interface PrWatchResult {
  created: Order[];
  gated: Gate[];
  /** 이번에 본 PR 전체에서 답이 없는 대응 대상 스레드 수 */
  unansweredThreads: number;
}

/**
 * 내가 올린 PR과 내가 리뷰한 PR을 보고 주문이나 게이트를 만든다.
 *
 * - 내 PR에 새 코멘트가 오면 review-reply 주문을 만든다.
 * - 내가 리뷰한 PR의 head가 바뀌면 review-loop 주문을 만든다.
 * - 답만 오고 코드가 그대로면 review-loop의 REPLIES_ONLY 규칙대로 사람에게 올린다.
 *
 * 같은 PR에 끝나지 않은 주문이 있으면 건드리지 않는다. 그 워커가 이미 PR을 다루고 있어서
 * 주문을 하나 더 만들면 두 워커가 같은 스레드에 답하게 된다.
 */
export async function pollPrs(
  store: MasterStore,
  source: PrWatchSource,
  config: { defaultScope: OrderScope },
): Promise<PrWatchResult> {
  const result: PrWatchResult = { created: [], gated: [], unansweredThreads: 0 };
  const busy = new Set(
    store
      .orders()
      .filter((o) => o.prRef && !TERMINAL_ORDER_STATUSES.has(o.status))
      .map((o) => o.prRef!),
  );

  const authored = await source.authored();
  const reviewing = await source.reviewing();
  for (const pr of [...authored, ...reviewing])
    result.unansweredThreads += pr.unansweredThreads ?? 0;

  for (const pr of authored) {
    if (!pr.latestOtherCommentId || busy.has(pr.ref)) continue;
    const out = intakeOrder(
      store,
      {
        source: 'pr-watch',
        sourceRef: `pr-watch:reply:${pr.ref}:${pr.latestOtherCommentId}`,
        repo: pr.repo,
        title: `리뷰 답글: ${pr.title}`,
        prRef: pr.ref,
        skillChain: ['review-reply'],
      },
      config,
    );
    if (out.created) {
      result.created.push(out.order);
      busy.add(pr.ref);
    }
  }

  for (const pr of reviewing) {
    if (!pr.reviewedHeadSha || busy.has(pr.ref)) continue;
    if (pr.headSha !== pr.reviewedHeadSha) {
      const out = intakeOrder(
        store,
        {
          source: 'pr-watch',
          sourceRef: `pr-watch:review:${pr.ref}@${pr.headSha}`,
          repo: pr.repo,
          title: `재리뷰: ${pr.title}`,
          prRef: pr.ref,
          skillChain: ['review-loop'],
        },
        config,
      );
      if (out.created) result.created.push(out.order);
      continue;
    }
    if ((pr.repliesSinceReview ?? 0) > 0) {
      const sourceRef = `pr-watch:replies:${pr.ref}@${pr.headSha}:${pr.repliesSinceReview}`;
      const asked = Object.values(store.snapshot.gates).some(
        (g) => g.payload?.sourceRef === sourceRef,
      );
      if (asked) continue;
      const { gate } = openOrReuse(store, {
        type: 'review-manual-switch',
        reason: `답글만 오고 코드는 그대로예요: ${pr.ref} (답 ${pr.repliesSinceReview}건)`,
        refs: [pr.ref],
        payload: { sourceRef, prRef: pr.ref },
      });
      result.gated.push(gate);
    }
  }
  return result;
}
