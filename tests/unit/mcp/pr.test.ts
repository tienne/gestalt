import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePr } from '../../../src/mcp/tools/pr.js';
import type { PrInput } from '../../../src/mcp/schemas.js';

/**
 * `ges_pr`은 LocalPrEngine을 그대로 부르는 껍데기다. 진짜 로직은
 * tests/unit/local-pr/engine.test.ts가 검증하니, 여기서는 action 분배와
 * 에러를 `{ error, kind }`로 접는 부분만 본다. 그래도 진짜 git 레포 위에서
 * 돌려야 이 매핑이 실제로 맞물리는지 볼 수 있다 (CM-8).
 */

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('handlePr — ges_pr MCP 래퍼', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gestalt-pr-mcp-'));
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
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  async function call(input: Omit<PrInput, 'repoRoot'>) {
    const raw = await handlePr({ ...input, repoRoot: repo } as PrInput, repo);
    return JSON.parse(raw);
  }

  it('create: title이 없으면 invalid 에러를 돌려준다', async () => {
    const result = await call({ action: 'create', author: 'codex:worker-1' });
    expect(result.error).toBeTruthy();
    expect(result.kind).toBe('invalid');
  });

  it('create: title만 있으면 PR을 만들고 open 상태로 돌려준다', async () => {
    const pr = await call({ action: 'create', title: '두 번째 줄', author: 'codex:worker-1' });
    expect(pr.status).toBe('open');
    expect(pr.title).toBe('두 번째 줄');
    expect(pr.id).toBeTruthy();
  });

  it('get: 없는 id는 PrError(exitCode 3)를 kind: not_found로 접는다', async () => {
    const result = await call({ action: 'get', id: 'nope0000' });
    expect(result.error).toContain('nope0000');
    expect(result.kind).toBe('not_found');
  });

  it('list: 만든 PR이 목록에 뜬다', async () => {
    await call({ action: 'create', title: 'A', author: 'codex:worker-1' });
    const prs = await call({ action: 'list' });
    expect(Array.isArray(prs)).toBe(true);
    expect(prs).toHaveLength(1);
  });

  it('diff: 생성 시점의 변경 내용을 문자열로 돌려준다', async () => {
    const pr = await call({ action: 'create', title: 'A', author: 'codex:worker-1' });
    const result = await call({ action: 'diff', id: pr.id });
    expect(result.diff).toContain('line2');
  });

  it('comment: path나 body가 없으면 invalid 에러를 돌려준다', async () => {
    const pr = await call({ action: 'create', title: 'A', author: 'codex:worker-1' });
    const missingBody = await call({ action: 'comment', id: pr.id, path: 'a.txt' });
    expect(missingBody.kind).toBe('invalid');

    const missingPath = await call({ action: 'comment', id: pr.id, body: '봐주세요' });
    expect(missingPath.kind).toBe('invalid');
  });

  it('comment와 resolve: 코멘트를 달고 해결 상태로 바꾼다', async () => {
    const pr = await call({ action: 'create', title: 'A', author: 'codex:worker-1' });
    const afterComment = await call({
      action: 'comment',
      id: pr.id,
      path: 'a.txt',
      line: 2,
      body: '이 줄 확인해주세요',
      author: 'reviewer:x',
    });
    const commentId = afterComment.comments[0].id;
    expect(afterComment.comments[0].resolved).toBe(false);

    const afterResolve = await call({
      action: 'resolve',
      id: pr.id,
      commentId,
      author: 'reviewer:x',
    });
    expect(afterResolve.comments[0].resolved).toBe(true);
  });

  it('review: verdict가 없으면 invalid 에러를 돌려준다', async () => {
    const pr = await call({ action: 'create', title: 'A', author: 'codex:worker-1' });
    const result = await call({ action: 'review', id: pr.id, summary: '괜찮아 보인다' });
    expect(result.kind).toBe('invalid');
  });

  it('review: approve 판정을 기록한다', async () => {
    const pr = await call({ action: 'create', title: 'A', author: 'codex:worker-1' });
    const after = await call({
      action: 'review',
      id: pr.id,
      verdict: 'approve',
      summary: 'LGTM',
      author: 'reviewer:x',
    });
    expect(after.reviews[0].verdict).toBe('approve');
  });

  it('update: 새 커밋으로 head를 옮긴다', async () => {
    const pr = await call({ action: 'create', title: 'A', author: 'codex:worker-1' });

    writeFileSync(join(repo, 'a.txt'), 'line1\nline2\nline3\n');
    run(repo, ['commit', '-q', '-am', '세 번째 줄']);

    const after = await call({ action: 'update', id: pr.id, author: 'codex:worker-1' });
    expect(after.headSha).not.toBe(pr.headSha);
  });

  it('merge: 상태를 merged로 바꾼다', async () => {
    const pr = await call({ action: 'create', title: 'A', author: 'codex:worker-1' });
    const after = await call({ action: 'merge', id: pr.id, author: 'codex:worker-1' });
    expect(after.status).toBe('merged');
  });

  it('merge: 이미 닫힌 PR을 다시 건드리면 conflict로 접힌다', async () => {
    const pr = await call({ action: 'create', title: 'A', author: 'codex:worker-1' });
    await call({ action: 'close', id: pr.id, author: 'codex:worker-1' });

    const result = await call({ action: 'merge', id: pr.id, author: 'codex:worker-1' });
    expect(result.kind).toBe('conflict');
  });

  it('close: 상태를 closed로 바꾼다', async () => {
    const pr = await call({ action: 'create', title: 'A', author: 'codex:worker-1' });
    const after = await call({ action: 'close', id: pr.id, reason: '보류', author: 'codex:worker-1' });
    expect(after.status).toBe('closed');
  });
});
