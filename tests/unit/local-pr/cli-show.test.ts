import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPrEngine } from '../../../src/local-pr/engine.js';
import { prCommentsCommand, prPruneCommand, prShowCommand } from '../../../src/cli/commands/pr.js';

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
