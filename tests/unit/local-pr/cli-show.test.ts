import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPrEngine } from '../../../src/local-pr/engine.js';
import {
  assertServeRoot,
  prCommentsCommand,
  prPruneCommand,
  prServeCommand,
  prShowCommand,
} from '../../../src/cli/commands/pr.js';

/**
 * CLI가 정책 층에서 값을 가져다 쓰는지 본다.
 *
 * 한 화면 안에서 머리글은 스레드를, 목록은 코멘트를 세던 자리다. 같은 단어로 다른
 * 수를 보여줬다. 정책 함수만 테스트하면 표면이 그 함수를 안 부르는 갈래가 안 걸린다.
 */

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('gestalt pr 출력', () => {
  let repo: string;
  let engine: LocalPrEngine;
  let lines: string[];

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gestalt-pr-cli-'));
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
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    engine.dispose();
    rmSync(repo, { recursive: true, force: true });
  });

  /** 뿌리 하나에 답글 둘이 달린 스레드와, 닫힌 스레드 하나 */
  function prWithThread(): string {
    const pr = engine.create({ title: 't', author: 'a' });
    const rooted = engine.comment(pr.id, { author: 'r', path: 'a.txt', line: 2, body: '여기요' });
    const rootId = rooted.comments[0]!.id;
    engine.comment(pr.id, { author: 'w', path: 'a.txt', body: '고쳤어요', replyTo: rootId });
    engine.comment(pr.id, { author: 'r', path: 'a.txt', body: '확인했어요', replyTo: rootId });

    const closed = engine.comment(pr.id, { author: 'r', path: 'a.txt', body: '이건 닫아요' });
    engine.resolve(pr.id, closed.comments[closed.comments.length - 1]!.id, 'r');
    return pr.id;
  }

  it('show의 머리글 수와 그 아래 목록의 줄 수가 맞는다', () => {
    const id = prWithThread();

    prShowCommand({ id, repoRoot: repo });

    expect(lines.some((l) => l.includes('미해결 1'))).toBe(true);
    // 머리글이 1이라 했으면 목록도 한 줄이다. 코멘트를 세면 여기가 3이 된다
    const listed = lines.filter((l) => /^ {2}\[[0-9a-f]{8}\]/.test(l));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain('답글 2개');
  });

  it('comments --unresolved는 닫힌 스레드를 뺀 코멘트를 준다', () => {
    const id = prWithThread();

    prCommentsCommand({ id, repoRoot: repo, unresolved: true });

    const heads = lines.filter((l) => /^\[[0-9a-f]{8}\]/.test(l));
    expect(heads).toHaveLength(3);
    expect(lines.join('\n')).not.toContain('이건 닫아요');
  });
});

/**
 * `gestalt pr prune`이 옵션을 엔진에 넘기는 자리.
 *
 * 엔진의 prune은 갈래마다 테스트가 있지만 CLI가 두 옵션을 **어느 자리로**
 * 넘기는지는 안 걸렸다. `checkouts`와 `dryRun`을 뒤바꿔도 게이트가 전부 통과했다.
 * 뒤바뀌면 `--dry-run`이 되돌릴 수 없는 체크아웃 자국을 실제로 지운다.
 *
 * 두 옵션을 따로 준다. 한쪽만 줬을 때 다른 쪽 자리가 비어야 뒤바뀜이 드러난다.
 */
describe('gestalt pr prune 옵션 전달', () => {
  let repo: string;
  let engine: LocalPrEngine;

  /** 머지된 PR 하나와 그 PR의 체크아웃 자국 ref 하나 */
  function mergedPrWithCheckoutMark(): { prId: string; mark: string } {
    const pr = engine.create({ title: 't', author: 'a' });
    engine.merge(pr.id, 'a');
    const sha = run(repo, ['rev-parse', 'HEAD']).slice(0, 8);
    const mark = `refs/gestalt/pr-checkout/${pr.id}/${sha}`;
    run(repo, ['update-ref', mark, 'HEAD']);
    return { prId: pr.id, mark };
  }

  function refExists(ref: string): boolean {
    try {
      run(repo, ['rev-parse', '--verify', '-q', ref]);
      return true;
    } catch {
      return false;
    }
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gestalt-pr-prune-'));
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
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    engine.dispose();
    rmSync(repo, { recursive: true, force: true });
  });

  it('--dry-run만 주면 아무것도 안 지운다', () => {
    const { prId, mark } = mergedPrWithCheckoutMark();

    prPruneCommand({ repoRoot: repo, dryRun: true });

    expect(refExists(mark)).toBe(true);
    expect(refExists(`refs/gestalt/pr/${prId}/head`)).toBe(true);
  });

  it('--checkouts만 주면 자국을 실제로 지운다', () => {
    const { mark } = mergedPrWithCheckoutMark();

    prPruneCommand({ repoRoot: repo, checkouts: true });

    expect(refExists(mark)).toBe(false);
  });
});

/**
 * `pr serve --repo-root`가 등록 경계를 못 넘는다.
 *
 * `pr serve`는 뜨면서 그 경로를 인증 없는 뷰어 목록에 영구히 넣는다. 목록에 넣는 문을
 * 좁게 둔 근거가 "사람이 그 레포에서 웹 UI를 직접 띄운 순간"인데, `--repo-root`를
 * 그대로 받으면 에이전트가 셸로 `pr serve --repo-root /남의/레포 --no-browser`를 한
 * 번 돌려 그 레포를 넣을 수 있다. 이후 전혀 다른 레포에서 serve를 띄워도 계속 보인다.
 */
describe('gestalt pr serve --repo-root 경계', () => {
  let here: string;
  let elsewhere: string;
  let cwdBefore: string;

  function makeRepo(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    run(dir, ['init', '-q']);
    run(dir, ['config', 'user.email', 't@e.st']);
    run(dir, ['config', 'user.name', 'test']);
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    run(dir, ['add', '-A']);
    run(dir, ['commit', '-q', '-m', 'init']);
    return dir;
  }

  beforeEach(() => {
    here = makeRepo('gestalt-serve-here-');
    elsewhere = makeRepo('gestalt-serve-else-');
    cwdBefore = process.cwd();
    process.chdir(here);
  });

  afterEach(() => {
    process.chdir(cwdBefore);
    vi.restoreAllMocks();
    rmSync(here, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('남의 레포를 가리키면 막는다', () => {
    expect(() => assertServeRoot(elsewhere)).toThrow(/다른 레포/);
  });

  it('같은 레포의 워크트리나 하위 디렉토리는 통과한다', () => {
    // 저장소를 공유하므로 키가 같다. 이 쓰임까지 막을 이유가 없다
    const wt = join(tmpdir(), `gestalt-serve-wt-${Date.now()}`);
    run(here, ['worktree', 'add', '--detach', '-q', wt, 'HEAD']);
    try {
      expect(() => assertServeRoot(here)).not.toThrow();
      expect(() => assertServeRoot(wt)).not.toThrow();
    } finally {
      run(here, ['worktree', 'remove', '--force', wt]);
    }
  });

  it('막힌 자리는 서버를 안 띄우고 4로 끝낸다', async () => {
    const exits: number[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code ?? 0);
      return undefined as never;
    }) as never);

    // 여기서 서버가 뜨면 이 await는 Ctrl+C까지 안 돌아온다. 돌아온다는 것 자체가
    // 판단이 먼저 걸렸다는 뜻이다
    await prServeCommand({ repoRoot: elsewhere, noBrowser: true });

    expect(exits).toEqual([4]);
  });
});
