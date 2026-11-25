import { openOrReuse } from './gates.js';
import type { ReviewApprovalScope } from './bot-approval.js';
import { intakeOrder } from './intake.js';
import type { ConductorStore } from './store.js';
import {
  HUMAN_PR_STATUSES,
  TERMINAL_ORDER_STATUSES,
  type Gate,
  type Order,
  type OrderScope,
} from './types.js';

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

function reviewReapprovalPrefix(ref: string, head: string): string {
  return `pr-watch:reapproval:${ref}@${head}:`;
}

export function openReviewReapproval(
  store: ConductorStore,
  previous: Gate,
  scope: ReviewApprovalScope,
  reapprovalReason: string,
): string | undefined {
  const sourceRef = `${reviewReapprovalPrefix(scope.ref, scope.head)}${previous.id}`;
  const gates = Object.values(store.snapshot.gates);
  const existing =
    gates.find((g) => g.payload?.sourceRef === sourceRef) ??
    gates.find(
      (g) =>
        g.status === 'open' &&
        g.type === 'review-manual-switch' &&
        !g.orderId &&
        g.payload?.prRef === scope.ref &&
        g.payload.reapprovalOf,
    );
  const reason = `재리뷰 승인 범위가 달라졌어요: ${scope.ref} (HEAD ${scope.head}, base ${scope.base})`;
  const payload = {
    prRef: scope.ref,
    sourceRef,
    reapprovalOf: previous.id,
    reapprovalReason,
    approvalBase: scope.base,
  };
  if (existing) {
    // 범위 확인 뒤 새 게이트를 쓴 시점에 끊겨도 같은 요청을 다시 쓴다.
    if (
      existing.status === 'open' &&
      (existing.reason !== reason || existing.payload?.reapprovalOf !== previous.id)
    )
      store.append({
        type: 'gate-updated',
        at: store.timestamp(),
        gateId: existing.id,
        reason,
        refs: [scope.ref],
        payload,
      });
    return existing.id;
  }
  if (store.askedSourceRef(sourceRef)) return;
  return openOrReuse(store, { type: 'review-manual-switch', reason, refs: [scope.ref], payload })
    .gate.id;
}

export function recordedReviewReapproval(
  store: ConductorStore,
  previous: Gate,
): { detail: string; replacement?: string } | undefined {
  if (previous.type !== 'review-manual-switch' || previous.orderId) return;
  // 이전 버전에서 접힌 상태 파일은 교체와 무효화를 별도 기록으로 저장했다.
  const gate = Object.values(store.snapshot.gates).find(
    (g) =>
      g.type === 'review-manual-switch' && !g.orderId && g.payload?.reapprovalOf === previous.id,
  );
  if (gate) {
    const reason = gate.payload?.reapprovalReason ?? gate.reason;
    return {
      detail: `${reason}. 새 게이트 ${gate.id}에서 다시 결정해 주세요`,
      replacement: gate.id,
    };
  }
  if (
    Object.keys(store.snapshot.askedSourceRefs).some(
      (ref) => ref.startsWith('pr-watch:reapproval:') && ref.endsWith(`:${previous.id}`),
    )
  )
    return { detail: '재리뷰 승인 범위 변경으로 교체 게이트를 기록했어요' };
}

function requiresReviewReapproval(store: ConductorStore, pr: WatchedPr): boolean {
  const prefix = reviewReapprovalPrefix(pr.ref, pr.headSha);
  const headChanged = pr.headSha !== pr.reviewedHeadSha;
  return (
    Object.values(store.snapshot.gates).some(
      (g) =>
        g.type === 'review-manual-switch' &&
        !g.orderId &&
        g.payload?.prRef === pr.ref &&
        g.payload.reapprovalOf &&
        (g.status === 'open' ||
          g.deliveryPending ||
          (headChanged &&
            (g.receipt?.head === pr.headSha || g.payload.sourceRef?.startsWith(prefix)))),
    ) ||
    (headChanged &&
      Object.keys(store.snapshot.askedSourceRefs).some((ref) => ref.startsWith(prefix)))
  );
}

/**
 * 내가 올린 PR과 내가 리뷰한 PR을 보고 주문이나 게이트를 만든다.
 *
 * - 내 PR에 새 코멘트가 오면 review-reply 주문을 만든다.
 * - 내가 리뷰한 PR의 head가 바뀌면 review-loop 주문을 만든다.
 * - 답만 오고 코드가 그대로면 review-loop의 REPLIES_ONLY 규칙대로 사람에게 올린다.
 *
 * 같은 PR에 끝나지 않은 주문이 있으면 건드리지 않는다. 사람 결정을 기다리는 escalated 주문도
 * 끝나지 않은 주문이다. 그 워커가 이미 PR을 다루고 있거나 승인 뒤 다시 다룰 거라
 * 주문을 하나 더 만들면 두 워커가 같은 스레드에 답하게 된다.
 * 사람이 넘겨받은 PR(human-owned, parked)도 건드리지 않는다. parked는 끝 상태지만 PR은 사람이
 * 쥐고 있어 컨덕터가 답글을 달면 사람과 워커가 같은 PR을 만진다. parked로 보관한 주문의 PR도 같다.
 */
export async function pollPrs(
  store: ConductorStore,
  source: PrWatchSource,
  config: { defaultScope: OrderScope },
): Promise<PrWatchResult> {
  const result: PrWatchResult = { created: [], gated: [], unansweredThreads: 0 };
  const busy = new Set([
    ...store
      .orders()
      .filter(
        (o) =>
          o.prRef && (!TERMINAL_ORDER_STATUSES.has(o.status) || HUMAN_PR_STATUSES.has(o.status)),
      )
      .map((o) => o.prRef!),
    ...store.archivedHumanPrs(),
  ]);

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
    if (!pr.reviewedHeadSha || busy.has(pr.ref) || requiresReviewReapproval(store, pr)) continue;
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
      if (store.askedSourceRef(sourceRef)) continue;
      const { gate } = openOrReuse(store, {
        type: 'review-manual-switch',
        reason: `답글만 오고 코드는 그대로예요: ${pr.ref} (답 ${pr.repliesSinceReview}개)`,
        refs: [pr.ref],
        payload: { sourceRef, prRef: pr.ref },
      });
      result.gated.push(gate);
    }
  }
  return result;
}
