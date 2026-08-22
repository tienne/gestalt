import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPrEngine } from '../../../src/local-pr/engine.js';
import { PrWebServer } from '../../../src/local-pr-web/server.js';
import { repoKey as key } from '../../../src/local-pr/registry.js';

/**
 * 진짜 git 레포 위에서 LocalPrEngine을 굴리고 PrWebServer가 그 데이터를 그대로
 * 보여주는지 확인한다. local-pr/engine.test.ts와 같은 준비 방식이다.
 */

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/**
 * 포트는 OS에 맡긴다.
 *
 * 난수로 고르면 이미 쓰이는 자리를 집었을 때 코드가 아니라 환경 때문에 실패한다.
 * vitest가 파일을 병렬로 돌리고 CI가 매트릭스 넷을 굴리는 레포라 실제로 밟는다.
 * 0을 주면 listen이 빈 자리를 잡아준다. port getter가 그 값을 되짚는지도 함께 걸린다.
 */
const ANY_PORT = 0;

describe('PrWebServer', () => {
  let repoRoot: string;
  let engine: LocalPrEngine;
  let server: PrWebServer;
  let repoKey: string;

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
    repoKey = key(repoRoot);
    server = new PrWebServer(
      new Map([
        [repoKey, { repo: { key: repoKey, path: repoRoot, name: 'r', addedAt: '' }, engine }],
      ]),
      repoKey,
    );
  });

  afterEach(async () => {
    await server.stop();
    engine.dispose();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('GET / 은 PR 목록 HTML을 반환한다', async () => {
    engine.create({ title: '두 번째 줄', author: 'codex:worker-1' });

    await server.start(ANY_PORT);
    const port = server.port!;

    const res = await fetch(`http://127.0.0.1:${port}/r/${repoKey}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const body = await res.text();
    expect(body).toContain('<!DOCTYPE html>');
    expect(body).toContain('두 번째 줄');
  });

  it('GET /api/prs 는 PR 목록 JSON을 반환한다', async () => {
    const pr = engine.create({ title: '두 번째 줄', author: 'codex:worker-1' });

    await server.start(ANY_PORT);
    const port = server.port!;

    const res = await fetch(`http://127.0.0.1:${port}/api/r/${repoKey}/prs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as Array<{ id: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.id).toBe(pr.id);
  });

  it('GET /prs/:id 는 diff가 담긴 상세 HTML을 반환한다', async () => {
    const pr = engine.create({ title: '두 번째 줄', author: 'codex:worker-1' });

    await server.start(ANY_PORT);
    const port = server.port!;

    const res = await fetch(`http://127.0.0.1:${port}/r/${repoKey}/prs/${pr.id}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('line2');
  });

  it('GET /api/prs/:id 는 PR 하나를 JSON으로 반환한다', async () => {
    const pr = engine.create({ title: '두 번째 줄', author: 'codex:worker-1' });

    await server.start(ANY_PORT);
    const port = server.port!;

    const res = await fetch(`http://127.0.0.1:${port}/api/r/${repoKey}/prs/${pr.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; title: string };
    expect(body.id).toBe(pr.id);
    expect(body.title).toBe('두 번째 줄');
  });

  it('없는 PR id는 404를 반환한다', async () => {
    await server.start(ANY_PORT);
    const port = server.port!;

    const htmlRes = await fetch(`http://127.0.0.1:${port}/r/${repoKey}/prs/nope`);
    expect(htmlRes.status).toBe(404);

    const jsonRes = await fetch(`http://127.0.0.1:${port}/api/r/${repoKey}/prs/nope`);
    expect(jsonRes.status).toBe(404);
  });

  it('알 수 없는 경로는 404를 반환한다', async () => {
    await server.start(ANY_PORT);
    const port = server.port!;

    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });

  it('port getter는 OS가 잡아준 실제 포트를 반환한다', async () => {
    await server.start(ANY_PORT);

    // 요청값을 되받는 게 아니라 listen이 정한 자리를 읽는다. 0을 그대로 돌려주면
    // `pr serve`가 http://127.0.0.1:0 이라는 죽은 주소를 사용자에게 알려준다
    expect(server.port).toBeGreaterThan(0);
    expect((await fetch(`http://127.0.0.1:${server.port}/r/${repoKey}`)).status).toBe(200);
  });

  it('서버가 떠 있는 동안 새로 단 코멘트가 다음 요청에 바로 보인다', async () => {
    const pr = engine.create({ title: '두 번째 줄', author: 'codex:worker-1' });

    await server.start(ANY_PORT);
    const port = server.port!;

    const before = await (await fetch(`http://127.0.0.1:${port}/r/${repoKey}/prs/${pr.id}`)).text();
    expect(before).not.toContain('나중에 단 코멘트');

    engine.comment(pr.id, { author: 'reviewer', path: 'a.txt', body: '나중에 단 코멘트' });

    const after = await (await fetch(`http://127.0.0.1:${port}/r/${repoKey}/prs/${pr.id}`)).text();
    expect(after).toContain('나중에 단 코멘트');
  });
  it('퍼센트 인코딩이 깨져도 서버가 죽지 않는다', async () => {
    await server.start(ANY_PORT);
    const port = server.port!;

    // decodeURIComponent가 던진 URIError가 요청 리스너를 빠져나가면 프로세스가 죽는다.
    // 임의 웹페이지가 img 태그 한 줄로 보낼 수 있는 요청이다
    expect((await fetch(`http://127.0.0.1:${port}/%`)).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}/r/${repoKey}`)).status).toBe(200);
  });

  it('JSON 응답에 CORS 와일드카드를 안 붙인다', async () => {
    await server.start(ANY_PORT);

    const res = await fetch(`http://127.0.0.1:${server.port}/api/r/${repoKey}/prs`);

    // 와일드카드를 열면 127.0.0.1 바인딩으로 얻은 격리가 풀린다
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('읽기 전용이라 GET과 HEAD 밖은 405로 답한다', async () => {
    await server.start(ANY_PORT);

    const res = await fetch(`http://127.0.0.1:${server.port}/`, { method: 'POST' });

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('Host가 로컬이 아니면 거부한다', async () => {
    await server.start(ANY_PORT);

    // fetch는 Host를 못 바꾸게 막으므로 소켓으로 직접 보낸다.
    // 127.0.0.1 바인딩만으로는 DNS 리바인딩이 남의 이름으로 이 자리에 닿는다
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/api/prs',
          headers: { Host: 'evil.example.com' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(status).toBe(403);
  });
  it('/ 는 지금 레포로 보낸다', async () => {
    await server.start(ANY_PORT);

    const res = await fetch(`http://127.0.0.1:${server.port}/`, { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/r/${repoKey}`);
  });

  it('등록 안 된 레포 키는 404다', async () => {
    await server.start(ANY_PORT);

    // URL에 실리는 건 경로가 아니라 키다. 요청이 새 자리를 가리킬 방법이 없어야 한다
    expect((await fetch(`http://127.0.0.1:${server.port}/r/deadbeef`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/r/deadbeef/prs`)).status).toBe(404);
  });

  it('레포 키 형식이 아니면 라우트가 안 걸린다', async () => {
    await server.start(ANY_PORT);

    // 경로를 그대로 넣어보는 시도가 키 자리에 안 맞는다
    for (const bad of ['..%2F..%2Fetc', '/etc/passwd', 'zzzzzzzz!']) {
      const res = await fetch(`http://127.0.0.1:${server.port}/r/${encodeURIComponent(bad)}`);
      expect(res.status).toBe(404);
    }
  });
});
