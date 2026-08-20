import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../../../src/events/store.js';
import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { PassthroughReviewEngine } from '../../../src/review/passthrough-engine.js';
import { handleReviewPassthrough } from '../../../src/mcp/tools/review-passthrough.js';
import { LocalPrEngine } from '../../../src/local-pr/engine.js';
import type { PullRequest } from '../../../src/local-pr/types.js';
import type { ExecuteInput } from '../../../src/mcp/schemas.js';

/**
 * 리뷰 파이프라인과 로컬 PR을 잇는 두 이음매를 본다.
 *
 * 로컬 PR은 git 위에서 도는 물건이라 진짜 레포를 만들어 돌린다. 리뷰 세션 쪽
 * 이벤트 저장소만 `.gestalt-test/` 아래 고유 경로를 쓴다.
 */

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

interface ReviewResponse {
  status?: string;
  error?: string;
  kind?: string;
  prId?: string | null;
  executeSessionId?: string | null;
  reviewSessionId?: string;
  verdict?: string;
  reviewer?: string;
  commentCount?: number;
  comments?: { path: string; line: number | null; author: string }[];
  reviewStartContext?: { changedFiles: string[] };
  alreadyPublished?: boolean;
  resumedFrom?: number;
  round?: number;
}

describe('리뷰 파이프라인 ↔ 로컬 PR', () => {
  let repo: string;
  let dbPath: string;
  let store: EventStore;
  let executeEngine: PassthroughExecuteEngine;
  let reviewEngine: PassthroughReviewEngine;
  let prId: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gestalt-review-pr-'));
    run(repo, ['init', '-q']);
    run(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    run(repo, ['config', 'user.email', 't@e.st']);
    run(repo, ['config', 'user.name', 'test']);

    writeFileSync(join(repo, 'a.txt'), 'line1\n');
    run(repo, ['add', '-A']);
    run(repo, ['commit', '-q', '-m', 'init']);

    run(repo, ['checkout', '-q', '-b', 'feat/x']);
    writeFileSync(join(repo, 'a.txt'), 'line1\nline2\n');
    run(repo, ['commit', '-q', '-am', '두 번째 줄']);

    const prEngine = new LocalPrEngine(repo);
    prId = prEngine.create({ title: '두 번째 줄', author: 'codex:worker-1' }).id;
    prEngine.dispose();

    dbPath = `.gestalt-test/review-local-pr-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    executeEngine = new PassthroughExecuteEngine(store);
    reviewEngine = new PassthroughReviewEngine(store);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
    rmSync(repo, { recursive: true, force: true });
  });

  function call(input: Partial<ExecuteInput>): ReviewResponse {
    return JSON.parse(
      handleReviewPassthrough(reviewEngine, executeEngine, undefined, input as ExecuteInput),
    ) as ReviewResponse;
  }

  function readPr(): PullRequest {
    const engine = new LocalPrEngine(repo);
    try {
      const pr = engine.get(prId);
      if (!pr) throw new Error('PR이 사라졌다');
      return pr;
    } finally {
      engine.dispose();
    }
  }

  /** prId로 리뷰를 열고 합의까지 밀어 넣는다 */
  function startAndAgree(
    issues: {
      severity: 'critical' | 'high' | 'warning';
      file: string;
      line?: number;
      reportedBy: string;
    }[],
    continuity?: { coherent: boolean; escalate: boolean },
  ): string {
    const started = call({ action: 'review_start', prId, repoRoot: repo });
    const reviewSessionId = started.reviewSessionId!;
    call({
      action: 'review_consensus',
      reviewSessionId,
      reviewConsensus: {
        mergedIssues: issues.map((i, idx) => ({
          id: `issue-${idx}`,
          severity: i.severity,
          category: 'security',
          file: i.file,
          line: i.line,
          message: `문제 ${idx}`,
          suggestion: `고치는 법 ${idx}`,
          reportedBy: i.reportedBy,
        })),
        approvedBy: [],
        blockedBy: [],
        summary: '합의 요약',
        overallApproved: false,
      },
      continuityVerdict: continuity
        ? {
            coherent: continuity.coherent,
            driftFindings: [],
            escalate: continuity.escalate,
            summary: '정합 요약',
          }
        : undefined,
    });
    return reviewSessionId;
  }

  // ─── 이음매 1: review_start가 로컬 PR을 받는다 ──────────────

  it('prId를 주면 PR의 변경 파일로 리뷰를 연다', () => {
    const parsed = call({ action: 'review_start', prId, repoRoot: repo });

    expect(parsed.error).toBeUndefined();
    expect(parsed.status).toBe('review_started');
    expect(parsed.prId).toBe(prId);
    expect(parsed.reviewStartContext!.changedFiles).toEqual(['a.txt']);
  });

  it('prId 리뷰 세션은 repoRoot를 PR 저장소로 잡는다', () => {
    const parsed = call({ action: 'review_start', prId, repoRoot: repo });
    const session = reviewEngine.getSession(parsed.reviewSessionId!);

    expect(session.repoRoot).toBe(repo);
    expect(session.prId).toBe(prId);
  });

  it('없는 prId면 not_found로 알린다', () => {
    const parsed = call({ action: 'review_start', prId: 'deadbeef', repoRoot: repo });

    expect(parsed.status).toBeUndefined();
    expect(parsed.kind).toBe('not_found');
  });

  it('changedFiles + repoRoot 갈래는 그대로 돈다 (회귀)', () => {
    const parsed = call({
      action: 'review_start',
      changedFiles: ['src/x.ts'],
      repoRoot: repo,
    });

    expect(parsed.error).toBeUndefined();
    expect(parsed.status).toBe('review_started');
    expect(parsed.prId).toBeNull();
    expect(parsed.reviewStartContext!.changedFiles).toEqual(['src/x.ts']);
  });

  it('세 갈래 중 아무것도 없으면 셋을 다 알려준다', () => {
    const parsed = call({ action: 'review_start' });

    expect(parsed.error).toContain('prId');
    expect(parsed.error).toContain('sessionId');
    expect(parsed.error).toContain('changedFiles');
  });

  // ─── 이음매 2: 합의 결과를 PR에 되돌려 쓴다 ────────────────

  it('지적의 파일과 라인이 그대로 코멘트 위치가 된다', () => {
    const reviewSessionId = startAndAgree([
      { severity: 'critical', file: 'a.txt', line: 2, reportedBy: 'security-reviewer' },
    ]);

    const parsed = call({ action: 'review_publish', reviewSessionId });
    expect(parsed.status).toBe('review_published');
    expect(parsed.commentCount).toBe(1);

    const pr = readPr();
    expect(pr.comments).toHaveLength(1);
    expect(pr.comments[0]!.path).toBe('a.txt');
    expect(pr.comments[0]!.line).toBe(2);
  });

  it('라인이 없는 지적은 파일 전체 코멘트가 된다', () => {
    const reviewSessionId = startAndAgree([
      { severity: 'warning', file: 'a.txt', reportedBy: 'quality-reviewer' },
    ]);

    call({ action: 'review_publish', reviewSessionId });

    expect(readPr().comments[0]!.line).toBeNull();
  });

  it('코멘트 작성자로 어느 리뷰 에이전트가 냈는지 남는다', () => {
    const reviewSessionId = startAndAgree([
      { severity: 'high', file: 'a.txt', line: 1, reportedBy: 'security-reviewer' },
      { severity: 'warning', file: 'a.txt', line: 2, reportedBy: 'quality-reviewer' },
    ]);

    call({ action: 'review_publish', reviewSessionId });

    const authors = readPr().comments.map((c) => c.author);
    expect(authors).toEqual(['agent:security-reviewer', 'agent:quality-reviewer']);
  });

  it('코멘트 본문에 심각도와 제안이 담긴다', () => {
    const reviewSessionId = startAndAgree([
      { severity: 'critical', file: 'a.txt', line: 2, reportedBy: 'security-reviewer' },
    ]);

    call({ action: 'review_publish', reviewSessionId });

    const body = readPr().comments[0]!.body;
    expect(body).toContain('critical');
    expect(body).toContain('문제 0');
    expect(body).toContain('고치는 법 0');
  });

  it('critical이 있으면 request_changes로 내린다', () => {
    const reviewSessionId = startAndAgree([
      { severity: 'critical', file: 'a.txt', line: 2, reportedBy: 'security-reviewer' },
    ]);

    const parsed = call({
      action: 'review_publish',
      reviewSessionId,
      prReviewer: 'codex:worker-5',
    });

    expect(parsed.verdict).toBe('request_changes');
    const pr = readPr();
    expect(pr.status).toBe('changes_requested');
    expect(pr.reviews[0]!.reviewer).toBe('codex:worker-5');
    expect(pr.reviews[0]!.summary).toBe('합의 요약');
  });

  it('high도 request_changes로 내린다', () => {
    const reviewSessionId = startAndAgree([
      { severity: 'high', file: 'a.txt', line: 2, reportedBy: 'performance-reviewer' },
    ]);

    expect(call({ action: 'review_publish', reviewSessionId }).verdict).toBe('request_changes');
  });

  it('warning만 남으면 approve로 내린다', () => {
    const reviewSessionId = startAndAgree([
      { severity: 'warning', file: 'a.txt', line: 2, reportedBy: 'quality-reviewer' },
    ]);

    const parsed = call({ action: 'review_publish', reviewSessionId });

    expect(parsed.verdict).toBe('approve');
    expect(readPr().reviews[0]!.verdict).toBe('approve');
  });

  it('정합 심급이 막으면 결함이 없어도 request_changes다', () => {
    const reviewSessionId = startAndAgree(
      [{ severity: 'warning', file: 'a.txt', line: 2, reportedBy: 'quality-reviewer' }],
      { coherent: false, escalate: true },
    );

    expect(call({ action: 'review_publish', reviewSessionId }).verdict).toBe('request_changes');
  });

  it('prId는 리뷰를 연 세션에서 이어받는다', () => {
    const reviewSessionId = startAndAgree([
      { severity: 'warning', file: 'a.txt', reportedBy: 'quality-reviewer' },
    ]);

    // prId를 다시 주지 않았는데도 그 PR에 붙는다
    expect(call({ action: 'review_publish', reviewSessionId }).prId).toBe(prId);
  });

  it('합의 전에 부르면 review_consensus부터 하라고 알린다', () => {
    const started = call({ action: 'review_start', prId, repoRoot: repo });

    const parsed = call({ action: 'review_publish', reviewSessionId: started.reviewSessionId });

    expect(parsed.status).toBeUndefined();
    expect(parsed.error).toContain('review_consensus');
  });

  // ─── 재실행 방어 ───────────────────────────────────────────

  it('같은 합의를 두 번 옮겨도 코멘트가 늘지 않는다', () => {
    const reviewSessionId = startAndAgree([
      { severity: 'critical', file: 'a.txt', line: 2, reportedBy: 'security-reviewer' },
    ]);

    const first = call({ action: 'review_publish', reviewSessionId });
    const second = call({ action: 'review_publish', reviewSessionId });

    expect(first.alreadyPublished).toBeUndefined();
    expect(second.alreadyPublished).toBe(true);
    expect(second.verdict).toBe(first.verdict);
    expect(second.round).toBe(first.round);

    const pr = readPr();
    expect(pr.comments).toHaveLength(1);
    expect(pr.reviews).toHaveLength(1);
  });

  it('head가 옮겨가면 새 라운드라 다시 옮긴다', () => {
    const reviewSessionId = startAndAgree([
      { severity: 'critical', file: 'a.txt', line: 2, reportedBy: 'security-reviewer' },
    ]);
    call({ action: 'review_publish', reviewSessionId });

    // 작성자가 고쳐 올렸다 — PR의 head가 새 커밋으로 옮겨간다
    writeFileSync(join(repo, 'a.txt'), 'line1\nline2\nline3\n');
    run(repo, ['commit', '-q', '-am', '세 번째 줄']);
    const prEngine = new LocalPrEngine(repo);
    prEngine.update(prId);
    prEngine.dispose();

    const again = call({ action: 'review_publish', reviewSessionId });

    expect(again.alreadyPublished).toBeUndefined();
    expect(again.commentCount).toBe(1);
    expect(readPr().comments).toHaveLength(2);
  });

  it('코멘트 루프 중간에 던지면 재시도가 쓴 것을 다시 쓰지 않는다', () => {
    const reviewSessionId = startAndAgree([
      { severity: 'high', file: 'a.txt', line: 1, reportedBy: 'security-reviewer' },
      { severity: 'high', file: 'a.txt', line: 2, reportedBy: 'security-reviewer' },
      { severity: 'warning', file: 'a.txt', line: 3, reportedBy: 'quality-reviewer' },
    ]);

    // 세 번째 코멘트에서 던지게 만든다. 앞의 둘은 PR에 남는다.
    const real = LocalPrEngine.prototype.comment;
    let calls = 0;
    const spy = vi.spyOn(LocalPrEngine.prototype, 'comment').mockImplementation(function (
      this: LocalPrEngine,
      ...args
    ) {
      calls += 1;
      if (calls === 3) throw new Error('저장소가 잠겼다');
      return real.apply(this, args) as ReturnType<typeof real>;
    });

    const failed = call({ action: 'review_publish', reviewSessionId });
    spy.mockRestore();

    expect(failed.status).toBeUndefined();
    expect(readPr().comments).toHaveLength(2);
    expect(readPr().reviews).toHaveLength(0);

    const retried = call({ action: 'review_publish', reviewSessionId });

    expect(retried.status).toBe('review_published');
    expect(retried.resumedFrom).toBe(2);
    expect(retried.commentCount).toBe(1);
    expect(readPr().comments).toHaveLength(3);
    expect(readPr().reviews).toHaveLength(1);
  });

  it('합의를 다시 내면 앞선 publish 자국을 버린다', () => {
    const reviewSessionId = startAndAgree([
      { severity: 'warning', file: 'a.txt', line: 2, reportedBy: 'quality-reviewer' },
    ]);
    call({ action: 'review_publish', reviewSessionId });

    // 같은 세션에 새 합의가 들어왔다 — 옮길 목록이 통째로 바뀐다
    call({
      action: 'review_consensus',
      reviewSessionId,
      reviewConsensus: {
        mergedIssues: [
          {
            id: 'issue-new',
            severity: 'critical',
            category: 'security',
            file: 'a.txt',
            line: 1,
            message: '새 지적',
            suggestion: '새 제안',
            reportedBy: 'security-reviewer',
          },
        ],
        approvedBy: [],
        blockedBy: [],
        summary: '두 번째 합의',
        overallApproved: false,
      },
    });

    const parsed = call({ action: 'review_publish', reviewSessionId });

    expect(parsed.alreadyPublished).toBeUndefined();
    expect(parsed.verdict).toBe('request_changes');
    expect(readPr().comments.map((c) => c.body)).toContainEqual(expect.stringContaining('새 지적'));
  });

  // ─── 오류 규약 ─────────────────────────────────────────────

  it('없는 prId로 publish하면 not_found로 접는다', () => {
    const reviewSessionId = startAndAgree([
      { severity: 'warning', file: 'a.txt', reportedBy: 'quality-reviewer' },
    ]);

    const parsed = call({ action: 'review_publish', reviewSessionId, prId: 'deadbeef' });

    expect(parsed.status).toBeUndefined();
    expect(parsed.kind).toBe('not_found');
  });

  it('머지된 PR에 publish하면 conflict로 접는다', () => {
    const reviewSessionId = startAndAgree([
      { severity: 'warning', file: 'a.txt', reportedBy: 'quality-reviewer' },
    ]);
    const prEngine = new LocalPrEngine(repo);
    prEngine.merge(prId, 'human:tienne');
    prEngine.dispose();

    const parsed = call({ action: 'review_publish', reviewSessionId });

    expect(parsed.status).toBeUndefined();
    expect(parsed.kind).toBe('conflict');
  });

  it('prId가 sessionId 셀렉터보다 앞선다', () => {
    // 실행 세션이 하나도 없어 latest는 해석되지 않는다. prId 갈래는 그것과 무관하다.
    const parsed = call({ action: 'review_start', prId, repoRoot: repo, sessionId: 'latest' });

    expect(parsed.error).toBeUndefined();
    expect(parsed.status).toBe('review_started');
    expect(parsed.prId).toBe(prId);
    expect(parsed.executeSessionId).toBeNull();
  });

  it('PR을 못 찾는 세션이면 prId를 요구한다', () => {
    const started = call({ action: 'review_start', changedFiles: ['a.txt'], repoRoot: repo });
    call({
      action: 'review_consensus',
      reviewSessionId: started.reviewSessionId,
      reviewConsensus: {
        mergedIssues: [],
        approvedBy: [],
        blockedBy: [],
        summary: '',
        overallApproved: true,
      },
    });

    const parsed = call({ action: 'review_publish', reviewSessionId: started.reviewSessionId });

    expect(parsed.error).toContain('prId');
  });
});
