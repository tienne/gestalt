import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrWebEngine } from '../../../src/local-pr-web/engine.js';
import { registerRepo } from '../../../src/local-pr/registry.js';

/**
 * 서버 하나가 등록된 레포를 전부 연다.
 *
 * 목록에는 남의 레포가 섞여 있고 그중 하나가 옮겨지거나 .git이 깨질 수 있다.
 * 그때 나머지까지 못 보면 목록이 길수록 서버가 잘 안 뜬다.
 */
function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/**
 * `.git`을 다른 자리를 가리키는 깨진 gitfile로 바꾼다.
 *
 * 파일은 남으므로 목록의 존재 검사는 통과하고 열 때 죽는다 — 목록에 있는데 못 여는
 * 상태가 딱 이 모양이다. HEAD나 objects만 지우는 방식은 git 버전에 따라 여전히
 * 레포로 인식돼서 리눅스에서만 통과하는 테스트가 됐다.
 */
function breakRepo(repo: string): void {
  rmSync(join(repo, '.git'), { recursive: true, force: true });
  writeFileSync(join(repo, '.git'), 'gitdir: /nonexistent-gestalt-broken\n', 'utf-8');
}

function makeRepo(label: string): string {
  const repo = mkdtempSync(join(tmpdir(), `gestalt-web-${label}-${randomUUID().slice(0, 8)}-`));
  run(repo, ['init', '-q']);
  run(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  run(repo, ['config', 'user.email', 't@e.st']);
  run(repo, ['config', 'user.name', 'test']);
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  run(repo, ['add', '-A']);
  run(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

describe('PrWebEngine', () => {
  let home: string;
  let savedHome: string | undefined;
  const repos: string[] = [];
  let engine: PrWebEngine;

  beforeEach(() => {
    savedHome = process.env['GESTALT_HOME'];
    home = mkdtempSync(join(tmpdir(), `gestalt-web-home-${randomUUID().slice(0, 8)}-`));
    process.env['GESTALT_HOME'] = home;
    engine = new PrWebEngine();
  });

  afterEach(async () => {
    await engine.stop();
    if (savedHome === undefined) delete process.env['GESTALT_HOME'];
    else process.env['GESTALT_HOME'] = savedHome;
    rmSync(home, { recursive: true, force: true });
    for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it('등록된 레포를 전부 연다', async () => {
    const a = makeRepo('a');
    const b = makeRepo('b');
    repos.push(a, b);
    registerRepo(a);
    registerRepo(b);

    const result = await engine.start({ repoRoot: a, port: 0, openBrowser: false });

    const res = await fetch(`${result.url}/api/repos`);
    expect((await res.json()) as unknown[]).toHaveLength(2);
  });

  it('못 여는 레포가 있어도 나머지는 연다', async () => {
    const good = makeRepo('good');
    const broken = makeRepo('broken');
    repos.push(good, broken);
    registerRepo(good);
    registerRepo(broken);

    breakRepo(broken);

    const result = await engine.start({ repoRoot: good, port: 0, openBrowser: false });

    const listed = (await (await fetch(`${result.url}/api/repos`)).json()) as { path: string }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]!.path).toContain('good');
  });

  it('지금 자리를 못 열면 알리고 멈춘다', async () => {
    const repo = makeRepo('self');
    repos.push(repo);
    breakRepo(repo);

    // 나머지는 건너뛰어도 되지만 정작 이 자리를 못 열면 보여줄 게 없다
    await expect(engine.start({ repoRoot: repo, port: 0, openBrowser: false })).rejects.toThrow();
  });
});
