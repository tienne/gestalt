import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../../../src/events/store.js';
import { LocalPrEngine, PrError } from '../../../src/local-pr/engine.js';
import { PullRequestRepository } from '../../../src/local-pr/repository.js';
import { unresolvedCount } from '../../../src/local-pr/policy.js';
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

  it('commentMany는 몇 번째 입력까지 썼는지를 인덱스로 알린다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const seen: number[] = [];

    engine.commentMany(
      pr.id,
      ['하나', '둘', '셋'].map((body) => ({ author: 'r', path: 'a.txt', body })),
      (i) => seen.push(i),
    );

    // 부르는 쪽은 이 값으로 재개 지점을 잡는다. 인덱스를 버리고 자기 카운터를 올리면
    // 두 계산이 갈릴 때 재개 지점이 밀려 코멘트가 겹치거나 빠진다
    expect(seen).toEqual([0, 1, 2]);
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
    it('승인 없이 머지하고 미해결 스레드 수를 남긴다', () => {
      const pr = engine.create({ title: 't', author: 'a' });
      const withComment = engine.comment(pr.id, {
        author: 'r',
        path: 'a.txt',
        body: '안 닫은 코멘트',
      });
      // 답글을 달아 두 계산을 갈라 놓는다. 코멘트로 세면 2, 스레드로 세면 1이다.
      // 답글이 없으면 두 값이 같아서 어느 쪽을 쓰는지 이 단언이 못 가른다
      engine.comment(pr.id, {
        author: 'a',
        path: 'a.txt',
        body: '고쳤다',
        replyTo: withComment.comments[0]!.id,
      });
      run(repo, ['checkout', '-q', 'main']);

      const merged = engine.merge(pr.id, 'a');
      expect(merged.status).toBe('merged');
      expect(merged.comments.filter((c) => !c.resolved)).toHaveLength(2);

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

    it('충돌하는 머지는 워킹 트리를 되돌려 놓고 던진다', () => {
      // main과 feat/x가 같은 줄을 다르게 고친다. 이 자리에서 곧장 머지하는 갈래라
      // 충돌이 부르는 사람의 워킹 트리에 MERGE_HEAD를 세운 채 남는다
      const pr = engine.create({ title: 't', author: 'a' });
      run(repo, ['checkout', '-q', 'main']);
      writeFileSync(join(repo, 'a.txt'), 'line1\nmain이 고친 줄\n');
      run(repo, ['commit', '-q', '-am', 'main도 두 번째 줄']);

      expect(() => engine.merge(pr.id, 'a')).toThrow(/머지하다 실패했다/);

      // 오류 문장이 "워킹 트리는 되돌렸다"고 단언한다. 그 단언을 여기서 확인한다 —
      // merge --abort가 빠지면 아래 셋이 전부 어긋난다
      expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
      // 추적 안 하는 파일은 뺀다. 저장소(.gestalt/)가 레포 안에 생겨 늘 걸린다
      expect(run(repo, ['status', '--porcelain', '-uno'])).toBe('');
      expect(readFileSync(join(repo, 'a.txt'), 'utf-8')).toBe('line1\nmain이 고친 줄\n');
      // 실패했으니 PR도 그대로 열려 있다
      expect(engine.get(pr.id)!.status).toBe('open');
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

  describe('상태 필터', () => {
    /** 이름 붙인 브랜치에 커밋 하나를 얹고 PR을 만든다 */
    function prOn(branch: string): string {
      run(repo, ['checkout', '-q', '-b', branch, 'main']);
      writeFileSync(join(repo, `${branch}.txt`), `${branch}\n`);
      run(repo, ['add', '--', `${branch}.txt`]);
      run(repo, ['commit', '-q', '-m', branch]);
      return engine.create({ title: branch, author: 'a' }).id;
    }

    it('네 상태를 모두 만들고 필터가 전체 목록을 거른 것과 같다', () => {
      // `list(status)`는 상태만 접는 가벼운 갈래로 후보를 좁힌다. 그 갈래가 통째로
      // 접는 `fold`와 갈리면 목록과 필터가 어긋난다. 두 계산을 맞대는 자리다
      const open = prOn('s-open');
      const requested = prOn('s-requested');
      engine.review(requested, { reviewer: 'r', verdict: 'request_changes', summary: 'x' });
      const closed = prOn('s-closed');
      engine.closePr(closed, 'a', '');
      const merged = prOn('s-merged');
      run(repo, ['checkout', '-q', 'main']);
      engine.merge(merged, 'a');

      // 코멘트와 approve 판정은 상태를 안 옮긴다. 가벼운 갈래가 그렇게 적어 뒀다
      engine.comment(open, { author: 'r', path: 'a.txt', body: '의견' });
      engine.review(open, { reviewer: 'r', verdict: 'approve', summary: 'ok' });

      const all = engine.list();
      expect(all).toHaveLength(4);

      for (const status of ['open', 'changes_requested', 'merged', 'closed'] as const) {
        expect(
          engine
            .list(status)
            .map((pr) => pr.id)
            .sort(),
        ).toEqual(
          all
            .filter((pr) => pr.status === status)
            .map((pr) => pr.id)
            .sort(),
        );
      }

      expect(engine.list('open').map((pr) => pr.id)).toEqual([open]);
      expect(engine.list('changes_requested').map((pr) => pr.id)).toEqual([requested]);
      expect(engine.countByStatus()).toEqual({
        open: 1,
        changes_requested: 1,
        merged: 1,
        closed: 1,
      });
    });

    it('고쳐서 update하면 다시 open으로 세어진다', () => {
      // changes_requested를 되돌리는 갈래는 상태를 정하는 이벤트 중 유일하게
      // 이전 상태를 보고 갈린다. 가벼운 갈래에서 빠뜨리기 쉬운 자리다
      const id = prOn('s-again');
      engine.review(id, { reviewer: 'r', verdict: 'request_changes', summary: 'x' });
      expect(engine.countByStatus().changes_requested).toBe(1);

      writeFileSync(join(repo, 's-again.txt'), '고침\n');
      run(repo, ['commit', '-q', '-am', '고침']);
      engine.update(id);

      expect(engine.list('open').map((pr) => pr.id)).toEqual([id]);
      expect(engine.countByStatus()).toEqual({
        open: 1,
        changes_requested: 0,
        merged: 0,
        closed: 0,
      });
    });
  });

  describe('ref 반납', () => {
    function gestaltRefs(): string[] {
      const out = run(repo, ['for-each-ref', '--format=%(refname)', 'refs/gestalt/']);
      return out ? out.split('\n') : [];
    }

    it('머지된 PR의 base와 head를 놓는다', () => {
      const pr = engine.create({ title: 't', author: 'a' });
      run(repo, ['checkout', '-q', 'main']);
      engine.merge(pr.id, 'a');

      const result = engine.prune();

      expect(result.released.sort()).toEqual([
        `refs/gestalt/pr/${pr.id}/base`,
        `refs/gestalt/pr/${pr.id}/head`,
      ]);
      expect(gestaltRefs()).toHaveLength(0);
      // 놓아도 커밋은 산다. 머지 커밋이 base 이력에 넣어놨다
      expect(engine.diff(pr.id)).toContain('line2');
    });

    it('열린 PR과 닫힌 PR의 head는 안 놓는다', () => {
      const open = engine.create({ title: 'open', author: 'a' });
      run(repo, ['checkout', '-q', '-b', 'feat/y', 'main']);
      writeFileSync(join(repo, 'b.txt'), 'b\n');
      run(repo, ['add', '-A']);
      run(repo, ['commit', '-q', '-m', 'b']);
      const closed = engine.create({ title: 'closed', author: 'a' });
      engine.closePr(closed.id, 'a', '');

      engine.prune();

      const refs = gestaltRefs();
      expect(refs).toContain(`refs/gestalt/pr/${open.id}/head`);
      expect(refs).toContain(`refs/gestalt/pr/${open.id}/base`);
      // 닫힌 PR도 checkout으로 떼어낸다고 약속한 자리라 head를 남긴다
      expect(refs).toContain(`refs/gestalt/pr/${closed.id}/head`);
    });

    it('머지 뒤 base가 되돌아갔으면 안 놓고 이유를 준다', () => {
      const pr = engine.create({ title: 't', author: 'a' });
      const beforeMerge = run(repo, ['rev-parse', 'main']);
      run(repo, ['checkout', '-q', 'main']);
      engine.merge(pr.id, 'a');
      // 머지를 되돌린다. head가 더는 base 이력에 없어서 ref를 놓으면 커밋이 사라진다
      run(repo, ['reset', '-q', '--hard', beforeMerge]);

      const result = engine.prune();

      expect(result.released).toHaveLength(0);
      expect(result.kept).toEqual([{ prId: pr.id, reason: expect.stringContaining('base main') }]);
      expect(gestaltRefs()).toContain(`refs/gestalt/pr/${pr.id}/head`);
    });

    it('dry-run은 목록만 주고 손대지 않는다', () => {
      const pr = engine.create({ title: 't', author: 'a' });
      run(repo, ['checkout', '-q', 'main']);
      engine.merge(pr.id, 'a');

      const result = engine.prune({ dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.released).toHaveLength(2);
      expect(gestaltRefs()).toHaveLength(2);
    });

    it('체크아웃 자국은 --checkouts로 뜻을 밝혀야 놓는다', () => {
      const pr = engine.create({ title: 't', author: 'a' });
      const checkout = engine.checkout(pr.id);
      writeFileSync(join(checkout.path, 'a.txt'), '일부러 깬 코드\n');
      run(checkout.path, ['commit', '-q', '-am', '뮤테이션']);
      const saved = engine.removeCheckout(pr.id, { force: true }).savedRef!;
      run(repo, ['checkout', '-q', 'main']);
      engine.merge(pr.id, 'a');

      // 기본은 안 놓는다. 워크트리 전용 커밋이라 놓으면 영영 사라진다
      engine.prune();
      expect(gestaltRefs()).toContain(saved);

      const result = engine.prune({ checkouts: true });
      expect(result.released).toContain(saved);
      expect(gestaltRefs()).not.toContain(saved);
    });

    it('열린 PR의 체크아웃 자국은 --checkouts를 줘도 안 놓는다', () => {
      // 자국은 어느 이력에도 안 들어간 워크트리 전용 커밋이라 놓으면 영영 사라진다.
      // 리뷰가 안 끝난 PR에서는 리뷰어가 force로 구조해 둔 그 커밋을 아직 볼 일이 있다.
      // 플래그만 보고 놓으면 되돌릴 방법이 없다
      const pr = engine.create({ title: 't', author: 'a' });
      const checkout = engine.checkout(pr.id);
      writeFileSync(join(checkout.path, 'a.txt'), '일부러 깬 코드\n');
      run(checkout.path, ['commit', '-q', '-am', '뮤테이션']);
      const saved = engine.removeCheckout(pr.id, { force: true }).savedRef!;

      const result = engine.prune({ checkouts: true });

      expect(pr.status).toBe('open');
      expect(result.released).not.toContain(saved);
      expect(gestaltRefs()).toContain(saved);
    });

    it('닫힌 PR의 체크아웃 자국은 --checkouts로 놓는다', () => {
      // 상태 조건의 다른 쪽 항이다. 머지된 PR만으로는 'merged || closed'에서
      // closed 갈래가 안 밟힌다
      const pr = engine.create({ title: 't', author: 'a' });
      const checkout = engine.checkout(pr.id);
      writeFileSync(join(checkout.path, 'a.txt'), '일부러 깬 코드\n');
      run(checkout.path, ['commit', '-q', '-am', '뮤테이션']);
      const saved = engine.removeCheckout(pr.id, { force: true }).savedRef!;
      engine.closePr(pr.id, 'a', '');

      const result = engine.prune({ checkouts: true });

      expect(result.released).toContain(saved);
      expect(gestaltRefs()).not.toContain(saved);
      // 닫힌 PR의 head는 그대로 붙잡아 둔다. 자국만 놓는다
      expect(gestaltRefs()).toContain(`refs/gestalt/pr/${pr.id}/head`);
    });

    it('두 번 불러도 이미 놓은 ref를 다시 놓았다고 세지 않는다', () => {
      const pr = engine.create({ title: 't', author: 'a' });
      run(repo, ['checkout', '-q', 'main']);
      engine.merge(pr.id, 'a');

      expect(engine.prune().released).toHaveLength(2);
      expect(engine.prune().released).toHaveLength(0);
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
