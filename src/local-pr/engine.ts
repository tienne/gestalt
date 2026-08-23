import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventStore } from '../events/store.js';
import type { IEventStore } from '../events/store.js';
import * as git from './git.js';
import { registerRepo } from './registry.js';
import { unresolvedCount } from './policy.js';
import { PrEvent, PullRequestRepository } from './repository.js';
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

  /**
   * PR head를 임시 워크트리로 떼어 놓고 그 경로를 준다.
   *
   * 리뷰어가 코드를 깨서 테스트가 잡는지 보려면 실물 파일이 필요하다. diff만으로는
   * 못 하는 검증이다. 닫히거나 머지된 PR도 떼어낼 수 있게 열림 여부는 안 본다 —
   * 머지된 뒤에 "그때 그 코드가 맞았나"를 되짚는 자리가 있다.
   */
  checkout(prId: string): git.PrCheckout {
    const pr = this.require(prId);

    if (!git.commitExists(this.repoRoot, pr.headSha)) {
      throw new PrError(`head 커밋이 이 레포에 없다: ${pr.headSha.slice(0, 8)}`, 3);
    }

    return git.checkoutPrHead(this.repoRoot, prId, pr.headSha);
  }

  /**
   * 떼어 놓은 워크트리를 지운다.
   *
   * 지킬 변경이 있으면 지우지 않고 그 사실을 돌려준다. 부르는 쪽은 결과의 `status`로
   * 갈래를 탄다. PR head를 함께 넘겨야 그 자리에서 쌓은 커밋을 가려낼 수 있다.
   */
  removeCheckout(prId: string, options: { force?: boolean } = {}): git.CheckoutRemoval {
    const pr = this.require(prId);
    return git.removePrCheckout(this.repoRoot, prId, { ...options, headSha: pr.headSha });
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

    // 이 레포에 로컬 PR이 생겼다는 걸 전역 목록에 남긴다. 웹 UI 하나가 여러 레포를
    // 보여주려면 어떤 레포가 있는지 알아야 하는데, 그걸 요청이 정하게 둘 수 없다
    try {
      registerRepo(this.repoRoot);
    } catch {
      // 목록에 못 넣어도 PR 자체는 만들어진다. 웹에서 안 보일 뿐이다
    }

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

  /**
   * 코멘트 여러 개를 한 번에 붙인다.
   *
   * `comment`를 N번 부르면 하나마다 PR 전체를 두 번 재생한다 — 앞에서 상태를 얻고
   * 뒤에서 돌려주느라 그렇다. 재생 대상 이벤트도 붙일수록 늘어서 총 비용이 개수의
   * 제곱으로 커진다. 리뷰 합의를 옮기는 자리는 수십에서 수백 개라 그 자리를 밟는다.
   *
   * 상태는 한 번만 접고 이벤트만 이어 붙인다. `onPosted`는 하나 쓸 때마다 그 입력의
   * 인덱스로 부른다 — 중간에 던져도 어디까지 썼는지가 부르는 쪽에 남아야 재시도가
   * 다시 안 쓴다. 부르는 쪽은 이 인덱스로 재개 지점을 잡는다. 자기 카운터를 따로
   * 올리면 두 계산이 갈릴 때 재개 지점이 밀려 코멘트가 겹치거나 빠진다.
   */
  commentMany(
    prId: string,
    inputs: { author: Actor; path: string; line?: number; body: string; marker?: string }[],
    onPosted?: (index: number) => void,
  ): PullRequest {
    const pr = this.requireOpen(prId);

    inputs.forEach((input, i) => {
      const commentId = randomUUID().slice(0, 8);
      this.store.append(PR_AGGREGATE, prId, PrEvent.COMMENT_ADDED, {
        commentId,
        author: input.author,
        path: input.path,
        line: input.line ?? null,
        body: input.body,
        threadId: commentId,
        headSha: pr.headSha,
        ...(input.marker ? { marker: input.marker } : {}),
      });
      onPosted?.(i);
    });

    return this.require(prId);
  }

  comment(
    prId: string,
    input: {
      author: Actor;
      path: string;
      line?: number;
      body: string;
      replyTo?: string;
      marker?: string;
    },
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
      ...(input.marker ? { marker: input.marker } : {}),
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

  /**
   * 붙잡아 둘 이유가 끝난 ref를 놓는다.
   *
   * `refs/gestalt/` 아래는 지금까지 단조 증가만 했다. 머지된 PR도 base와 head를
   * 영구 보유한다. `--force` 한 바퀴마다 체크아웃 자국도 한 칸씩 더 쌓인다. 지우는
   * 명령도 만료도 없어서 오래 쓴 레포일수록 `for-each-ref`가 느려지고 `git gc`가
   * 놓지 못하는 객체가 늘어난다.
   *
   * 무엇을 놓는지는 "놓아도 커밋이 안 사라지는가"로 가른다.
   *
   * - **머지된 PR의 base와 head**를 놓는다. 머지 커밋이 base 브랜치 이력에 둘을
   *   모두 넣었으므로 ref를 놓아도 되짚을 수 있다. `unpinRefs`가 닫힌 PR의 base에
   *   대해 이미 쓰는 근거와 같다. 그래도 놓기 전에 head가 정말 base 이력에 있는지
   *   확인한다 — 머지 뒤 누가 base를 되돌렸으면 그 근거가 깨진다. 그때는 안 놓고
   *   이유를 돌려준다.
   * - **닫힌 PR은 아무것도 안 놓는다.** head를 붙잡아 두기로 한 결정이 그대로다.
   *   닫힌 PR도 `checkout`으로 떼어낸다고 약속했다.
   * - **체크아웃 자국(`refs/gestalt/pr-checkout/...`)은 기본으로 안 놓는다.** 그건
   *   어느 이력에도 안 들어간 워크트리 전용 커밋이라 놓으면 영영 사라진다.
   *   `checkouts`로 뜻을 밝혔을 때, 그리고 그 PR이 이미 머지되거나 닫혀 리뷰가
   *   끝났을 때만 놓는다.
   *
   * `dryRun`이면 무엇을 놓을지만 돌려주고 손대지 않는다.
   */
  prune(options: { checkouts?: boolean; dryRun?: boolean } = {}): PruneResult {
    const released: string[] = [];
    const kept: { prId: string; reason: string }[] = [];

    for (const pr of this.repo.reconstructAll()) {
      if (pr.status === 'merged') {
        const baseRef = pr.baseRef ?? 'main';
        if (git.isAncestor(this.repoRoot, pr.headSha, baseRef)) {
          released.push(`${git.PR_REF_ROOT}/${pr.id}/base`, `${git.PR_REF_ROOT}/${pr.id}/head`);
        } else {
          kept.push({
            prId: pr.id,
            reason: `머지된 뒤 base ${baseRef}가 되돌아가 head가 그 이력에 없다`,
          });
        }
      }

      if (options.checkouts && (pr.status === 'merged' || pr.status === 'closed')) {
        released.push(...git.refsUnder(this.repoRoot, `${git.CHECKOUT_REF_ROOT}/${pr.id}`));
      }
    }

    // 붙어 있지도 않은 ref를 놓았다고 세지 않는다. 머지 PR의 base는 close 경로에서
    // 이미 놓였을 수 있다. prune을 두 번 부르면 두 번째는 놓을 게 없다
    const existing = new Set([
      ...git.refsUnder(this.repoRoot, git.PR_REF_ROOT),
      ...git.refsUnder(this.repoRoot, git.CHECKOUT_REF_ROOT),
    ]);
    const targets = released.filter((ref) => existing.has(ref));

    // 확인과 삭제 사이에 base가 되돌아가면 근거가 깨진 채로 놓는다. 그 사이를 막지 않은
    // 건 잃는 게 ref뿐이어서다 — 커밋은 reflog에 남고 PR 기록에 sha가 있어 되살린다
    if (!options.dryRun) {
      for (const ref of targets) git.deleteRef(this.repoRoot, ref);
    }

    return { released: targets, kept, dryRun: options.dryRun === true };
  }

  closePr(prId: string, by: Actor, reason = ''): PullRequest {
    const pr = this.requireOpen(prId);
    this.store.append(PR_AGGREGATE, prId, PrEvent.CLOSED, { by, reason });
    // base ref만 놓는다. head를 놓으면 닫힌 PR의 커밋이 gc에 수거돼 checkout도 diff도
    // 죽는데, checkout은 닫힌 PR도 떼어낸다고 약속한 자리다
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

/** `prune`이 무엇을 놓았고 무엇을 왜 남겼는지 */
export interface PruneResult {
  /** 놓은 ref 이름 */
  released: string[];
  /** 놓을 만했지만 근거가 깨져 남긴 PR */
  kept: { prId: string; reason: string }[];
  /** true면 아무것도 안 놓고 목록만 돌려줬다 */
  dryRun: boolean;
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
