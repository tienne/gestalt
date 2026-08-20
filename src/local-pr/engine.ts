import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventStore } from '../events/store.js';
import type { IEventStore } from '../events/store.js';
import * as git from './git.js';
import { PrEvent, PullRequestRepository, unresolvedCount } from './repository.js';
import { PR_AGGREGATE } from './types.js';
import type { Actor, PullRequest, ReviewVerdict } from './types.js';

/**
 * 로컬 PR을 만들고 굴린다.
 *
 * 상태 전이 규칙이 여기 산다. 승인 게이트는 없어서 승인 없이 머지할 수 있다.
 * 대신 그 시점의 미해결 코멘트 수를 이벤트에 남겨 나중에 되짚게 한다.
 */
export class LocalPrEngine {
  private store: IEventStore;
  private repo: PullRequestRepository;

  constructor(
    private repoRoot: string,
    store?: IEventStore,
  ) {
    if (store) {
      this.store = store;
    } else {
      const dbPath = git.reviewsDbPath(repoRoot);
      mkdirSync(dirname(dbPath), { recursive: true });
      this.store = new EventStore(dbPath);
    }
    this.repo = new PullRequestRepository(this.store);
  }

  /** 저장소를 닫는다. PR을 닫는 closePr과 헷갈리지 않게 이름을 갈라뒀다 */
  dispose(): void {
    this.store.close();
  }

  // ─── 조회 ────────────────────────────────────────────────

  get(prId: string): PullRequest | null {
    return this.repo.reconstruct(prId);
  }

  list(status?: PullRequest['status']): PullRequest[] {
    const all = this.repo.reconstructAll();
    return status ? all.filter((pr) => pr.status === status) : all;
  }

  diff(prId: string): string {
    const pr = this.require(prId);
    return git.diff(this.repoRoot, pr.baseSha, pr.headSha);
  }

  changedFiles(prId: string): string[] {
    const pr = this.require(prId);
    return git.changedFiles(this.repoRoot, pr.baseSha, pr.headSha);
  }

  // ─── 생성과 갱신 ─────────────────────────────────────────

  create(input: {
    title: string;
    body?: string;
    author: Actor;
    base?: string;
    head?: string;
  }): PullRequest {
    const baseRef = input.base ?? 'main';
    const headRev = input.head ?? 'HEAD';

    const headSha = git.resolveSha(this.repoRoot, headRev);
    const baseSha = git.mergeBase(this.repoRoot, baseRef, headSha);

    if (baseSha === headSha) {
      throw new PrError('head가 base와 같다. 리뷰할 변경이 없다', 4);
    }

    const prId = randomUUID().slice(0, 8);
    const headRef = input.head ?? git.currentBranch(this.repoRoot);

    // 이벤트보다 ref를 먼저 붙인다. 사이에 죽어도 커밋은 살아 있다
    git.pinRefs(this.repoRoot, prId, baseSha, headSha);

    this.store.append(PR_AGGREGATE, prId, PrEvent.CREATED, {
      title: input.title,
      body: input.body ?? '',
      author: input.author,
      baseSha,
      headSha,
      headRef,
      baseRef,
    });

    return this.require(prId);
  }

  /** head를 지금 커밋으로 옮긴다. 코멘트는 그대로 붙어 있다 */
  update(prId: string, head?: string): PullRequest {
    const pr = this.requireOpen(prId);
    const headSha = git.resolveSha(this.repoRoot, head ?? pr.headRef ?? 'HEAD');

    if (headSha === pr.headSha) {
      throw new PrError('head가 그대로다. 옮길 것이 없다', 4);
    }

    git.pinRefs(this.repoRoot, prId, pr.baseSha, headSha);
    this.store.append(PR_AGGREGATE, prId, PrEvent.UPDATED, {
      headSha,
      headRef: head ?? pr.headRef,
    });

    return this.require(prId);
  }

