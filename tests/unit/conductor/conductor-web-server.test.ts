import { request } from 'node:http';
import { realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConductorWebServer } from '../../../src/conductor-web/server.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import { cleanupStateDirs, order, tempStateDir } from './fixtures.js';
import { cleanupOutsideDirs, outsideDir, put, seed } from './results-fixtures.js';

const servers: ConductorWebServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
  cleanupStateDirs();
  cleanupOutsideDirs();
});

const A = 'ord-aaaaaaaa';
const B = 'ord-bbbbbbbb';

async function boot(
  stateDir: string,
  repoPaths?: Record<string, string>,
): Promise<{ server: ConductorWebServer; base: string }> {
  const server = new ConductorWebServer({ stateDir, repoPaths });
  servers.push(server);
  await server.start(0);
  return { server, base: `http://127.0.0.1:${server.port}` };
}

async function get(base: string, path: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, { headers });
}

async function getJson<T = any>(base: string, path: string): Promise<T> {
  const res = await get(base, path);
  expect(res.status, path).toBe(200);
  return (await res.json()) as T;
}

/** fetch는 Host를 못 바꾼다. 위조 Host는 http.request로 보낸다 */
function raw(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = 'GET',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function fixture() {
  const base = tempStateDir();
  const abs = realpathSync(base);
  const note = put(
    join(abs, 'reports', 'final.md'),
    '# 최종\n\n**굵게** <script>alert(1)</script>\n',
  );
  const log = put(join(abs, 'reports', 'run.log'), '로그 <b>줄</b>');
  const dirRef = join(abs, 'refs', 'bundle');
  put(join(dirRef, 'one.md'), '하나 needle');
  put(join(dirRef, 'two.txt'), '둘');
  const outside = put(join(outsideDir(), 'tmp.md'), '밖의 비밀');
  put(join(abs, 'reports', 'loose.md'), '떠도는 needle');
  put(join(abs, 'notes', `${A}-extra.md`), '관련 needle');
  const { dir } = seed(
    [
      {
        order: {
          id: A,
          title: '뷰어 만들기',
          repo: 'acme/app',
          status: 'done',
          issueKey: 'ACME-1',
          updatedAt: '2026-11-03T00:00:00.000Z',
        },
        reports: [
          { summary: '요약 needle', refs: [note, log, dirRef, outside, 'https://example.com/x'] },
        ],
      },
      {
        order: {
          id: B,
          title: '다른 일',
          repo: 'acme/web',
          status: 'queued',
          updatedAt: '2026-11-04T00:00:00.000Z',
        },
      },
    ],
    base,
  );
  return { dir, abs, outside };
}

describe('보안 헤더와 요청 거절', () => {
  it('/는 200이고 CSP, nosniff, no-store, no-referrer가 붙고 CORS 헤더는 없다', async () => {
    const { base } = await boot(fixture().dir);
    const res = await get(base, '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const csp = res.headers.get('content-security-policy')!;
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    for (const d of [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]) {
      expect(csp).toContain(d);
    }
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect([...res.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
    const html = await res.text();
    expect(html).toContain(`nonce="${nonce}"`);
  });

  it('요청마다 nonce가 바뀐다', async () => {
    const { base } = await boot(fixture().dir);
    const n = async () =>
      /nonce-([^']+)'/.exec((await get(base, '/')).headers.get('content-security-policy')!)![1];
    expect(await n()).not.toBe(await n());
  });

  it('JSON API 응답에도 CORS 헤더가 없다', async () => {
    const { base } = await boot(fixture().dir);
    const res = await get(base, '/api/orders', { Origin: 'https://evil.example.com' });
    expect(res.status).toBe(200);
    expect([...res.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
  });

  it('GET과 HEAD 외 메서드는 405와 Allow', async () => {
    const { base } = await boot(fixture().dir);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`${base}/api/orders`, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    }
    expect((await fetch(`${base}/api/orders`, { method: 'HEAD' })).status).toBe(200);
  });

  it('Host가 다르면 403(DNS 리바인딩)이고 localhost와 127.0.0.1은 통과', async () => {
    const { server } = await boot(fixture().dir);
    const port = server.port!;
    for (const host of ['evil.example.com', `evil.example.com:${port}`, '10.0.0.5']) {
      const r = await raw(port, '/api/orders', { Host: host });
      expect(r.status, host).toBe(403);
    }
    expect((await raw(port, '/api/orders', { Host: `localhost:${port}` })).status).toBe(200);
    expect((await raw(port, '/api/orders', { Host: `127.0.0.1:${port}` })).status).toBe(200);
  });

  it('Sec-Fetch-Site: cross-site는 403, same-origin과 none은 통과', async () => {
    const { base } = await boot(fixture().dir);
    expect((await get(base, '/api/orders', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await get(base, '/', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await get(base, '/api/orders', { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    expect((await get(base, '/api/orders', { 'Sec-Fetch-Site': 'none' })).status).toBe(200);
  });

  it('깨진 퍼센트 인코딩은 400', async () => {
    const { server } = await boot(fixture().dir);
    const r = await raw(server.port!, '/api/orders/%E0%A4%A', { Host: `127.0.0.1:${server.port}` });
    expect(r.status).toBe(400);
  });

  it('모르는 경로는 404', async () => {
    const { base } = await boot(fixture().dir);
    for (const p of [
      '/nope',
      '/api',
      '/api/orders/x/y',
      '/api/orders/x/refs/abc',
      '/static/a.js',
    ]) {
      expect((await get(base, p)).status, p).toBe(404);
    }
  });

  it('잘못된 since는 400', async () => {
    const { base } = await boot(fixture().dir);
    expect((await get(base, '/api/orders?since=nope')).status).toBe(400);
    expect((await get(base, '/api/search?q=a&since=nope')).status).toBe(400);
  });
});

describe('시작과 종료', () => {
  it('저장소가 없으면 start가 거절하고 포트를 안 연다', async () => {
    const server = new ConductorWebServer({
      stateDir: join('.gestalt-test', 'conductor-없는경로-web'),
    });
    servers.push(server);
    await expect(server.start(0)).rejects.toThrow('상태 저장소가 없어요');
    expect(server.port).toBeUndefined();
  });

  it('stop은 SIGINT 핸들러를 거두고 두 번 불러도 안전하다', async () => {
    const before = process.listenerCount('SIGINT');
    const { server } = await boot(fixture().dir);
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    await server.stop();
    expect(process.listenerCount('SIGINT')).toBe(before);
    await server.stop();
    expect(server.port).toBeUndefined();
  });

  it('127.0.0.1에만 붙는다', async () => {
    const { server } = await boot(fixture().dir);
    const addr = (
      server as unknown as { server: { address(): { address: string } } }
    ).server.address();
    expect(addr.address).toBe('127.0.0.1');
  });
});

describe('주문 API', () => {
  it('/api/orders는 목록과 필터 선택지, 주문 없음 개수를 준다', async () => {
    const { base } = await boot(fixture().dir);
    const j = await getJson(base, '/api/orders');
    expect(j.total).toBe(2);
    expect(j.matched).toBe(2);
    expect(j.orders.map((o: { id: string }) => o.id)).toEqual([B, A]);
    expect(j.repos).toEqual(['acme/app', 'acme/web']);
    expect(j.statuses).toEqual(expect.arrayContaining(['done', 'queued']));
    expect(j.unlinkedCount).toBe(1);
  });

  it('repo, status, since, issue, q 필터', async () => {
    const { base } = await boot(fixture().dir);
    const ids = async (qs: string) =>
      (await getJson(base, `/api/orders?${qs}`)).orders.map((o: { id: string }) => o.id);
    expect(await ids('repo=acme/web')).toEqual([B]);
    expect(await ids('status=done')).toEqual([A]);
    expect(await ids('since=2026-11-04')).toEqual([B]);
    expect(await ids('issue=ACME-1')).toEqual([A]);
    expect(await ids('q=뷰어')).toEqual([A]);
    expect(await ids('q=ACME-1')).toEqual([A]);
    expect(await ids('q=ORD-BBB')).toEqual([B]);
    const j = await getJson(base, '/api/orders?q=뷰어');
    expect(j.total).toBe(2);
    expect(j.matched).toBe(2);
  });

  it('/api/orders/:id는 상세를 주고 실제 경로와 워커 handle은 안 내보낸다', async () => {
    const { dir, abs, outside } = fixture();
    const { base } = await boot(dir);
    const res = await get(base, `/api/orders/${A}`);
    const raw = await res.text();
    const j = JSON.parse(raw);
    expect(j.order.id).toBe(A);
    expect(j.reports).toHaveLength(1);
    expect(j.workers[0]).not.toHaveProperty('handle');
    expect(j.refs.map((r: { kind: string }) => r.kind)).toEqual([
      'file',
      'file',
      'dir',
      'outside',
      'url',
    ]);
    expect(j.refs[2].entries.map((e: { name: string }) => e.name)).toEqual(['one.md', 'two.txt']);
    expect(j.related.map((f: { rel: string }) => f.rel)).toEqual([`notes/${A}-extra.md`]);
    // display와 reports[].refs는 워커가 적은 값을 그대로 보여 주는 설계다. 서버가 풀어낸 path 필드만 안 나간다
    expect(JSON.stringify(j.refs)).not.toContain('"path"');
    expect(JSON.stringify(j.related)).not.toContain('"path"');
    expect(JSON.stringify(j.refs[2].entries)).not.toContain(abs);
    expect(j.refs[3].display).toBe(outside);
    expect(j.related[0]).not.toHaveProperty('path');
  });

  it('모르는 주문과 퍼센트 인코딩된 가짜 id는 404', async () => {
    const { base } = await boot(fixture().dir);
    expect((await get(base, '/api/orders/ord-00000000')).status).toBe(404);
    expect((await get(base, '/api/orders/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
    expect((await get(base, `/api/orders/${A.slice(0, 6)}`)).status).toBe(404);
  });
});

describe('refs 본문', () => {
  it('md는 렌더한 html과 원문, 크기를 준다. 원시 HTML은 이스케이프', async () => {
    const { base } = await boot(fixture().dir);
    const j = await getJson(base, `/api/orders/${A}/refs/1`);
    expect(j.kind).toBe('file');
    expect(j.text).toContain('<script>alert(1)</script>');
    expect(j.html).toContain('<h1>최종</h1>');
    expect(j.html).toContain('<strong>굵게</strong>');
    expect(j.html).not.toContain('<script');
    expect(j.html).toContain('&lt;script&gt;');
    expect(j.truncated).toBe(false);
  });

  it('md가 아닌 파일은 이스케이프한 코드 블록', async () => {
    const { base } = await boot(fixture().dir);
    const j = await getJson(base, `/api/orders/${A}/refs/2`);
    expect(j.html).toBe('<pre><code>로그 &lt;b&gt;줄&lt;/b&gt;</code></pre>');
  });

  it('디렉토리 ref는 ?entry=로 항목 본문을 열고 entry 없이는 404', async () => {
    const { base } = await boot(fixture().dir);
    const one = await getJson(base, `/api/orders/${A}/refs/3?entry=0`);
    expect(one.text).toBe('하나 needle');
    expect(one.display).toBe('one.md');
    expect((await get(base, `/api/orders/${A}/refs/3`)).status).toBe(404);
    expect((await get(base, `/api/orders/${A}/refs/3?entry=9`)).status).toBe(404);
  });

  it('잘못된 entry는 400', async () => {
    const { base } = await boot(fixture().dir);
    for (const e of ['-1', 'abc', '1.5', '12345', '']) {
      expect((await get(base, `/api/orders/${A}/refs/3?entry=${e}`)).status, e).toBe(400);
    }
  });

  it('outside, url ref와 범위 밖 번호는 404', async () => {
    const { base } = await boot(fixture().dir);
    expect((await get(base, `/api/orders/${A}/refs/4`)).status).toBe(404);
    expect((await get(base, `/api/orders/${A}/refs/5`)).status).toBe(404);
    expect((await get(base, `/api/orders/${A}/refs/0`)).status).toBe(404);
    expect((await get(base, `/api/orders/${A}/refs/99`)).status).toBe(404);
    expect((await get(base, `/api/orders/ord-00000000/refs/1`)).status).toBe(404);
  });

  it('분류 뒤 심링크로 바뀐 파일은 본문을 안 준다', async () => {
    const { dir, abs } = fixture();
    const { base } = await boot(dir);
    const secret = put(join(outsideDir(), 'secret.md'), '비밀');
    const { rmSync } = await import('node:fs');
    rmSync(join(abs, 'reports', 'final.md'));
    symlinkSync(secret, join(abs, 'reports', 'final.md'));
    // events.jsonl은 그대로라 서버는 캐시된 분류(file)를 쓰지만 본문 읽기에서 다시 막아야 한다
    expect((await get(base, `/api/orders/${A}/refs/1`)).status).toBe(404);
  });
});

describe('주문 없음 파일과 파일 키', () => {
  it('/api/unlinked는 주문에 안 붙은 파일만 키와 상대 경로로 주고 path는 없다', async () => {
    const { dir, abs } = fixture();
    const { base } = await boot(dir);
    const res = await get(base, '/api/unlinked');
    const raw = await res.text();
    const j = JSON.parse(raw);
    expect(j.files.map((f: { rel: string }) => f.rel)).toEqual(['reports/loose.md']);
    expect(j.files[0].key).toMatch(/^[0-9a-f]{16}$/);
    expect(j.files[0]).not.toHaveProperty('path');
    expect(raw).not.toContain(abs);
  });

  it('/api/file은 발급된 키로만 본문을 연다', async () => {
    const { base } = await boot(fixture().dir);
    const { files } = await getJson(base, '/api/unlinked');
    const j = await getJson(base, `/api/file?id=${files[0].key}`);
    expect(j.text).toBe('떠도는 needle');
    expect(j.html).toBe('<p>떠도는 needle</p>');
    expect(j).not.toHaveProperty('path');
  });

  it('관련 파일 키도 같은 /api/file로 열린다', async () => {
    const { base } = await boot(fixture().dir);
    const detail = await getJson(base, `/api/orders/${A}`);
    const j = await getJson(base, `/api/file?id=${detail.related[0].key}`);
    expect(j.text).toBe('관련 needle');
  });

  it('위조한 키, 경로, 빈 키, 키 없음은 404', async () => {
    const { dir, abs, outside } = fixture();
    const { base } = await boot(dir);
    for (const id of [
      'ffffffffffffffff',
      '../../etc/passwd',
      '..%2F..%2Fetc%2Fpasswd',
      'reports/loose.md',
      join(abs, 'reports', 'loose.md'),
      outside,
      '/etc/passwd',
      '',
    ]) {
      expect((await get(base, `/api/file?id=${encodeURIComponent(id)}`)).status, id).toBe(404);
    }
    expect((await get(base, '/api/file')).status).toBe(404);
  });
});

describe('검색 API', () => {
  it('searchResults와 같은 결과를 주고 body=0이면 본문을 뺀다', async () => {
    const { base } = await boot(fixture().dir);
    const full = await getJson(base, '/api/search?q=needle');
    expect(full.total).toBeGreaterThanOrEqual(4);
    const sources = new Set(full.hits.map((h: { source: string }) => h.source));
    expect(sources).toEqual(new Set(['summary', 'ref', 'file']));
    const light = await getJson(base, '/api/search?q=needle&body=0');
    expect(new Set(light.hits.map((h: { source: string }) => h.source))).toEqual(
      new Set(['summary']),
    );
  });

  it('필터가 걸리고 빈 검색어는 빈 결과', async () => {
    const { base } = await boot(fixture().dir);
    const web = await getJson(base, '/api/search?q=needle&repo=acme/web');
    expect(web.total).toBe(0);
    const empty = await getJson(base, '/api/search?q=');
    expect(empty).toEqual({ query: '', total: 0, hits: [] });
    const miss = await getJson(base, `/api/search?q=needle&issue=ACME-1`);
    expect(miss.hits.every((h: { orderId: string | null }) => h.orderId === A)).toBe(true);
  });

  it('결과는 200건까지만 보내고 total은 전체 건수', async () => {
    const dir = tempStateDir();
    const store = ConductorStore.open(dir);
    store.addOrder(order({ id: A, title: '대량' }));
    // 제목에 맞는 주문 250개를 더 만든다
    for (let i = 0; i < 250; i++) {
      store.addOrder(order({ id: `ord-${i.toString(16).padStart(8, '0')}`, title: `대량 ${i}` }));
    }
    const { base } = await boot(dir);
    const j = await getJson(base, '/api/search?q=대량');
    expect(j.total).toBe(251);
    expect(j.hits).toHaveLength(200);
  });
});

describe('갱신 반영', () => {
  it('events.jsonl이 바뀌면 다음 요청에서 새 주문이 보인다', async () => {
    const { dir } = fixture();
    const { base } = await boot(dir);
    expect((await getJson(base, '/api/orders')).total).toBe(2);
    ConductorStore.open(dir).addOrder(order({ id: 'ord-cccccccc', title: '새 주문' }));
    const j = await getJson(base, '/api/orders');
    expect(j.total).toBe(3);
    expect((await get(base, '/api/orders/ord-cccccccc')).status).toBe(200);
  });

  it('events.jsonl이 안 바뀌면 파일만 추가돼도 목록을 다시 모으지 않는다(설계대로)', async () => {
    const { dir, abs } = fixture();
    const { base } = await boot(dir);
    expect((await getJson(base, '/api/unlinked')).files).toHaveLength(1);
    put(join(abs, 'reports', 'later.md'), '나중에 생김');
    expect((await getJson(base, '/api/unlinked')).files).toHaveLength(1);
    ConductorStore.open(dir).addOrder(order({ id: 'ord-dddddddd' }));
    expect((await getJson(base, '/api/unlinked')).files).toHaveLength(2);
  });

  it('refs 본문 캐시는 events.jsonl이 바뀌어 다시 읽을 때 갈린다', async () => {
    const { dir, abs } = fixture();
    const { base } = await boot(dir);
    expect((await getJson(base, `/api/orders/${A}/refs/1`)).text).toContain('# 최종');
    put(join(abs, 'reports', 'final.md'), '# 바뀜');
    expect((await getJson(base, `/api/orders/${A}/refs/1`)).text).toContain('# 최종');
    ConductorStore.open(dir).addOrder(order({ id: 'ord-eeeeeeee' }));
    expect((await getJson(base, `/api/orders/${A}/refs/1`)).text).toBe('# 바뀜');
  });

  it('지운 주문은 목록, 상세, 검색에서 사라진다', async () => {
    const { dir } = seed([
      {
        order: { id: A, title: '지울 주문 needle', status: 'done' },
        worker: { status: 'finished' },
        reports: [{ summary: 'needle' }],
      },
      { order: { id: B, title: '남는 주문' } },
    ]);
    const { base } = await boot(dir);
    expect((await getJson(base, '/api/orders')).total).toBe(2);
    ConductorStore.open(dir).removeOrder(A);
    const j = await getJson(base, '/api/orders');
    expect(j.orders.map((o: { id: string }) => o.id)).toEqual([B]);
    expect((await get(base, `/api/orders/${A}`)).status).toBe(404);
    expect((await getJson(base, '/api/search?q=needle')).total).toBe(0);
  });
});

describe('ord-/wrk- 최상위 디렉토리', () => {
  it('ord-는 그 주문 관련 파일로, wrk-는 주문 없음으로 웹에 보인다', async () => {
    const base = tempStateDir();
    const abs = realpathSync(base);
    put(join(abs, `${A}-x`, 'a.md'), '주문 디렉토리');
    put(join(abs, 'wrk-abc12345', 'b.md'), '워커 디렉토리');
    put(join(abs, 'other', 'c.md'), '수집 안 됨');
    seed([{ order: { id: A } }], base);
    const { base: url } = await boot(base);
    const detail = await getJson(url, `/api/orders/${A}`);
    expect(detail.related.map((f: { rel: string }) => f.rel)).toEqual([`${A}-x/a.md`]);
    const un = await getJson(url, '/api/unlinked');
    expect(un.files.map((f: { rel: string }) => f.rel)).toEqual(['wrk-abc12345/b.md']);
  });
});

describe('repoPaths 허용 루트', () => {
  it('repoPaths 밑 파일 ref는 본문을 주고 없는 repoPaths는 무시', async () => {
    const repo = outsideDir();
    const doc = put(join(repo, 'docs', 'plan.md'), '# 계획');
    const { dir } = seed([{ order: { id: A }, reports: [{ refs: [doc] }] }]);
    const closed = await boot(dir);
    expect((await get(closed.base, `/api/orders/${A}/refs/1`)).status).toBe(404);
    const open = await boot(dir, { 'acme/app': repo, 'acme/gone': join(repo, 'nope') });
    expect((await getJson(open.base, `/api/orders/${A}/refs/1`)).text).toBe('# 계획');
  });
});
