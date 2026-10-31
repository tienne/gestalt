import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DIGEST_CSP,
  DigestServer,
  isAllowableHost,
  REQUEST_PATH,
  TOKEN_META_NAME,
  type DigestServerOptions,
} from '../../../src/digest/server.js';
import type { SendResult } from '../../../src/digest/session-request.js';
import { DIARY_FONT_LINK } from '../../../src/digest/theme-diary.js';
import {
  THEME_BOOT_JS_SHA256,
  VIEWER_JS,
  VIEWER_JS_SHA256,
} from '../../../src/digest/viewer-js.js';
import { viewerLogic } from '../../../src/digest/viewer-logic.js';
import { lensTranscript } from '../lens/fixture.js';
import { sampleTranscript } from './fixture.js';

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
    const directive = (name: string) =>
      DIGEST_CSP.split('; ').find((d) => d.startsWith(`${name} `))!;
    expect(directive('style-src')).toBe(
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    );
    expect(directive('font-src')).toBe("font-src 'self' https://fonts.gstatic.com");
    // 글꼴 링크가 받는 스타일시트와 글꼴 파일 출처가 CSP에 들어 있어야 글꼴이 막히지 않는다
    const stylesheet = /rel="stylesheet" href="(https:\/\/[^/"]+)/.exec(DIARY_FONT_LINK)![1]!;
    const fontOrigin = /href="(https:\/\/[^/"]+)" crossorigin/.exec(DIARY_FONT_LINK)![1]!;
    expect(directive('style-src')).toContain(stylesheet);
    expect(directive('font-src')).toContain(fontOrigin);
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