  // ─── 코멘트 ──────────────────────────────────────────────

  comment(
    prId: string,
    input: { author: Actor; path: string; line?: number; body: string; replyTo?: string },
  ): PullRequest {
    const pr = this.requireOpen(prId);

    let threadId: string;
    const commentId = randomUUID().slice(0, 8);

    if (input.replyTo) {
      const parent = pr.comments.find((c) => c.id === input.replyTo);
      if (!parent) throw new PrError(`코멘트를 못 찾았다: ${input.replyTo}`, 3);
      threadId = parent.threadId;
    } else {
      threadId = commentId;
    }

    this.store.append(PR_AGGREGATE, prId, PrEvent.COMMENT_ADDED, {
      commentId,
      author: input.author,
      path: input.path,
      line: input.line ?? null,
      body: input.body,
      threadId,
      headSha: pr.headSha,
    });

    return this.require(prId);
  }

  resolve(prId: string, commentId: string, by: Actor): PullRequest {
    const pr = this.requireOpen(prId);
    if (!pr.comments.some((c) => c.id === commentId)) {
      throw new PrError(`코멘트를 못 찾았다: ${commentId}`, 3);
    }

    this.store.append(PR_AGGREGATE, prId, PrEvent.COMMENT_RESOLVED, { commentId, by });
    return this.require(prId);
  }

  // ─── 판정 ────────────────────────────────────────────────

  review(
    prId: string,
    input: { reviewer: Actor; verdict: ReviewVerdict; summary: string },
  ): PullRequest {
    const pr = this.requireOpen(prId);

    this.store.append(PR_AGGREGATE, prId, PrEvent.REVIEW_SUBMITTED, {
      reviewId: randomUUID().slice(0, 8),
      reviewer: input.reviewer,
      verdict: input.verdict,
      summary: input.summary,
      headSha: pr.headSha,
    });

    return this.require(prId);
  }

  // ─── 마무리 ──────────────────────────────────────────────

  merge(prId: string, by: Actor, options: { deleteBranch?: boolean } = {}): PullRequest {
    const pr = this.requireOpen(prId);

    const { mergeSha } = git.mergeIntoBase(this.repoRoot, {
      prId,
      baseRef: pr.baseRef ?? 'main',
      headSha: pr.headSha,
      title: pr.title,
    });

    this.store.append(PR_AGGREGATE, prId, PrEvent.MERGED, {
      by,
      mergeSha,
      unresolvedCount: unresolvedCount(pr),
    });

    if (options.deleteBranch && pr.headRef) {
      try {
        git.deleteBranch(this.repoRoot, pr.headRef);
      } catch {
        // 이미 없거나 다른 워크트리가 잡고 있다. 머지는 끝났으니 넘어간다
      }
    }

    return this.require(prId);
  }

  closePr(prId: string, by: Actor, reason = ''): PullRequest {
    const pr = this.requireOpen(prId);
    this.store.append(PR_AGGREGATE, prId, PrEvent.CLOSED, { by, reason });
    git.unpinRefs(this.repoRoot, prId);
    return this.require(pr.id);
  }

  // ─── 안쪽 ────────────────────────────────────────────────

  private require(prId: string): PullRequest {
    const pr = this.repo.reconstruct(prId);
    if (!pr) throw new PrError(`PR을 못 찾았다: ${prId}`, 3);
    return pr;
  }

  private requireOpen(prId: string): PullRequest {
    const pr = this.require(prId);
    if (pr.status === 'merged' || pr.status === 'closed') {
      throw new PrError(`이미 ${pr.status} 상태다: ${prId}`, 4);
    }
    return pr;
  }
}

/**
 * 종료 코드를 달고 다니는 오류.
 *
 * 부르는 쪽이 에이전트라 stdout을 안 읽고도 갈래를 타야 한다.
 * 3은 못 찾음, 4는 상태 충돌이다.
 */
export class PrError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'PrError';
  }
}
