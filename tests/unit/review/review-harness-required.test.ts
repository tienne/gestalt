import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { EventStore } from '../../../src/events/store.js';
import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { PassthroughReviewEngine } from '../../../src/review/passthrough-engine.js';
import { handleReviewPassthrough } from '../../../src/mcp/tools/review-passthrough.js';
import type { ExecuteInput } from '../../../src/mcp/schemas.js';

interface Response {
  error?: string;
  reviewSessionId?: string;
  expectedCount?: number;
  submittedCount?: number;
  status?: string;
}

describe('review_consensus: harness-reviewer 필수', () => {
  let dbPath: string;
  let store: EventStore;
  let executeEngine: PassthroughExecuteEngine;
  let reviewEngine: PassthroughReviewEngine;

  beforeEach(() => {
    dbPath = `.gestalt-test/review-harness-required-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    executeEngine = new PassthroughExecuteEngine(store);
    reviewEngine = new PassthroughReviewEngine(store);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  function call(input: Partial<ExecuteInput>): Response {
    return JSON.parse(
      handleReviewPassthrough(reviewEngine, executeEngine, undefined, input as ExecuteInput),
    ) as Response;
  }

  function start(changedFiles: string[]): string {
    const res = call({ action: 'review_start', changedFiles, repoRoot: '/nonexistent-repo' });
    expect(res.error).toBeUndefined();
    return res.reviewSessionId!;
  }

  function submit(reviewSessionId: string, agentName: string): Response {
    return call({
      action: 'review_submit',
      reviewSessionId,
      reviewAgentName: agentName,
      reviewResult: { issues: [], approved: true, summary: 'ok' },
    });
  }

  function consensus(reviewSessionId: string): Response {
    return call({
      action: 'review_consensus',
      reviewSessionId,
      reviewConsensus: {
        mergedIssues: [],
        approvedBy: [],
        blockedBy: [],
        summary: '합의 요약',
        overallApproved: true,
      },
    });
  }

  it('harness-reviewer를 빼고 제출해도 기대 개수에 들어가 있다', () => {
    const id = start(['plugin/skills/foo/SKILL.md']);

    const res = submit(id, 'quality-reviewer');

    expect(res.error).toBeUndefined();
    expect(res.expectedCount).toBe(2);
    expect(res.submittedCount).toBe(1);
  });

  it('harness-reviewer 결과 없이 합의를 부르면 빠진 에이전트를 짚어 거절한다', () => {
    const id = start(['plugin/skills/foo/SKILL.md']);
    submit(id, 'quality-reviewer');

    const res = consensus(id);

    expect(res.error).toContain('harness-reviewer');
    expect(res.error).toContain('plugin/skills/foo/SKILL.md');
    expect(res.status).toBeUndefined();
  });

  it('harness-reviewer가 제출하면 합의가 통과한다', () => {
    const id = start(['plugin/skills/foo/SKILL.md']);
    submit(id, 'quality-reviewer');
    submit(id, 'harness-reviewer');

    const res = consensus(id);

    expect(res.error).toBeUndefined();
  });

  it('하네스 대상이 없으면 기존처럼 harness-reviewer 없이 합의한다', () => {
    const id = start(['src/a.ts']);

    const submitted = submit(id, 'quality-reviewer');
    expect(submitted.expectedCount).toBe(1);

    const res = consensus(id);
    expect(res.error).toBeUndefined();
  });
});
