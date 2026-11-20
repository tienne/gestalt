// 라이브 Ask 전체 흐름: render → serve → 뷰어 질문 → 세션 전달 → IR 반영 재렌더 → 새로고침 없는 갱신.
// 세션만 가짜로 두고 서버와 렌더러, 뷰어 스크립트는 실제 코드를 돌린다. 뷰어 fetch는 실제 서버로 넘긴다
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ArchitectureEdge,
  ArchitectureIr,
  ArchitectureNode,
} from '../../src/architecture/types.js';
import { liveOrigin, LIVE_TOKEN_META } from '../../src/architecture/live-port.js';
import type { LiveSessionBridge } from '../../src/architecture/live-session.js';
import { architectureInputSchema } from '../../src/mcp/schemas.js';
import {
  handleArchitecturePassthrough,
  stopArchitectureLiveServers,
} from '../../src/mcp/tools/architecture-passthrough.js';

let tmpRoot: string;
let repoRoot: string;
const session = { alive: true, sent: [] as string[] };

const bridge: LiveSessionBridge = {
  alive: () => session.alive,
  send: (text) => {
    session.sent.push(text);
    return Promise.resolve({ ok: true as const });
  },
};

beforeEach(() => {
  tmpRoot = resolve('.gestalt-test', `architecture-live-${randomUUID()}`);
  repoRoot = join(tmpRoot, 'acme-web');
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src/home.tsx'), 'a\nb\nc\nd\n');
  writeFileSync(join(repoRoot, 'src/orders.ts'), 'a\nb\nc\n');
  session.alive = true;
  session.sent = [];
});

