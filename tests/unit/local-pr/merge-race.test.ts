import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync as realExecFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 머지가 base 브랜치 ref를 옛 값과 함께 미는지 본다.
 *
 * 경쟁 창은 `mergeIntoBase` 안이다 — base를 읽은 뒤 update-ref를 부르기 전. 밖에서는
 * 그 사이에 끼어들 수 없어서 git 호출을 가로채 그 순간에 base를 옮긴다. 이 단언이
 * 틀리면 잃는 것이 남의 커밋이라 우연에 맡길 자리가 아니다.
 */

const hooks: { onMerge?: () => void } = {};

/**
 * 인자 배열에서 서브커맨드를 집는다.
 *
 * 래퍼가 앞에 `-c key=value`를 붙이므로 첫 인자가 서브커맨드가 아니다. 옵션과 그
 * 값을 건너뛰고 처음 나오는 맨 단어를 집는다.
 */
function subcommandOf(args: readonly string[]): string | undefined {
  return args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c');
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (file: string, args: readonly string[], opts: unknown) => {
      const out = actual.execFileSync(file, args as string[], opts as never);
      if (subcommandOf(args) === 'merge' && hooks.onMerge) {
        const fire = hooks.onMerge;
        hooks.onMerge = undefined;
        fire();
      }
      return out;
    },
  };
});

const git = await import('../../../src/local-pr/git.js');

function run(cwd: string, args: string[]): string {
  return realExecFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('머지 중 base 경쟁 갱신', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), `gestalt-merge-race-${randomUUID().slice(0, 8)}-`));
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

    // base를 아무 워크트리도 안 잡은 상태로 만든다 — 임시 워크트리 갈래를 타야 한다
    run(repo, ['checkout', '--detach', '-q', 'HEAD']);
  });

  afterEach(() => {
    hooks.onMerge = undefined;
    rmSync(repo, { recursive: true, force: true });
  });

  it('그 사이 base가 움직였으면 ref를 안 민다', () => {
    const headSha = run(repo, ['rev-parse', 'HEAD']);
    const before = run(repo, ['rev-parse', 'main']);

    // 임시 워크트리에서 머지가 끝난 직후, update-ref 직전에 다른 손이 main을 옮긴다
    hooks.onMerge = () => {
      const tree = run(repo, ['rev-parse', 'main^{tree}']);
      const other = run(repo, ['commit-tree', '-p', before, '-m', '남의 커밋', tree]);
      run(repo, ['update-ref', 'refs/heads/main', other, before]);
    };

    expect(() =>
      git.mergeIntoBase(repo, { prId: 'abcd1234', baseRef: 'main', headSha, title: 't' }),
    ).toThrow();

    // 남의 커밋이 그대로 살아 있어야 한다
    expect(run(repo, ['log', '-1', '--format=%s', 'main'])).toBe('남의 커밋');
  });

  it('아무도 안 건드리면 정상적으로 민다', () => {
    const headSha = run(repo, ['rev-parse', 'HEAD']);

    const result = git.mergeIntoBase(repo, {
      prId: 'abcd1234',
      baseRef: 'main',
      headSha,
      title: 't',
    });

    expect(result.viaWorktree).toBe(true);
    expect(run(repo, ['rev-parse', 'main'])).toBe(result.mergeSha);
  });
});
