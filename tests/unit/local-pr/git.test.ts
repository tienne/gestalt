import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from '../../../src/local-pr/git.js';

/**
 * git 래퍼가 대상 레포의 config를 그대로 타면 안 된다.
 *
 * `diff.external`, `diff.<드라이버>.textconv`, `core.fsmonitor`에 적힌 값은 전부
 * git이 실행하는 외부 명령이다. 그런데 이 래퍼는 `pr serve`가 띄운 인증 없는 웹
 * 서버의 요청 경로에서도 돈다. 그 서버가 여는 목록에는 사용자가 한 번이라도 serve를
 * 돌린 남의 클론이 함께 들어 있다. `.git/config`는 에이전트가 쓸 수 있는 파일이라
 * 막지 않으면 HTTP GET 한 번이 거기 적힌 명령을 실행시킨다.
 */

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('git 래퍼가 config에 적힌 외부 명령을 안 태운다', () => {
  let repo: string;
  /** 스크립트와 자국은 레포 밖에 둔다. 안에 두면 추적 안 되는 파일이 되어 `isClean`이 흔들린다 */
  let aside: string;
  let marker: string;
  let baseSha: string;
  let headSha: string;

  /** 불리면 자국을 남기는 스크립트. git이 실제로 실행했는지를 파일 하나로 본다 */
  function plantScript(): string {
    const script = join(aside, 'mark.sh');
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\nexit 0\n`, 'utf-8');
    chmodSync(script, 0o755);
    return script;
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gestalt-git-config-'));
    aside = mkdtempSync(join(tmpdir(), 'gestalt-git-aside-'));
    marker = join(aside, 'RAN');
    run(repo, ['init', '-q']);
    run(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    run(repo, ['config', 'user.email', 't@e.st']);
    run(repo, ['config', 'user.name', 'test']);
    writeFileSync(join(repo, 'a.txt'), 'line1\n');
    run(repo, ['add', '-A']);
    run(repo, ['commit', '-q', '-m', 'init']);
    baseSha = run(repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'a.txt'), 'line1\nline2\n');
    run(repo, ['commit', '-q', '-am', '두 번째 줄']);
    headSha = run(repo, ['rev-parse', 'HEAD']);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(aside, { recursive: true, force: true });
  });

  it('diff.external에 적힌 명령을 안 부른다', () => {
    run(repo, ['config', 'diff.external', plantScript()]);

    // `pr diff`와 웹 UI의 상세 페이지가 이 함수를 그대로 부른다
    const out = git.diff(repo, baseSha, headSha);

    expect(existsSync(marker)).toBe(false);
    // 껐다고 diff가 안 나오면 막은 게 아니라 부순 것이다.
    // `-c diff.external=`이 그 자리다 — 빈 문자열을 실행 파일로 알아듣고 죽는다
    expect(out).toContain('line2');
  });

  it('diff.<드라이버>.textconv에 적힌 명령을 안 부른다', () => {
    writeFileSync(join(repo, '.gitattributes'), 'a.txt diff=mark\n', 'utf-8');
    run(repo, ['add', '-A']);
    run(repo, ['commit', '-q', '-m', 'attrs']);
    run(repo, ['config', 'diff.mark.textconv', plantScript()]);

    git.diff(repo, baseSha, headSha);
    git.diffStat(repo, baseSha, headSha);
    git.changedFiles(repo, baseSha, headSha);

    expect(existsSync(marker)).toBe(false);
  });

  it('core.fsmonitor에 적힌 명령을 안 부른다', () => {
    run(repo, ['config', 'core.fsmonitor', plantScript()]);

    // `--remove`가 지킬 변경이 있는지 볼 때 이 자리를 지난다
    expect(git.isClean(repo)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});

/**
 * rev와 브랜치 이름에 `-`로 시작하는 값이 들어가면 git이 옵션으로 읽는다.
 *
 * 출처는 MCP `ges_pr`의 `base`와 `head`이고 거기 스키마는 아직 `z.string()`뿐이다.
 * execFileSync라 셸 주입은 없지만 옵션으로 읽히는 것만으로 충분히 위험하다 —
 * `--output=...`은 파일을 쓰고 `--upload-pack=...`은 명령을 실행한다.
 */
describe('rev와 ref 이름이 옵션으로 읽히지 않는다', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gestalt-git-dash-'));
    run(repo, ['init', '-q']);
    run(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    run(repo, ['config', 'user.email', 't@e.st']);
    run(repo, ['config', 'user.name', 'test']);
    writeFileSync(join(repo, 'a.txt'), 'line1\n');
    run(repo, ['add', '-A']);
    run(repo, ['commit', '-q', '-m', 'init']);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('rev가 -로 시작하면 git을 부르기 전에 막는다', () => {
    // 이 값이 그대로 가면 git이 `--output=`을 옵션으로 읽어 그 자리에 파일을 쓴다
    const written = join(repo, 'written.txt');
    expect(() => git.resolveSha(repo, `--output=${written}`)).toThrow(/-로 시작/);
    expect(existsSync(written)).toBe(false);
  });

  it('merge-base의 두 자리 모두 -로 시작하면 막는다', () => {
    expect(() => git.mergeBase(repo, '--all', 'HEAD')).toThrow(/-로 시작/);
    expect(() => git.mergeBase(repo, 'HEAD', '--all')).toThrow(/-로 시작/);
  });

  it('브랜치 이름이 -로 시작하면 막는다', () => {
    // `git branch -D --remotes`는 다른 걸 지운다
    expect(() => git.deleteBranch(repo, '--remotes')).toThrow(/-로 시작/);
  });

  it('빈 값도 막는다', () => {
    // 빈 문자열은 git이 HEAD로 알아듣거나 엉뚱한 자리를 가리킨다
    expect(() => git.resolveSha(repo, '')).toThrow(/비었다/);
  });

  it('diff 계열의 sha 자리도 막는다', () => {
    // `--`가 뒤에 붙어 있어도 안 막힌다. git은 첫 비옵션 인자 전까지 옵션을 읽으므로
    // `${base}..${head}`의 앞자리가 `-`로 시작하면 그대로 옵션이 된다.
    // `git diff "--output=/tmp/X..HEAD" --`로 임의 파일 쓰기가 실제로 된다
    const written = join(repo, 'diff-written.txt');
    expect(() => git.diff(repo, `--output=${written}`, 'HEAD')).toThrow(/-로 시작/);
    expect(() => git.changedFiles(repo, `--output=${written}`, 'HEAD')).toThrow(/-로 시작/);
    expect(() => git.diffStat(repo, `--output=${written}`, 'HEAD')).toThrow(/-로 시작/);
    expect(existsSync(written)).toBe(false);
    // 뒷자리도 같이 막는다
    expect(() => git.diff(repo, 'HEAD', '--output=x')).toThrow(/-로 시작/);
  });

  it('머지와 체크아웃의 head sha 자리도 막는다', () => {
    // `merge --no-ff <headSha>`와 `worktree add ... <headSha>`는 baseRef와 달리
    // 앞에 붙는 게 없어서 값이 그대로 옵션 자리에 선다
    expect(() =>
      git.mergeIntoBase(repo, {
        prId: 'abcd1234',
        baseRef: 'main',
        headSha: '--abort',
        title: 't',
      }),
    ).toThrow(/-로 시작/);
    expect(() => git.checkoutPrHead(repo, 'abcd1234', '--detach')).toThrow(/-로 시작/);
  });

  it('멀쩡한 rev는 그대로 통한다', () => {
    expect(git.resolveSha(repo, 'HEAD')).toMatch(/^[0-9a-f]{40}$/);
    expect(git.mergeBase(repo, 'HEAD', 'HEAD')).toMatch(/^[0-9a-f]{40}$/);
    // `-`가 이름 안에 있는 건 흔하다. 시작만 막는다
    run(repo, ['checkout', '-q', '-b', 'feat/a-b']);
    run(repo, ['checkout', '-q', 'main']);
    expect(() => git.deleteBranch(repo, 'feat/a-b')).not.toThrow();
    // 막는 쪽만 세우면 diff를 통째로 부숴도 테스트가 통과한다
    expect(() => git.diff(repo, 'HEAD', 'HEAD')).not.toThrow();
    expect(git.changedFiles(repo, 'HEAD', 'HEAD')).toEqual([]);
  });
});
