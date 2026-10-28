import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DIGEST_CSP, DigestServer } from '../../../src/digest/server.js';
import { THEME_BOOT_JS_SHA256, VIEWER_JS_SHA256 } from '../../../src/digest/viewer-js.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function started() {
  const base = resolve('.gestalt-test', `digest-server-${randomUUID()}`);
  const root = join(base, '.gestalt', 'digest');
  mkdirSync(join(root, 's1', 'frames'), { recursive: true });
  mkdirSync(join(root, 's1', 'cache'), { recursive: true });
  writeFileSync(join(root, 's1', 'digest.html'), '<!doctype html><p>hi</p>');
  writeFileSync(join(root, 's1', 'frames', 't00000000.jpg'), 'jpg');
  writeFileSync(join(root, 's1', 'digest.json'), '{}');
  writeFileSync(join(root, 's1', 'cache', 'video.md'), 'cached');
  writeFileSync(join(root, 's1', 'locked.md'), 'locked');
  writeFileSync(join(base, 'secret.md'), 'secret');
  symlinkSync(join(base, 'secret.md'), join(root, 's1', 'link.md'));
  const server = new DigestServer(root);
  await server.start(0);
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  cleanups.push(() => chmodSync(join(root, 's1', 'locked.md'), 0o644));
  cleanups.push(() => server.stop());
  return server;
}

function get(
  port: number,
  path: string,
  opts: { host?: string; method?: string } = {},
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((done, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: { host: opts.host ?? `127.0.0.1:${port}` },
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => done({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('DigestServer', () => {
  it('127.0.0.1에만 바인딩한다', async () => {
    const server = await started();
    // @ts-expect-error 바인딩 주소를 보려고 내부 서버를 연다
    expect(server.server.address().address).toBe('127.0.0.1');
  });

  it('슬러그 폴더의 digest.html을 CSP와 referrer 정책과 함께 내준다', async () => {
    const server = await started();
    const r = await get(server.port!, '/s1/');
    expect(r.status).toBe(200);
    expect(r.body).toContain('<p>hi</p>');
    expect(r.headers['content-security-policy']).toBe(DIGEST_CSP);
    expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(DIGEST_CSP).toContain('frame-src https://www.youtube.com');
    const scriptSrc = DIGEST_CSP.split('; ').find((d) => d.startsWith('script-src'))!;
    expect(scriptSrc).toContain(`'sha256-${VIEWER_JS_SHA256}'`);
    expect(scriptSrc).toContain(`'sha256-${THEME_BOOT_JS_SHA256}'`);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(DIGEST_CSP).toContain("frame-ancestors 'none'");
    expect(DIGEST_CSP).toContain("object-src 'none'");
    const img = await get(server.port!, '/s1/frames/t00000000.jpg');
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
  });

  it('Host가 로컬이 아니면 403', async () => {
    const server = await started();
    expect((await get(server.port!, '/s1/', { host: 'evil.example' })).status).toBe(403);
    expect((await get(server.port!, '/s1/', { host: 'localhost' })).status).toBe(200);
  });

  it('루트 밖 경로와 심링크, 받아 둔 영상, JSON은 내주지 않는다', async () => {
    const server = await started();
    const port = server.port!;
    expect((await get(port, '/s1/..%2f..%2f..%2fsecret.md')).status).toBe(404);
    expect((await get(port, '/../../secret.md')).status).toBe(404);
    expect((await get(port, '/s1/link.md')).status).toBe(404);
    expect((await get(port, '/s1/cache/video.md')).status).toBe(404);
    expect((await get(port, '/s1/digest.json')).status).toBe(404);
    expect((await get(port, '/s1/%E0%A4%A')).status).toBe(400);
  });

  it('파일을 열다 실패해도 그 요청만 끊고 서버는 계속 돈다', async () => {
    const server = await started();
    const port = server.port!;
    chmodSync(join(server['root'], 's1', 'locked.md'), 0o000);
    // root로 돌면 권한과 무관하게 읽히니 응답 내용 대신 서버가 살아 있는지만 본다
    await new Promise<void>((done) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/s1/locked.md', headers: { host: `127.0.0.1:${port}` } },
        (res) => {
          res.on('error', () => done());
          res.on('close', () => done());
          res.resume();
        },
      );
      req.on('error', () => done());
      req.end();
    });
    expect((await get(port, '/s1/')).status).toBe(200);
  });

  it('GET과 HEAD 말고는 405', async () => {
    const server = await started();
    const r = await get(server.port!, '/s1/', { method: 'POST' });
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe('GET, HEAD');
  });
});
