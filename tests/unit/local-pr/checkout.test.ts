import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventStore } from '../../../src/events/store.js';
import { LocalPrEngine, PrError } from '../../../src/local-pr/engine.js';
import * as git from '../../../src/local-pr/git.js';

/**
 * `pr checkout`은 진짜 워크트리를 붙였다 뗀다. 흉내로는 안 잡히는 자리라 실제 git
 * 레포를 만들어 돌린다.
 *
 * 주석이 단언한 보장마다 케이스가 하나씩 있다 (CM-8) — detach로 뗀다는 것,
 * 두 번 불러도 하나라는 것, 경로가 id로 정해진다는 것, 미커밋 변경을 안 날린다는 것.
 */

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('PR head 체크아웃', () => {
  let repo: string;
  let engine: LocalPrEngine;
  let store: EventStore;
  let dbPath: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gestalt-checkout-'));
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

    dbPath = join('.gestalt-test', `pr-checkout-${randomUUID()}.db`);
    store = new EventStore(dbPath);
    engine = new LocalPrEngine(repo, store);
  });

  afterEach(() => {
    engine.dispose();
    rmSync(repo, { recursive: true, force: true });
    for (const suffix of ['', '-wal', '-shm', '.jsonl']) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it('head를 떼어낸 워크트리에 PR의 파일이 실물로 있다', () => {
    const pr = engine.create({ title: 't', author: 'codex:worker-1' });
    const checkout = engine.checkout(pr.id);

    try {
      expect(checkout.created).toBe(true);
      expect(checkout.headSha).toBe(pr.headSha);
      expect(readFileSync(join(checkout.path, 'a.txt'), 'utf-8')).toBe('line1\nline2\n');
    } finally {
      engine.removeCheckout(pr.id, { force: true });
    }
  });

  it('브랜치를 체크아웃하지 않고 detach로 뗀다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const checkout = engine.checkout(pr.id);

    try {
      // 브랜치를 잡았으면 리뷰어 워크트리와 부딪힌다. HEAD가 브랜치를 안 가리켜야 한다
      expect(run(checkout.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
      // 그래서 head 브랜치를 올라탄 워크트리는 원래 자리 하나뿐이다
      const holder = git.worktreeOn(repo, 'feat/x');
      // macOS의 /tmp는 심볼릭 링크라 실경로로 맞춰 본다
      expect(realpathSync(holder!.path)).toBe(realpathSync(repo));
    } finally {
      engine.removeCheckout(pr.id, { force: true });
    }
  });

  it('같은 PR을 두 번 떼면 있던 자리를 그대로 준다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const first = engine.checkout(pr.id);

    try {
      // 리뷰어가 뮤테이션으로 깨놓은 상태
      writeFileSync(join(first.path, 'a.txt'), 'mutated\n');

      const second = engine.checkout(pr.id);

      expect(second.path).toBe(first.path);
      expect(second.created).toBe(false);
      // 다시 뗐다면 파일이 원래대로 돌아왔을 것이다
      expect(readFileSync(join(second.path, 'a.txt'), 'utf-8')).toBe('mutated\n');
      expect(git.worktrees(repo)).toHaveLength(2);
    } finally {
      engine.removeCheckout(pr.id, { force: true });
    }
  });

  it('경로는 레포와 PR id만으로 정해진다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const checkout = engine.checkout(pr.id);

    try {
      // 리뷰어가 경로를 안 적어놨어도 같은 값이 다시 나온다
      expect(git.prCheckoutPath(repo, pr.id)).toBe(checkout.path);
      expect(checkout.path).toContain(pr.id);
    } finally {
      engine.removeCheckout(pr.id, { force: true });
    }
  });

  it('레포가 다르면 같은 id라도 자리가 갈린다', () => {
    const other = mkdtempSync(join(tmpdir(), 'gestalt-other-'));
    run(other, ['init', '-q']);

    try {
      expect(git.prCheckoutPath(other, 'abcd1234')).not.toBe(git.prCheckoutPath(repo, 'abcd1234'));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('커밋 안 된 변경이 있으면 지우지 않고 이유를 준다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const checkout = engine.checkout(pr.id);

    try {
      writeFileSync(join(checkout.path, 'a.txt'), 'line1\n깨뜨린 줄\n');

      const result = engine.removeCheckout(pr.id);

      expect(result.removed).toBe(false);
      expect(result.reason).toContain('커밋 안 된 변경');
      expect(existsSync(join(checkout.path, 'a.txt'))).toBe(true);
      expect(readFileSync(join(checkout.path, 'a.txt'), 'utf-8')).toContain('깨뜨린 줄');
    } finally {
      engine.removeCheckout(pr.id, { force: true });
    }
  });

  it('force면 미커밋 변경이 있어도 지운다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const checkout = engine.checkout(pr.id);
    writeFileSync(join(checkout.path, 'a.txt'), 'line1\n깨뜨린 줄\n');

    const result = engine.removeCheckout(pr.id, { force: true });

    expect(result.removed).toBe(true);
    expect(existsSync(checkout.path)).toBe(false);
    expect(git.worktrees(repo)).toHaveLength(1);
  });

  it('무시 대상 파일만 생겼으면 변경으로 안 센다', () => {
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    run(repo, ['add', '-A']);
    run(repo, ['commit', '-q', '-m', 'ignore']);

    const pr = engine.create({ title: 't', author: 'a' });
    const checkout = engine.checkout(pr.id);
    // 리뷰어가 pnpm install을 돌린 자리
    execFileSync('mkdir', ['-p', join(checkout.path, 'node_modules')]);
    writeFileSync(join(checkout.path, 'node_modules', 'x'), 'dep\n');

    const result = engine.removeCheckout(pr.id);

    expect(result.removed).toBe(true);
  });

  it('깨끗하면 그냥 지운다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const checkout = engine.checkout(pr.id);

    const result = engine.removeCheckout(pr.id);

    expect(result.removed).toBe(true);
    expect(result.path).toBe(checkout.path);
    expect(existsSync(checkout.path)).toBe(false);
  });

  it('뗀 적 없는 PR을 지우라면 없다고 알린다', () => {
    const pr = engine.create({ title: 't', author: 'a' });

    const result = engine.removeCheckout(pr.id);

    expect(result.removed).toBe(false);
    expect(result.reason).toContain('없다');
  });

  it('없는 PR은 떼지도 지우지도 않는다', () => {
    expect(() => engine.checkout('deadbeef')).toThrow(PrError);
    expect(() => engine.removeCheckout('deadbeef')).toThrow(PrError);
  });

  it('디렉토리만 남고 등록이 끊긴 자리도 다시 뗀다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const first = engine.checkout(pr.id);

    // 워크트리 등록만 날리고 디렉토리는 남긴 상태. 정리가 중간에 끊긴 모양이다
    rmSync(join(first.path, '.git'), { force: true });

    try {
      const second = engine.checkout(pr.id);

      expect(second.created).toBe(true);
      expect(readFileSync(join(second.path, 'a.txt'), 'utf-8')).toBe('line1\nline2\n');
    } finally {
      engine.removeCheckout(pr.id, { force: true });
    }
  });

  it('머지된 PR도 떼어낼 수 있다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    run(repo, ['checkout', '-q', 'main']);
    engine.merge(pr.id, 'a');

    const checkout = engine.checkout(pr.id);

    try {
      expect(checkout.headSha).toBe(pr.headSha);
    } finally {
      engine.removeCheckout(pr.id, { force: true });
    }
  });
  // ─── 2라운드 리뷰가 잡은 자리들 ────────────────────────────

  it('떼어낸 자리 안에서 지워도 실패로 보고하지 않는다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const checkout = engine.checkout(pr.id);

    // checkout이 알려준 경로로 cd 한 채 --remove를 부르는 게 이 명령의 정상 흐름이다.
    // 그때 repoRoot는 지워질 그 자리를 가리킨다. 지운 뒤 거기서 git을 부르면 죽는다
    const inside = new LocalPrEngine(checkout.path, store);
    try {
      const result = inside.removeCheckout(pr.id, { force: true });

      expect(result.removed).toBe(true);
      expect(existsSync(checkout.path)).toBe(false);
    } finally {
      inside.dispose();
    }
  });

  it('지울 자리가 없는 것과 지키느라 안 지운 것을 status로 가른다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const checkout = engine.checkout(pr.id);

    writeFileSync(join(checkout.path, 'a.txt'), '뮤테이션\n');
    const kept = engine.removeCheckout(pr.id);

    const gone = engine.removeCheckout(pr.id, { force: true });
    const again = engine.removeCheckout(pr.id);

    expect(kept.status).toBe('dirty');
    expect(gone.status).toBe('removed');
    // 두 번째 정리는 실패가 아니다. 목표가 이미 이뤄진 상태다
    expect(again.status).toBe('absent');
    expect(again.removed).toBe(false);
  });

  it('떼어낸 자리에서 커밋한 변경은 force 없이 안 지운다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const checkout = engine.checkout(pr.id);

    run(checkout.path, ['config', 'user.email', 't@e.st']);
    run(checkout.path, ['config', 'user.name', 'test']);
    writeFileSync(join(checkout.path, 'a.txt'), '깨놓은 코드\n');
    run(checkout.path, ['commit', '-q', '-am', '뮤테이션 확인 중']);

    // detached HEAD라 git status는 깨끗하다고 답한다. 미커밋 검사만으로는 안 걸린다
    const result = engine.removeCheckout(pr.id);

    expect(result.status).toBe('diverged');
    expect(result.removed).toBe(false);
    expect(existsSync(checkout.path)).toBe(true);

    engine.removeCheckout(pr.id, { force: true });
  });

  it('force로 지울 때 그 커밋을 ref로 붙잡아 둔다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const checkout = engine.checkout(pr.id);

    run(checkout.path, ['config', 'user.email', 't@e.st']);
    run(checkout.path, ['config', 'user.name', 'test']);
    writeFileSync(join(checkout.path, 'a.txt'), '깨놓은 코드\n');
    run(checkout.path, ['commit', '-q', '-am', '뮤테이션 확인 중']);
    const stranded = run(checkout.path, ['rev-parse', 'HEAD']);

    const result = engine.removeCheckout(pr.id, { force: true });

    expect(result.removed).toBe(true);
    expect(result.savedRef).toBe(`refs/gestalt/pr-checkout/${pr.id}/${stranded.slice(0, 8)}`);
    // 붙잡아 둔 ref가 실제로 그 커밋을 가리킨다. 되짚을 실마리가 남는다
    expect(run(repo, ['rev-parse', result.savedRef!])).toBe(stranded);
  });

  it('마지막 PR을 지우면 레포 칸도 함께 치운다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const checkout = engine.checkout(pr.id);
    const repoSlot = dirname(checkout.path);

    engine.removeCheckout(pr.id, { force: true });

    // 안 치우면 tmp에 빈 디렉토리가 레포마다 쌓인다
    expect(existsSync(repoSlot)).toBe(false);
  });

  it('다른 PR이 남아 있으면 레포 칸을 안 치운다', () => {
    const first = engine.create({ title: 'first', author: 'a' });
    const second = engine.create({ title: 'second', author: 'a' });
    const a = engine.checkout(first.id);
    const b = engine.checkout(second.id);

    engine.removeCheckout(first.id, { force: true });

    try {
      expect(existsSync(dirname(a.path))).toBe(true);
      expect(existsSync(b.path)).toBe(true);
    } finally {
      engine.removeCheckout(second.id, { force: true });
    }
  });
  it('두 번째 force가 첫 번째로 구한 커밋을 덮지 않는다', () => {
    const pr = engine.create({ title: 't', author: 'a' });

    // 뮤테이션 검증은 깨고 커밋하고 치우기를 여러 바퀴 돈다. 바퀴마다 구한 커밋이
    // 남아야 한다 — PR당 ref가 하나면 두 번째가 첫 번째를 조용히 가져간다
    const saved: string[] = [];
    for (const mark of ['첫 바퀴', '둘째 바퀴']) {
      const checkout = engine.checkout(pr.id);
      run(checkout.path, ['config', 'user.email', 't@e.st']);
      run(checkout.path, ['config', 'user.name', 'test']);
      writeFileSync(join(checkout.path, 'a.txt'), `${mark}\n`);
      run(checkout.path, ['commit', '-q', '-am', mark]);
      saved.push(run(checkout.path, ['rev-parse', 'HEAD']));

      engine.removeCheckout(pr.id, { force: true });
    }

    expect(saved[0]).not.toBe(saved[1]);
    for (const sha of saved) {
      expect(run(repo, ['for-each-ref', '--contains', sha, '--count=1'])).not.toBe('');
    }
  });
  it('워크트리를 공용 git 디렉토리 아래에 둔다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const checkout = engine.checkout(pr.id);

    try {
      // 공유 /tmp에 예측 가능한 이름으로 열면 남이 먼저 그 자리를 만들어 둘 수 있다.
      // .git 아래는 워킹 트리가 아니라서 추적 안 되는 디렉토리가 diff에 안 섞인다
      expect(realpathSync(checkout.path).startsWith(realpathSync(join(repo, '.git')))).toBe(true);
      expect(run(repo, ['status', '--porcelain'])).toBe('');
    } finally {
      engine.removeCheckout(pr.id, { force: true });
    }
  });

  it('등록이 끊기고 디렉토리만 남았으면 force 없이 안 지운다', () => {
    const pr = engine.create({ title: 't', author: 'a' });
    const checkout = engine.checkout(pr.id);
    writeFileSync(join(checkout.path, 'a.txt'), '일부러 깬 코드\n');

    // 지난 정리가 중간에 끊긴 흔적이다. 안에 뭐가 있는지 여기서는 못 읽는다
    rmSync(join(checkout.path, '.git'), { force: true });
    run(repo, ['worktree', 'prune']);

    const kept = engine.removeCheckout(pr.id);

    expect(kept.status).toBe('dirty');
    expect(existsSync(join(checkout.path, 'a.txt'))).toBe(true);

    expect(engine.removeCheckout(pr.id, { force: true }).status).toBe('removed');
  });

  it('PR id 형식이 아니면 경로를 만들지 않는다', () => {
    // 이 값이 재귀 삭제 경로와 ref 이름으로 그대로 이어 붙는다
    expect(() => git.prCheckoutPath(repo, '../../etc')).toThrow();
    expect(() => git.prCheckoutPath(repo, 'abcd1234')).not.toThrow();
  });
});