describe('DigestServer 세션 요청', () => {
  const PAGE = '<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>';

  async function serve(opts: DigestServerOptions = {}) {
    const base = resolve('.gestalt-test', `digest-request-${randomUUID()}`);
    const root = join(base, '.gestalt', 'digest');
    mkdirSync(join(root, 's1'), { recursive: true });
    mkdirSync(join(root, 'paper'), { recursive: true });
    writeFileSync(join(root, 's1', 'digest.html'), PAGE);
    writeFileSync(
      join(root, 's1', 'transcript.json'),
      JSON.stringify(sampleTranscript({ slug: 's1' })),
    );
    writeFileSync(
      join(root, 'paper', 'transcript.json'),
      JSON.stringify({ ...lensTranscript('web'), slug: 'paper' }),
    );
    const sent: string[] = [];
    const server = new DigestServer(root, {
      templates: [{ id: 'quiz' }, { id: 'comments', kinds: ['video'] }],
      sendToSession: (text) => {
        sent.push(text);
        return Promise.resolve({ ok: true });
      },
      ...opts,
    });
    await server.start(0);
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    cleanups.push(() => server.stop());
    const page = await get(server.port!, '/s1/');
    const token = new RegExp(`<meta name="${TOKEN_META_NAME}" content="([^"]+)">`).exec(
      page.body,
    )![1]!;
    return { server, port: server.port!, root, token, sent };
  }

  function post(
    port: number,
    body: string,
    headers: Record<string, string | undefined>,
  ): Promise<{ status: number; json: { ok: boolean; code: string } }> {
    return new Promise((done, reject) => {
      const h: Record<string, string> = { host: `127.0.0.1:${port}` };
      for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
      const req = request(
        { host: '127.0.0.1', port, path: REQUEST_PATH, method: 'POST', headers: h },
        (res) => {
          let text = '';
          res.on('data', (c: Buffer) => (text += c.toString()));
          res.on('end', () =>
            done({
              status: res.statusCode!,
              json: JSON.parse(text) as { ok: boolean; code: string },
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  const ok = (port: number, token: string) => ({
    origin: `http://127.0.0.1:${port}`,
    'x-gestalt-token': token,
    'content-type': 'application/json',
  });
  const easy = JSON.stringify(viewerLogic.reportRequest('s1', 'easy', 'ko'));

  it('토큰은 내줄 때만 head에 끼우고 디스크에는 쓰지 않는다. HEAD도 같은 길이를 알린다', async () => {
    const { port, root, token } = await serve();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(join(root, 's1', 'digest.html'), 'utf8')).toBe(PAGE);
    const page = await get(port, '/s1/');
    expect(page.body.indexOf(TOKEN_META_NAME)).toBeLessThan(page.body.indexOf('</head>'));
    const head = await get(port, '/s1/', { method: 'HEAD' });
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(page.body)));
    expect(page.headers['content-length']).toBe(String(Buffer.byteLength(page.body)));
    // 뷰어 스크립트가 같은 이름과 경로를 쓴다
    expect(VIEWER_JS).toContain(`meta[name="${TOKEN_META_NAME}"]`);
    expect(VIEWER_JS).toContain(`'${REQUEST_PATH}'`);
  });

  it('통과한 요청은 서버가 조립한 틀로 세션에 넣고 고정 코드로 답한다', async () => {
    const { port, token, sent } = await serve();
    const r = await post(port, easy, ok(port, token));
    expect(r).toEqual({ status: 200, json: { ok: true, code: 'sent' } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.split('\n')[1]).toBe(
      '/gestalt:video-digest slug=s1 difficulty=easy reportLang=ko',
    );
  });

  it('localhost 출처도 같은 포트면 받는다', async () => {
    const { port, token } = await serve();
    const r = await post(port, easy, {
      ...ok(port, token),
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
    });
    expect(r.status).toBe(200);
  });

  it('넘겨받은 이름은 Host와 https 출처로 받고 그 밖의 이름은 여전히 막는다', async () => {
    const ts = 'home-macbook.tailnet.ts.net';
    const { port, token, sent } = await serve({ allowHosts: [ts] });
    const page = await get(port, '/s1/', { host: ts });
    expect(page.status).toBe(200);
    expect(
      await post(port, easy, { ...ok(port, token), host: ts, origin: `https://${ts}` }),
    ).toEqual({ status: 200, json: { ok: true, code: 'sent' } });
    expect(
      (await post(port, easy, { ...ok(port, token), host: ts, origin: `http://${ts}:${port}` }))
        .status,
    ).toBe(200);
    for (const origin of [`http://${ts}`, `https://${ts}:8443`, `https://evil.${ts}`]) {
      expect((await post(port, easy, { ...ok(port, token), host: ts, origin })).status).toBe(403);
    }
    expect((await get(port, '/s1/', { host: `evil.${ts}` })).status).toBe(403);
    expect(sent).toHaveLength(2);
  });

  it('호스트 이름 꼴이 아닌 값은 서버를 만들 때 거절한다', () => {
    for (const bad of ['*.ts.net', 'a.ts.net:443', 'http://a.ts.net', 'a/b', '']) {
      expect(isAllowableHost(bad)).toBe(false);
      expect(() => new DigestServer('.', { allowHosts: [bad] })).toThrow();
    }
    expect(isAllowableHost('home-macbook.tailb87648.ts.net')).toBe(true);
  });

  it('렌즈 자료는 transcript에서 종류를 읽어 lens 명령을 넣는다', async () => {
    const { port, token, sent } = await serve();
    const body = JSON.stringify(viewerLogic.templateRequest('paper', 'quiz', 'ko'));
    expect((await post(port, body, ok(port, token))).status).toBe(200);
    expect(sent[0]!.split('\n')[1]).toBe('/gestalt:lens slug=paper templates=quiz reportLang=ko');
  });

  it('Origin이 없거나 다르면, 토큰이 없거나 틀리면 403이고 세션에 넣지 않는다', async () => {
    const { port, token, sent } = await serve();
    const cases: Array<Record<string, string | undefined>> = [
      { ...ok(port, token), origin: undefined },
      { ...ok(port, token), origin: 'https://evil.example' },
      { ...ok(port, token), origin: `http://127.0.0.1:${port + 1}` },
      { ...ok(port, token), origin: 'null' },
      { ...ok(port, token), 'x-gestalt-token': undefined },
      { ...ok(port, token), 'x-gestalt-token': token.slice(1) },
      { ...ok(port, token), 'x-gestalt-token': `${token.slice(0, -1)}A` },
    ];
    for (const headers of cases) {
      expect(await post(port, easy, headers)).toEqual({
        status: 403,
        json: { ok: false, code: 'forbidden' },
      });
    }
    expect(sent).toEqual([]);
  });

  it('Host가 로컬이 아니면 Origin과 토큰이 맞아도 403이다', async () => {
    const { port, token, sent } = await serve();
    const r = await new Promise<number>((done) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: REQUEST_PATH,
          method: 'POST',
          headers: { ...ok(port, token), host: 'evil.example' },
        },
        (res) => {
          res.resume();
          done(res.statusCode!);
        },
      );
      req.end(easy);
    });
    expect(r).toBe(403);
    expect(sent).toEqual([]);
  });

  it('JSON이 아니거나 2KB를 넘거나 꼴이 틀리면 거절한다', async () => {
    const { port, token, sent } = await serve();
    const h = ok(port, token);
    expect((await post(port, easy, { ...h, 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(port, 'x'.repeat(3000), h)).json.code).toBe('too_large');
    expect((await post(port, '{not json', h)).json.code).toBe('bad_request');
    const bad = [
      { action: 'report', slug: 's1', difficulty: 'easy', prompt: 'rm -rf' },
      { action: 'report', slug: '../s1', difficulty: 'easy' },
      { action: 'report', slug: 's1', difficulty: 'easy', lang: 'ko\n/x' },
      { action: 'report', slug: 's1', difficulty: 'easy', range: [10, 5] },
    ];
    for (const body of bad) {
      expect((await post(port, JSON.stringify(body), h)).json.code).toBe('bad_request');
    }
    expect(sent).toEqual([]);
  });

  it('없는 slug, 목록에 없거나 종류가 안 맞는 템플릿은 404다', async () => {
    const { port, token, sent } = await serve();
    const h = ok(port, token);
    const missing = JSON.stringify(viewerLogic.reportRequest('nope', 'easy'));
    expect((await post(port, missing, h)).json.code).toBe('unknown_slug');
    const unknown = JSON.stringify(viewerLogic.templateRequest('s1', 'mindmap'));
    expect((await post(port, unknown, h)).json.code).toBe('unknown_template');
    const videoOnly = JSON.stringify(viewerLogic.templateRequest('paper', 'comments'));
    expect((await post(port, videoOnly, h)).json.code).toBe('unknown_template');
    expect(sent).toEqual([]);
    const fits = JSON.stringify(viewerLogic.templateRequest('s1', 'comments'));
    expect((await post(port, fits, h)).status).toBe(200);
  });

  it('세션을 못 찾거나 쓰다 실패하면 이유 없이 코드만 돌려준다', async () => {
    let result: SendResult = {
      ok: false,
      code: 'no_session',
      reason: '/Users/x/.claude 세션 없음',
    };
    const { port, token } = await serve({ sendToSession: () => Promise.resolve(result) });
    const r = await post(port, easy, ok(port, token));
    expect(r).toEqual({ status: 503, json: { ok: false, code: 'no_session' } });
    result = { ok: false, code: 'send_failed', reason: 'x' };
    expect((await post(port, easy, ok(port, token))).json).toEqual({
      ok: false,
      code: 'send_failed',
    });
  });

  it('토큰을 통과한 요청만 1분에 6건까지 받는다', async () => {
    let now = 1_000_000;
    const { port, token } = await serve({ now: () => now });
    for (let i = 0; i < 3; i++) {
      expect((await post(port, easy, { ...ok(port, token), 'x-gestalt-token': 'x' })).status).toBe(
        403,
      );
    }
    for (let i = 0; i < 6; i++) expect((await post(port, easy, ok(port, token))).status).toBe(200);
    expect((await post(port, easy, ok(port, token))).json.code).toBe('rate_limited');
    now += 60_000;
    expect((await post(port, easy, ok(port, token))).status).toBe(200);
  });

  it('요청 자리는 POST만 받고 다른 경로의 POST는 여전히 405다', async () => {
    const { port } = await serve();
    expect((await get(port, REQUEST_PATH)).status).toBe(404);
    expect((await get(port, '/s1/', { method: 'POST' })).status).toBe(405);
  });
});
