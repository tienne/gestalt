import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePr } from '../../../src/mcp/tools/pr.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import { prInputSchema } from '../../../src/mcp/schemas.js';
import type { PrInput } from '../../../src/mcp/schemas.js';

/**
 * `ges_pr`은 LocalPrEngine을 그대로 부르는 껍데기다. 진짜 로직은
 * tests/unit/local-pr/engine.test.ts가 검증하니, 여기서는 action 분배와
 * 에러를 `{ error, kind }`로 접는 부분만 본다. 그래도 진짜 git 레포 위에서
 * 돌려야 이 매핑이 실제로 맞물리는지 볼 수 있다 (CM-8).
 */

/** MCP SDK가 등록한 도구를 들여다보는 자리. 공개 API가 없어 내부 맵을 읽는다 */
interface RegisteredTools {
  _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }>;
}

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

  it('update: head 인자로 준 커밋으로 옮긴다', async () => {
    const pr = await call({ action: 'create', title: 'A', author: 'codex:worker-1' });

    writeFileSync(join(repo, 'a.txt'), 'line1\nline2\nline3\n');
    run(repo, ['commit', '-q', '-am', '세 번째 줄']);
    const third = run(repo, ['rev-parse', 'HEAD']);

    writeFileSync(join(repo, 'a.txt'), 'line1\nline2\nline3\nline4\n');
    run(repo, ['commit', '-q', '-am', '네 번째 줄']);
    const fourth = run(repo, ['rev-parse', 'HEAD']);

    // head를 안 넘기면 브랜치 끝(fourth)으로 간다. third를 명시했으니 거기 멈춰야
    // 인자가 엔진까지 갔다는 뜻이다.
    const after = await call({
      action: 'update',
      id: pr.id,
      head: third,
      author: 'codex:worker-1',
    });
    expect(after.headSha).toBe(third);
    expect(after.headSha).not.toBe(fourth);
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
    const after = await call({
      action: 'close',
      id: pr.id,
      reason: '보류',
      author: 'codex:worker-1',
    });
    expect(after.status).toBe('closed');
  });
  it('checkout_remove: force가 엔진까지 간다', async () => {
    const pr = await call({ action: 'create', title: 'A', author: 'a' });
    const co = await call({ action: 'checkout', id: pr.id });
    writeFileSync(join(co.path, 'a.txt'), '일부러 깬 코드\n');

    // 지킬 변경이 있으면 안 지운다. force를 안 넘기면 이 갈림이 사라진다
    expect((await call({ action: 'checkout_remove', id: pr.id })).status).toBe('dirty');
    expect((await call({ action: 'checkout_remove', id: pr.id, force: true })).status).toBe(
      'removed',
    );
  });

  describe('repoRoot 경계', () => {
    it('다른 레포를 가리키면 손대지 않고 막는다', async () => {
      const other = mkdtempSync(join(tmpdir(), 'gestalt-pr-other-'));
      run(other, ['init', '-q']);
      run(other, ['config', 'user.email', 't@e.st']);
      run(other, ['config', 'user.name', 'test']);
      writeFileSync(join(other, 'x.txt'), 'x\n');
      run(other, ['add', '-A']);
      run(other, ['commit', '-q', '-m', 'init']);

      try {
        const raw = await handlePr(
          { action: 'list', repoRoot: other } as PrInput,
          repo, // 지금 자리는 repo다. other는 남의 레포다
        );
        const result = JSON.parse(raw);

        expect(result.error).toContain(other);
        expect(result.kind).toBe('invalid');
        // 막았으면 그 레포에 저장소도 안 만든다
        expect(existsSync(join(other, '.gestalt'))).toBe(false);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });

    it('git 레포가 아닌 경로도 막는다', async () => {
      const plain = mkdtempSync(join(tmpdir(), 'gestalt-pr-plain-'));
      try {
        const raw = await handlePr({ action: 'list', repoRoot: plain } as PrInput, repo);
        expect(JSON.parse(raw).kind).toBe('invalid');
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    });

    it('같은 레포의 워크트리와 하위 디렉토리는 그대로 통과한다', async () => {
      // 이 인자가 있는 이유가 그거다. 좁히면서 이 쓰임까지 닫으면 안 된다
      const created = await call({ action: 'create', title: 'A', author: 'a' });

      const sub = join(repo, 'sub');
      mkdirSync(sub);
      const fromSub = JSON.parse(
        await handlePr({ action: 'list', repoRoot: sub } as PrInput, repo),
      );
      expect(fromSub.map((pr: { id: string }) => pr.id)).toEqual([created.id]);

      const wt = mkdtempSync(join(tmpdir(), 'gestalt-pr-wt-'));
      rmSync(wt, { recursive: true, force: true });
      run(repo, ['worktree', 'add', '-q', wt, '-b', 'feat/y']);
      try {
        const fromWt = JSON.parse(
          await handlePr({ action: 'list', repoRoot: wt } as PrInput, repo),
        );
        expect(fromWt.map((pr: { id: string }) => pr.id)).toEqual([created.id]);
      } finally {
        run(repo, ['worktree', 'remove', '--force', wt]);
      }
    });
  });

  it('서버에 등록한 인자가 스키마에서 그대로 온다', async () => {
    // 등록 목록에 없는 인자는 MCP 클라이언트가 보낼 수 없다. 예전에는 이 목록이
    // server.ts에 손으로 한 벌 더 적혀 있었다. 이 테스트는 키 이름만 맞대고 있었다.
    // 이름이 같으면 통과하니 `.describe()`가 등록 쪽에 하나도 없는 것은 안 잡혔다 —
    // 도구를 부르는 모델은 인자 설명을 못 보고 있었다.
    //
    // 지금은 등록이 스키마에서 파생된다. 그래서 같은 목록인지가 아니라 **같은
    // 물건인지**를 본다. 필드 하나를 손으로 다시 적으면 동일성이 깨져 여기서 걸린다.
    const dbFile = `.gestalt-test/pr-schema-${randomUUID()}.db`;
    const { server, eventStore } = await createMcpServer({
      dbPath: dbFile,
      llm: { apiKey: '', model: 'test-model' },
    });

    try {
      const tools = (server as unknown as RegisteredTools)._registeredTools;
      const registered = tools['ges_pr']?.inputSchema?.shape ?? {};

      expect(Object.keys(registered).sort()).toEqual(Object.keys(prInputSchema.shape).sort());
      for (const [name, field] of Object.entries(prInputSchema.shape)) {
        expect(registered[name]).toBe(field);
      }

      // 파생의 값은 설명이 함께 오는 것이다. 하나를 짚어 실제로 실렸는지 본다
      const author = registered['author'] as { description?: string };
      expect(author.description).toContain('claude-code:main');
    } finally {
      eventStore.close();
      for (const suffix of ['', '-wal', '-shm', '.jsonl']) {
        const file = `${dbFile}${suffix}`;
        if (existsSync(file)) rmSync(file);
      }
    }
  });
});
