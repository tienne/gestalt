import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../../../src/events/store.js';
import { LocalPrEngine, PrError } from '../../../src/local-pr/engine.js';
import { PullRequestRepository, unresolvedCount } from '../../../src/local-pr/repository.js';
import * as git from '../../../src/local-pr/git.js';

/**
 * 로컬 PR은 git 위에서 도는 물건이라 진짜 레포를 만들어 돌린다.
 *
 * 주석이 단언한 보장마다 여기에 대응 케이스가 있다 (CM-8) — ref로 커밋을 붙잡는 것,
 * 워크트리가 같은 목록을 보는 것, 본문이 안 깨지는 것, 이벤트만으로 상태가 서는 것.
 */

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('LocalPrEngine', () => {
  let repo: string;
  let engine: LocalPrEngine;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gestalt-pr-'));
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

    engine = new LocalPrEngine(repo);
  });

  afterEach(() => {
    engine.dispose();
    rmSync(repo, { recursive: true, force: true });
  });

  it('현재 HEAD로 PR을 만들고 base와 head를 잡는다', () => {
    const pr = engine.create({ title: '두 번째 줄', author: 'codex:worker-1' });

    expect(pr.status).toBe('open');
    expect(pr.headRef).toBe('feat/x');
    expect(pr.baseSha).not.toBe(pr.headSha);
    expect(pr.rounds).toHaveLength(1);
  });

  it('base와 head가 같으면 만들지 않는다', () => {
    run(repo, ['checkout', '-q', 'main']);
    expect(() => engine.create({ title: '빈 변경', author: 'a' })).toThrow(PrError);
  });

  it('브랜치를 지워도 diff가 그대로 나온다', () => {
    const pr = engine.create({ title: '두 번째 줄', author: 'codex:worker-1' });

    run(repo, ['checkout', '-q', 'main']);
    run(repo, ['branch', '-D', 'feat/x']);
    // ref가 안 붙었으면 여기서 커밋이 떠내려간다
    run(repo, ['gc', '--prune=now', '--quiet']);

    expect(git.commitExists(repo, pr.headSha)).toBe(true);
    expect(engine.diff(pr.id)).toContain('line2');
  });

  it('한글과 백틱, 줄바꿈이 섞인 본문이 그대로 저장된다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const body = '이 줄에서 `line2`를 덧붙이는데,\n경계 조건을 안 봅니다.\n\n빈 파일이면?\n';

    const after = engine.comment(pr.id, { author: 'r', path: 'a.txt', line: 2, body });

    expect(after.comments[0]!.body).toBe(body);
  });

  it('답글이 같은 스레드로 묶이고 스레드가 통째로 닫힌다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const withRoot = engine.comment(pr.id, { author: 'r', path: 'a.txt', body: '지적' });
    const rootId = withRoot.comments[0]!.id;

    const withReply = engine.comment(pr.id, {
      author: 'a',
      path: 'a.txt',
      body: '고쳤어요',
      replyTo: rootId,
    });
    expect(withReply.comments[1]!.threadId).toBe(rootId);

    // 뿌리만 닫고 답글이 열린 채 남으면 미해결 수가 어긋난다
    const resolved = engine.resolve(pr.id, rootId, 'r');
    expect(resolved.comments.every((c) => c.resolved)).toBe(true);
  });

  it('답글이 달려도 미해결 수가 늘지 않는다', () => {
    // 코멘트를 세면 주고받을수록 수가 늘어 대화가 나빠 보인다. 스레드를 센다
    const pr = engine.create({ title: 't', author: 'a' });
    const withRoot = engine.comment(pr.id, { author: 'r', path: 'a.txt', body: '지적' });
    const rootId = withRoot.comments[0]!.id;

    expect(unresolvedCount(withRoot)).toBe(1);

    const withReply = engine.comment(pr.id, {
      author: 'a',
      path: 'a.txt',
      body: '고쳤어요',
      replyTo: rootId,
    });
    expect(unresolvedCount(withReply)).toBe(1);

    expect(unresolvedCount(engine.resolve(pr.id, rootId, 'r'))).toBe(0);
  });

  it('없는 코멘트에 답글을 달면 못 찾았다고 한다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    expect(() =>
      engine.comment(pr.id, { author: 'a', path: 'a.txt', body: 'x', replyTo: 'nope' }),
    ).toThrow(PrError);
  });

  describe('라운드', () => {
    it('request_changes가 라운드를 닫고 새 라운드를 연다', () => {
      const pr = engine.create({ title: 't', author: 'a' });
      const after = engine.review(pr.id, {
        reviewer: 'r',
        verdict: 'request_changes',
        summary: '경계 조건',
      });

      expect(after.status).toBe('changes_requested');
      expect(after.rounds).toHaveLength(2);
      expect(after.rounds[0]!.verdict).toBe('request_changes');
    });

    it('comment 판정은 라운드를 닫지 않는다', () => {
      const pr = engine.create({ title: 't', author: 'a' });
      const after = engine.review(pr.id, { reviewer: 'r', verdict: 'comment', summary: '의견' });

      expect(after.status).toBe('open');
      expect(after.rounds).toHaveLength(1);
      expect(after.rounds[0]!.verdict).toBeNull();
    });

    it('고쳐서 update하면 다시 리뷰를 기다리는 자리로 돌아간다', () => {
      const pr = engine.create({ title: 't', author: 'a' });
      engine.review(pr.id, { reviewer: 'r', verdict: 'request_changes', summary: 'x' });

      writeFileSync(join(repo, 'a.txt'), 'line1\nline2\nline3\n');
      run(repo, ['commit', '-q', '-am', '고침']);

      const after = engine.update(pr.id);
      expect(after.status).toBe('open');
      expect(after.rounds).toHaveLength(2);
      // 같은 PR에서 라운드만 늘어난다. 새 PR을 만들지 않는다
      expect(after.id).toBe(pr.id);
    });

    it('head가 그대로면 update하지 않는다', () => {
      const pr = engine.create({ title: 't', author: 'a' });
      expect(() => engine.update(pr.id)).toThrow(PrError);
    });
  });

  describe('마무리', () => {
    it('승인 없이 머지하고 미해결 코멘트 수를 남긴다', () => {
      const pr = engine.create({ title: 't', author: 'a' });
      engine.comment(pr.id, { author: 'r', path: 'a.txt', body: '안 닫은 지적' });
      run(repo, ['checkout', '-q', 'main']);

      const merged = engine.merge(pr.id, 'a');
      expect(merged.status).toBe('merged');

      const events = new EventStore(git.reviewsDbPath(repo)).replay('local-pr', pr.id);
      const mergedEvent = events.find((e) => e.eventType === 'pr.merged');
      expect((mergedEvent!.payload as { unresolvedCount: number }).unresolvedCount).toBe(1);
    });

    it('base를 안 올라타고 있어도 임시 워크트리로 머지한다', () => {
      const pr = engine.create({ title: 't', author: 'a' });
      // feat/x에 그대로 선 채로 머지한다. 옮겨 타지 않는다
      expect(run(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/x');

      const merged = engine.merge(pr.id, 'a');

      expect(merged.status).toBe('merged');
      expect(run(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/x');
      // main이 머지 커밋으로 옮겨갔다
      expect(run(repo, ['log', '-1', '--format=%s', 'main'])).toContain(pr.id);
    });

    it('임시 워크트리를 남기지 않는다', () => {
      const pr = engine.create({ title: 't', author: 'a' });
      engine.merge(pr.id, 'a');

      const list = run(repo, ['worktree', 'list']);
      expect(list).not.toContain('gestalt-merge-');
      expect(list.trim().split('\n')).toHaveLength(1);
    });

    it('base를 올라타고 있으면 그 자리에서 머지한다', () => {
      const pr = engine.create({ title: 't', author: 'a' });
      run(repo, ['checkout', '-q', 'main']);

      engine.merge(pr.id, 'a');

      expect(run(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
      expect(run(repo, ['log', '-1', '--format=%s'])).toContain(pr.id);
    });

    it('다른 워크트리가 base를 잡고 있으면 밀지 않고 돌려보낸다', () => {
      const pr = engine.create({ title: 't', author: 'a' });
      const wt = mkdtempSync(join(tmpdir(), 'gestalt-holder-'));
      rmSync(wt, { recursive: true, force: true });
      // main을 다른 워크트리가 올라탄다. 여기서 ref를 밀면 그쪽이 깨진다
      run(repo, ['worktree', 'add', '-q', wt, 'main']);

      try {
        expect(() => engine.merge(pr.id, 'a')).toThrow(/다른 워크트리/);
        // 거부했으니 main은 그대로다
        expect(run(repo, ['log', '-1', '--format=%s', 'main'])).toBe('init');
      } finally {
        run(repo, ['worktree', 'remove', '--force', wt]);
      }
    });

    it('머지된 PR은 더 못 건드린다', () => {
      const pr = engine.create({ title: 't', author: 'a' });
      run(repo, ['checkout', '-q', 'main']);
      engine.merge(pr.id, 'a');

      expect(() => engine.comment(pr.id, { author: 'r', path: 'a.txt', body: 'x' })).toThrow(
        PrError,
      );
    });

    it('닫아도 head는 붙잡아 두고 base만 놓는다', () => {
      const pr = engine.create({ title: 't', author: 'a' });

      engine.closePr(pr.id, 'a', '다른 방식으로 간다');

      const refs = run(repo, ['for-each-ref', '--format=%(refname)', 'refs/gestalt/']);
      // head까지 놓으면 브랜치도 지운 PR은 gc가 한 번 돌고 나서 빈 껍데기가 된다.
      // checkout이 닫힌 PR도 떼어낸다고 약속한 자리라 그 약속이 먼저 깨진다
      expect(refs).toContain(`refs/gestalt/pr/${pr.id}/head`);
      expect(refs).not.toContain(`refs/gestalt/pr/${pr.id}/base`);
    });

    it('닫고 브랜치를 지운 뒤 gc가 돌아도 diff가 산다', () => {
      const pr = engine.create({ title: 't', author: 'a' });
      engine.closePr(pr.id, 'a', '');

      run(repo, ['checkout', '-q', 'main']);
      run(repo, ['branch', '-D', 'feat/x']);
      run(repo, ['reflog', 'expire', '--expire=now', '--all']);
      run(repo, ['gc', '--prune=now', '--quiet']);

      expect(engine.diff(pr.id)).toContain('line2');
    });
  });

  it('DB를 지우고 이벤트만 있어도 같은 상태가 나온다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    engine.comment(pr.id, { author: 'r', path: 'a.txt', body: '지적' });
    engine.review(pr.id, { reviewer: 'r', verdict: 'request_changes', summary: 'x' });
    const before = engine.get(pr.id)!;

    // 같은 이벤트를 새 저장소에 그대로 넣고 다시 접는다
    const events = new EventStore(git.reviewsDbPath(repo)).replay('local-pr', pr.id);
    const fresh = new EventStore(join(repo, 'replay.db'));
    for (const e of events) fresh.append('local-pr', pr.id, e.eventType, e.payload);

    const after = new PullRequestRepository(fresh).reconstruct(pr.id)!;
    expect(after.status).toBe(before.status);
    expect(after.rounds).toHaveLength(before.rounds.length);
    expect(after.comments.map((c) => c.body)).toEqual(before.comments.map((c) => c.body));
    fresh.close();
  });

  it('워크트리에서 만든 PR이 본체 목록에 보인다', () => {
    const wt = mkdtempSync(join(tmpdir(), 'gestalt-wt-'));
    rmSync(wt, { recursive: true, force: true });
    run(repo, ['worktree', 'add', '-q', wt, '-b', 'feat/y']);

    writeFileSync(join(wt, 'a.txt'), 'line1\nline2\nfrom worktree\n');
    run(wt, ['commit', '-q', '-am', '워크트리 변경']);

    const wtEngine = new LocalPrEngine(wt);
    const created = wtEngine.create({ title: '워크트리', author: 'codex:worker-2' });
    wtEngine.dispose();

    expect(engine.list().map((p) => p.id)).toContain(created.id);
    rmSync(wt, { recursive: true, force: true });
  });

  it('본문 파일을 읽어 넣어도 바이트가 유지된다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const path = join(repo, 'body.md');
    const body = '## 제목\n\n- `코드` 인용\n- 줄바꿈\n\n끝\n';
    writeFileSync(path, body, 'utf-8');

    const after = engine.comment(pr.id, {
      author: 'r',
      path: 'a.txt',
      body: readFileSync(path, 'utf-8'),
    });

    expect(after.comments[0]!.body).toBe(body);
  });
  // ─── 주석이 단언한 보장을 밟는 자리 (CM-8) ──────────────────

  it('제목에 따옴표와 공백이 섞여도 머지 메시지에 그대로 간다', () => {
    const title = `it's "quoted" $(id) \`tick\` 두 칸`;
    run(repo, ['checkout', '-q', 'main']);
    const pr = engine.create({ title, author: 'a', base: 'main', head: 'feat/x' });

    // title은 mergeIntoBase에서 실제 git 인자(-m)가 된다. 셸을 타면 여기서 깨진다
    engine.merge(pr.id, 'a');

    expect(run(repo, ['log', '-1', '--format=%s', 'main'])).toContain(title);
  });
});
