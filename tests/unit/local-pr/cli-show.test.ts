import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPrEngine } from '../../../src/local-pr/engine.js';
import { prCommentsCommand, prShowCommand } from '../../../src/cli/commands/pr.js';

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