const windows: Window[] = [];
afterEach(async () => {
  for (const w of windows.splice(0)) {
    await w.happyDOM.abort();
    await w.happyDOM.close();
  }
  await stopArchitectureLiveServers();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function node(id: string, kind: ArchitectureNode['kind'], label: string, line = 1) {
  return {
    id,
    kind,
    label,
    repo: 'web',
    evidence: [{ type: 'code', location: `web:src/home.tsx:${line}`, visibility: 'public' }],
  } satisfies ArchitectureNode;
}

function edge(id: string, from: string, to: string, kind: ArchitectureEdge['kind']) {
  return {
    id,
    from,
    to,
    kind,
    lineStyle: 'solid',
    evidence: [{ type: 'code', location: 'web:src/orders.ts:2', visibility: 'public' }],
  } satisfies ArchitectureEdge;
}

function makeIr(): ArchitectureIr {
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'web', name: 'acme-web', root: '.' }],
    nodes: [
      node('n-home', 'screen', 'Home'),
      node('n-orders-api', 'endpoint', 'GET /orders', 2),
      node('n-orders-module', 'app_module', 'OrdersModule', 3),
    ],
    edges: [
      edge('n-e1', 'n-home', 'n-orders-api', 'calls'),
      edge('n-e2', 'n-orders-api', 'n-orders-module', 'handles'),
    ],
    unresolved: [],
    sourcesUsed: [
      {
        via: 'repo',
        identifier: 'CLAUDE.md',
        readOnly: true,
        probeHit: true,
        visibility: 'public',
      },
    ],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function ges(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input = architectureInputSchema.parse({ repoRoot, ...args });
  return (await handleArchitecturePassthrough(input, process.cwd(), {
    homeDir: join(tmpRoot, 'home'),
    projectsRoot: join(tmpRoot, 'home', '.claude', 'projects'),
    resolveVisibility: () => ({ verdict: 'private', source: 'gh', visibility: 'PRIVATE' }),
    live: { port: 0, attempts: 1, deps: { session: bridge } },
  })) as Record<string, unknown>;
}

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function http(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  return new Promise((done, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: { host: `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        // 조각마다 디코딩하면 경계에 걸린 한글 바이트가 깨진다
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          done({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

const cspOf = (html: string) =>
  /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];
const inlineBodies = (html: string) =>
  [...html.matchAll(/<(script|style)>([\s\S]*?)<\/\1>/g)].map((m) => m[2]!);

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** 브라우저처럼 같은 출처 POST에 Origin을 붙여 실제 서버로 넘기는 fetch */
function realFetch(port: number) {
  return async (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) => {
    const method = init.method ?? 'GET';
    const res = await http(port, url, {
      method,
      headers: {
        ...(init.headers ?? {}),
        ...(method === 'POST' ? { origin: liveOrigin(port) } : {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      headers: {
        get: (k: string) => {
          const v = res.headers[k.toLowerCase()];
          return typeof v === 'string' ? v : null;
        },
      },
      json: () => Promise.resolve(JSON.parse(res.body) as unknown),
      text: () => Promise.resolve(res.body),
    };
  };
}

async function openViewer(port: number, liveUrl: string) {
  const page = await http(port, new URL(liveUrl).pathname);
  const w = new Window({
    url: liveUrl,
    width: 1400,
    height: 900,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  } as never);
  windows.push(w);
  const errs: string[] = [];
  w.addEventListener('error', (e) =>
    errs.push(String((e as unknown as { error?: unknown }).error)),
  );
  let reloads = 0;
  (w as unknown as { fetch: unknown }).fetch = realFetch(port);
  Object.defineProperty(w.location, 'reload', { value: () => (reloads += 1), configurable: true });
  w.document.write(page.body);
  await wait();
  const poke = async () => {
    w.document.dispatchEvent(new w.Event('visibilitychange'));
    await wait();
  };
  return { w, d: w.document, errs, poke, reloads: () => reloads };
}

async function renderAndServe() {
  const rendered = await ges({ action: 'render', ir: makeIr() });
  expect(rendered['ok']).toBe(true);
  const served = await ges({ action: 'serve', view: 'screen-chain' });
  expect(served['ok']).toBe(true);
  return {
    rendered,
    port: served['port'] as number,
    liveUrl: served['liveUrl'] as string,
  };
}

describe('라이브 Ask 통합', () => {
  it('서빙한 본인용 페이지에는 토큰과 그 서버 주소 connect-src가 있고 공유본은 내주지 않는다', async () => {
    const { rendered, port, liveUrl } = await renderAndServe();
    const page = await http(port, new URL(liveUrl).pathname);
    expect(page.status).toBe(200);
    expect(page.body).toMatch(new RegExp(`<meta name="${LIVE_TOKEN_META}" content="[^"]{20,}">`));
    expect(cspOf(page.body)).toContain(`connect-src ${liveOrigin(port)}`);
    // 디스크의 HTML에는 토큰이 없다
    expect(readFileSync(rendered['htmlPath'] as string, 'utf-8')).not.toContain(
      `<meta name="${LIVE_TOKEN_META}"`,
    );

    expect((await http(port, '/screen-chain.shared.html')).status).toBe(404);
    const shared = readFileSync(rendered['sharedHtmlPath'] as string, 'utf-8');
    expect(cspOf(shared)).toContain("connect-src 'none'");
    expect(shared).not.toContain('127.0.0.1');
  });

  it('세션이 꺼져 있으면 실제 서버 응답으로도 입력창이 DOM에 없다', async () => {
    session.alive = false;
    const { port, liveUrl } = await renderAndServe();
    const { d, errs } = await openViewer(port, liveUrl);
    expect(errs).toEqual([]);
    expect(d.getElementById('live-ask')).toBeNull();
  });

  it('질문이 서버를 거쳐 세션에 가고 IR 반영 재렌더가 새로고침 없이 열린 뷰어에 나타난다', async () => {
    const { port, liveUrl } = await renderAndServe();
    const { w, d, errs, poke, reloads } = await openViewer(port, liveUrl);
    expect(errs).toEqual([]);
    expect(d.getElementById('live-ask')).not.toBeNull();

    const question = '주문 목록은 캐시를 거치나요?';
    (d.getElementById('live-q') as unknown as { value: string }).value = question;
    d.getElementById('live-ask')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await wait(80);
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]).toContain('<architecture-question from="viewer" view="screen-chain"');
    expect(session.sent[0]).toContain(question);

    // 세션 몫: 근거를 찾아 IR에 노드와 답을 넣고 다시 render한다
    const pathname = new URL(liveUrl).pathname;
    const before = await http(port, pathname, { method: 'HEAD' });
    const oldPage = (await http(port, pathname)).body;
    const ir = makeIr();
    ir.nodes.push(node('n-order-cache', 'db_table', 'OrderCache', 4));
    ir.edges.push(edge('n-e3', 'n-orders-module', 'n-order-cache', 'reads_writes'));
    ir.unresolved.push({
      id: 'q-live-1',
      subject: { nodeId: 'n-orders-api' },
      question,
      answer: 'OrdersModule이 OrderCache를 먼저 읽는다',
    });
    const again = await ges({ action: 'render', ir });
    expect(again['ok'], JSON.stringify(again['errors'])).toBe(true);
    expect(again['liveUrl']).toBe(liveUrl);

    const after = await http(port, pathname, { method: 'HEAD' });
    expect(after.headers['etag']).not.toBe(before.headers['etag']);
    const newPage = (await http(port, pathname)).body;
    // 뷰어는 CSP가 같아야 body만 갈아 끼운다. 스크립트와 style 본문이 그대로라 CSP도 그대로다
    expect(cspOf(newPage)).toBe(cspOf(oldPage));
    expect(inlineBodies(newPage).filter((b) => !b.startsWith('{'))).toEqual(
      inlineBodies(oldPage).filter((b) => !b.startsWith('{')),
    );

    expect(d.body.textContent).not.toContain('OrderCache');
    await poke();
    await wait(80);
    expect(errs).toEqual([]);
    expect(reloads()).toBe(0);
    expect(d.body.textContent).toContain('OrderCache');
    expect(d.getElementById('live-ask')).not.toBeNull();
  });

  it('서버를 내리면 상태 요청이 실패하고 render는 liveUrl을 싣지 않는다', async () => {
    const { port } = await renderAndServe();
    await stopArchitectureLiveServers();
    await expect(http(port, '/__live/status')).rejects.toThrow();
    const result = await ges({ action: 'render', ir: makeIr() });
    expect(result).not.toHaveProperty('liveUrl');
  });
});
