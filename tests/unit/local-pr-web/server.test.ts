import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPrEngine } from '../../../src/local-pr/engine.js';
import { PrWebServer } from '../../../src/local-pr-web/server.js';

/**
 * 진짜 git 레포 위에서 LocalPrEngine을 굴리고 PrWebServer가 그 데이터를 그대로
 * 보여주는지 확인한다. local-pr/engine.test.ts와 같은 준비 방식이다.
 */

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function randomPort(): number {
  return 31000 + Math.floor(Math.random() * 10000);
}

describe('PrWebServer', () => {
  let repoRoot: string;
  let engine: LocalPrEngine;
  let server: PrWebServer;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'gestalt-pr-web-'));
    run(repoRoot, ['init', '-q']);
    run(repoRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    run(repoRoot, ['config', 'user.email', 't@e.st']);
    run(repoRoot, ['config', 'user.name', 'test']);

    writeFileSync(join(repoRoot, 'a.txt'), 'line1\n');
    run(repoRoot, ['add', '-A']);
    run(repoRoot, ['commit', '-q', '-m', 'init']);

    run(repoRoot, ['checkout', '-q', '-b', 'feat/x']);
    writeFileSync(join(repoRoot, 'a.txt'), 'line1\nline2\n');
    run(repoRoot, ['commit', '-q', '-am', '두 번째 줄']);

    engine = new LocalPrEngine(repoRoot);
    server = new PrWebServer(engine);
  });

  afterEach(async () => {
    await server.stop();
    engine.dispose();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('GET / 은 PR 목록 HTML을 반환한다', async () => {
    engine.create({ title: '두 번째 줄', author: 'codex:worker-1' });

    const port = randomPort();
    await server.start(port);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const body = await res.text();
    expect(body).toContain('<!DOCTYPE html>');
    expect(body).toContain('두 번째 줄');
  });

  it('GET /api/prs 는 PR 목록 JSON을 반환한다', async () => {
    const pr = engine.create({ title: '두 번째 줄', author: 'codex:worker-1' });

    const port = randomPort();
    await server.start(port);

    const res = await fetch(`http://127.0.0.1:${port}/api/prs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as Array<{ id: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.id).toBe(pr.id);
  });

  it('GET /prs/:id 는 diff가 담긴 상세 HTML을 반환한다', async () => {
    const pr = engine.create({ title: '두 번째 줄', author: 'codex:worker-1' });

    const port = randomPort();
    await server.start(port);

    const res = await fetch(`http://127.0.0.1:${port}/prs/${pr.id}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('line2');
  });

  it('GET /api/prs/:id 는 PR 하나를 JSON으로 반환한다', async () => {
    const pr = engine.create({ title: '두 번째 줄', author: 'codex:worker-1' });

    const port = randomPort();
    await server.start(port);

    const res = await fetch(`http://127.0.0.1:${port}/api/prs/${pr.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; title: string };
    expect(body.id).toBe(pr.id);
    expect(body.title).toBe('두 번째 줄');
  });

  it('없는 PR id는 404를 반환한다', async () => {
    const port = randomPort();
    await server.start(port);

    const htmlRes = await fetch(`http://127.0.0.1:${port}/prs/nope`);
    expect(htmlRes.status).toBe(404);

    const jsonRes = await fetch(`http://127.0.0.1:${port}/api/prs/nope`);
    expect(jsonRes.status).toBe(404);
  });

  it('알 수 없는 경로는 404를 반환한다', async () => {
    const port = randomPort();
    await server.start(port);

    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });

  it('port getter는 start() 후 실제 포트를 반환한다', async () => {
    const port = randomPort();
    await server.start(port);
    expect(server.port).toBe(port);
  });

  it('서버가 떠 있는 동안 새로 단 코멘트가 다음 요청에 바로 보인다', async () => {
    const pr = engine.create({ title: '두 번째 줄', author: 'codex:worker-1' });

    const port = randomPort();
    await server.start(port);

    const before = await (await fetch(`http://127.0.0.1:${port}/prs/${pr.id}`)).text();
    expect(before).not.toContain('나중에 단 코멘트');

    engine.comment(pr.id, { author: 'reviewer', path: 'a.txt', body: '나중에 단 코멘트' });

    const after = await (await fetch(`http://127.0.0.1:${port}/prs/${pr.id}`)).text();
    expect(after).toContain('나중에 단 코멘트');
  });
});
