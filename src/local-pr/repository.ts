import type { IEventStore } from '../events/store.js';
import type { DomainEvent } from '../core/types.js';
import { PR_AGGREGATE } from './types.js';
import type {
  Comment,
  CommentAddedPayload,
  CommentResolvedPayload,
  PrClosedPayload,
  PrCreatedPayload,
  PrMergedPayload,
  PrUpdatedPayload,
  PullRequest,
  Review,
  ReviewSubmittedPayload,
  Round,
} from './types.js';

/** 이 도메인이 쓰는 이벤트 이름 */
export const PrEvent = {
  CREATED: 'pr.created',
  UPDATED: 'pr.updated',
  COMMENT_ADDED: 'pr.comment.added',
  COMMENT_RESOLVED: 'pr.comment.resolved',
  REVIEW_SUBMITTED: 'pr.review.submitted',
  MERGED: 'pr.merged',
  CLOSED: 'pr.closed',
} as const;

/**
 * 이벤트를 접어 PR 상태를 만든다.
 *
 * 상태를 따로 저장하지 않아서 DB를 지우고 이벤트만 남아도 같은 결과가 나온다.
 * ExecuteSessionRepository가 쓰는 방식과 같다.
 */
export class PullRequestRepository {
  constructor(private eventStore: IEventStore) {}

  reconstruct(prId: string): PullRequest | null {
    const events = this.eventStore.replay(PR_AGGREGATE, prId);
    if (events.length === 0) return null;
    return this.fold(prId, events);
  }

  list(): string[] {
    return this.eventStore.listAggregates(PR_AGGREGATE);
  }

  reconstructAll(): PullRequest[] {
    const out: PullRequest[] = [];
    for (const id of this.list()) {
      const pr = this.reconstruct(id);
      if (pr) out.push(pr);
    }
    return out;
  }

  private fold(prId: string, events: DomainEvent<unknown>[]): PullRequest | null {
    const created = events.find((e) => e.eventType === PrEvent.CREATED);
    if (!created) return null;

    const head = created.payload as PrCreatedPayload;
    const pr: PullRequest = {
      id: prId,
      title: head.title,
      body: head.body,
      author: head.author,
      baseSha: head.baseSha,
      headSha: head.headSha,
      headRef: head.headRef,
      baseRef: head.baseRef,
      status: 'open',
      createdAt: created.timestamp,
      updatedAt: created.timestamp,
      comments: [],
      reviews: [],
      rounds: [{ number: 1, openedAt: created.timestamp, verdict: null, commentCount: 0 }],
    };

    for (const event of events) {
      this.apply(pr, event);
      pr.updatedAt = event.timestamp;
    }

    return pr;
  }

  private apply(pr: PullRequest, event: DomainEvent<unknown>): void {
    switch (event.eventType) {
      case PrEvent.UPDATED: {
        const p = event.payload as PrUpdatedPayload;
        pr.headSha = p.headSha;
        pr.headRef = p.headRef;
        // 고치고 다시 올렸으니 리뷰를 기다리는 자리로 되돌린다
        if (pr.status === 'changes_requested') pr.status = 'open';
        break;
      }

      case PrEvent.COMMENT_ADDED: {
        const p = event.payload as CommentAddedPayload;
        const comment: Comment = {
          id: p.commentId,
          author: p.author,
          path: p.path,
          line: p.line,
          body: p.body,
          threadId: p.threadId,
          resolved: false,
          headSha: p.headSha,
          createdAt: event.timestamp,
        };
        pr.comments.push(comment);
        currentRound(pr).commentCount++;
        break;
      }

      case PrEvent.COMMENT_RESOLVED: {
        const p = event.payload as CommentResolvedPayload;
        // 스레드를 통째로 닫는다. 뿌리만 닫고 답글이 열린 채 남으면 미해결 수가 어긋난다
        const target = pr.comments.find((c) => c.id === p.commentId);
        if (target) {
          for (const c of pr.comments) {
            if (c.threadId === target.threadId) c.resolved = true;
          }
        }
        break;
      }

      case PrEvent.REVIEW_SUBMITTED: {
        const p = event.payload as ReviewSubmittedPayload;
        const round = currentRound(pr);
        const review: Review = {
          id: p.reviewId,
          reviewer: p.reviewer,
          verdict: p.verdict,
          summary: p.summary,
          round: round.number,
          headSha: p.headSha,
          createdAt: event.timestamp,
        };
        pr.reviews.push(review);

        // comment 판정은 라운드를 닫지 않는다. 의견만 남기는 자리다
        if (p.verdict === 'request_changes') {
          pr.status = 'changes_requested';
          round.verdict = p.verdict;
          pr.rounds.push({
            number: round.number + 1,
            openedAt: event.timestamp,
            verdict: null,
            commentCount: 0,
          });
        } else if (p.verdict === 'approve') {
          round.verdict = p.verdict;
        }
        break;
      }

      case PrEvent.MERGED:
        pr.status = 'merged';
        break;

      case PrEvent.CLOSED:
        pr.status = 'closed';
        break;

      default:
        break;
    }
  }
}

function currentRound(pr: PullRequest): Round {
  return pr.rounds[pr.rounds.length - 1]!;
}

/**
 * 아직 안 닫힌 스레드 수. 머지 시점에 이 값을 이벤트에 남긴다.
 *
 * 코멘트가 아니라 스레드를 센다. 코멘트를 세면 답글이 달릴수록 수가 늘어난다.
 * 지적 두 건에 답을 달았더니 "미해결 4"가 되는 일이 실제로 났다. 주고받을수록
 * 나빠 보이는 신호는 티키타카를 말린다.
 */
export function unresolvedCount(pr: PullRequest): number {
  const openThreads = new Set<string>();
  for (const comment of pr.comments) {
    if (!comment.resolved) openThreads.add(comment.threadId);
  }
  return openThreads.size;
}

export type { PrCreatedPayload, PrMergedPayload, PrClosedPayload };
