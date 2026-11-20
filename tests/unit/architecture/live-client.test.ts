// 라이브 스크립트를 happy-dom에서 실제로 돌려 입력창 숨김과 질문 전송, 새로고침 없는 갱신을 확인한다
import { afterEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import {
  computeDrilldown,
  renderDrilldownHtml,
  validateArchitectureIr,
  type ArchitectureIr,
} from '../../../src/architecture/index.js';
import { CLIENT_HANDLE } from '../../../src/architecture/html-client.js';
import { LIVE_HANDLE, renderLiveScript } from '../../../src/architecture/live-client.js';
import {
  LIVE_ASK_PATH,
  LIVE_STATUS_PATH,
  LIVE_TOKEN_HEADER,
  LIVE_TOKEN_META,
} from '../../../src/architecture/live-port.js';
import { sampleIr } from './live-fixture.js';

const TOKEN = ['tok', 'en', '-for-', 'test'].join('');
const ORIGIN = 'http://127.0.0.1:7894';

async function htmlOf(ir: ArchitectureIr, opts: { token?: boolean } = {}) {
  const v = validateArchitectureIr(ir, { checkFiles: false });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  let html = renderDrilldownHtml(v.value, await computeDrilldown(v.value), { audience: 'private' });
  // 렌더러는 본인용에 라이브 스크립트를 싣는다. 토큰 meta는 라이브 서버가 내줄 때 끼우는 몫이라 여기서 흉내 낸다
  expect(html).toContain(LIVE_HANDLE);
  if (opts.token !== false) {
    html = html.replace('</head>', `<meta name="${LIVE_TOKEN_META}" content="${TOKEN}">\n</head>`);
  }
  return html;
}

interface Req {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function server(initial: string) {
  const state = { session: true, page: initial, tag: '"1-1"', askCode: 'sent', reqs: [] as Req[] };
  const fetch = async (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) => {
    const req: Req = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body,
    };
    state.reqs.push(req);
    const res = (status: number, body: string, etag?: string) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => (k.toLowerCase() === 'etag' ? (etag ?? null) : null) },
      json: async () => JSON.parse(body) as unknown,
      text: async () => body,
    });
    if (url === LIVE_STATUS_PATH) {
      if (req.headers[LIVE_TOKEN_HEADER] !== TOKEN) return res(403, '403');
      return res(200, JSON.stringify({ session: state.session }));
    }
    if (url === LIVE_ASK_PATH)
      return res(state.askCode === 'sent' ? 200 : 503, JSON.stringify({ code: state.askCode }));
    if (url === '/screen-chain.html')
      return res(200, req.method === 'HEAD' ? '' : state.page, state.tag);
    return res(404, '404');
  };
  return { state, fetch };
}

const windows: Window[] = [];
afterEach(async () => {
  for (const w of windows.splice(0)) {
    await w.happyDOM.abort();
    await w.happyDOM.close();
  }
});

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function open(html: string, srv = server(html)) {
  const w = new Window({
    url: `${ORIGIN}/screen-chain.html`,
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
  (w as unknown as { fetch: unknown }).fetch = srv.fetch;
  Object.defineProperty(w.location, 'reload', { value: () => (reloads += 1), configurable: true });
  w.document.write(html);
  await wait();
  const d = w.document;
  // 보이는 상태로 돌아왔다는 이벤트가 다음 감시를 바로 당긴다
  const poke = async () => {
    d.dispatchEvent(new w.Event('visibilitychange'));
    await wait();
  };
  const handle = () =>
    (
      w as unknown as Record<
        string,
        { state(): { level: string; node: string | null } } | undefined
      >
    )[CLIENT_HANDLE];
  return { w, d, srv, errs, poke, handle, reloads: () => reloads };
}

describe('라이브 스크립트', () => {
  it('토큰 meta가 없으면(file:// 또는 공유본) 아무 요청도 하지 않고 입력창도 없다', async () => {
    const html = await htmlOf(sampleIr(), { token: false });
    const { d, srv, errs } = await open(html);
    expect(errs).toEqual([]);
    expect(srv.state.reqs).toEqual([]);
    expect(d.getElementById('live-ask')).toBeNull();
  });

  it('세션이 꺼져 있으면 입력창이 DOM에 없고 켜지면 생겼다가 다시 꺼지면 사라진다', async () => {
    const html = await htmlOf(sampleIr());
    const srv = server(html);
    srv.state.session = false;
    const { d, poke, errs } = await open(html, srv);
    expect(errs).toEqual([]);
    expect(srv.state.reqs[0]).toMatchObject({
      url: LIVE_STATUS_PATH,
      headers: { [LIVE_TOKEN_HEADER]: TOKEN },
    });
    expect(d.getElementById('live-ask')).toBeNull();
    expect(d.querySelector('textarea')).toBeNull();
    srv.state.session = true;
    await poke();
    expect(d.getElementById('live-ask')).not.toBeNull();
    expect(d.getElementById('live-q')).not.toBeNull();
    srv.state.session = false;
    await poke();
    expect(d.getElementById('live-ask')).toBeNull();
    expect(d.getElementById('live-ask-toggle')).toBeNull();
  });

  it('폼은 접힌 단추로 시작하고 단추로 펼친 뒤 Escape로 접힌다', async () => {
    const html = await htmlOf(sampleIr());
    const { w, d, errs } = await open(html);
    expect(errs).toEqual([]);
    const toggle = d.getElementById('live-ask-toggle')!;
    const form = d.getElementById('live-ask') as unknown as { hidden: boolean };
    expect(toggle.getAttribute('aria-controls')).toBe('live-ask');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(form.hidden).toBe(true);
    toggle.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(form.hidden).toBe(false);
    expect(d.activeElement?.id).toBe('live-q');
    // 카드를 골라 서랍이 열려도 폼은 그대로 둔다. 고른 카드를 두고 묻는 게 기본 흐름이다
    const card = [...d.querySelectorAll('.level:not([hidden]) .node[data-node-id]')][0]!;
    card.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait();
    expect(form.hidden).toBe(false);
    const drawer = d.getElementById('drawer')!;
    expect(drawer.classList.contains('open')).toBe(true);
    // 접기는 입력창이 받고 그림의 Escape(서랍 닫기)로 새지 않는다
    d.getElementById('live-q')!.dispatchEvent(
      new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(form.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(d.activeElement).toBe(toggle);
    expect(drawer.classList.contains('open')).toBe(true);
  });

  it('질문과 함께 보고 있는 레벨과 고른 카드를 보낸다', async () => {
    const html = await htmlOf(sampleIr());
    const { w, d, srv, handle } = await open(html);
    const card = [...d.querySelectorAll('.level:not([hidden]) .node[data-node-id]')][0]!;
    card.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait();
    const node = handle()!.state().node;
    expect(node).toBeTruthy();
    const input = d.getElementById('live-q') as unknown as { value: string };
    input.value = '  이 화면은 어떤 API를 부르나요?  ';
    d.getElementById('live-ask')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await wait();
    const sent = srv.state.reqs.find((r) => r.url === LIVE_ASK_PATH)!;
    expect(sent.method).toBe('POST');
    expect(sent.headers).toMatchObject({
      [LIVE_TOKEN_HEADER]: TOKEN,
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(sent.body!)).toEqual({
      view: 'screen-chain',
      question: '이 화면은 어떤 API를 부르나요?',
      level: 'root',
      node,
    });
    expect(input.value).toBe('');
    expect(d.querySelector('.live-msg')!.textContent).toContain('세션에 보냈어요');
  });

  it('입력창에서 친 글자가 그림 단축키로 새지 않는다', async () => {
    const html = await htmlOf(sampleIr());
    const { w, d } = await open(html);
    const seen: string[] = [];
    d.addEventListener('keydown', (e) => seen.push((e as unknown as { key: string }).key));
    d.getElementById('live-q')!.dispatchEvent(
      new w.KeyboardEvent('keydown', { key: '/', bubbles: true }),
    );
    expect(seen).toEqual([]);
  });

  it('세션이 사라졌다고 답하면 입력창을 걷는다', async () => {
    const html = await htmlOf(sampleIr());
    const srv = server(html);
    srv.state.askCode = 'no_session';
    const { w, d } = await open(html, srv);
    (d.getElementById('live-q') as unknown as { value: string }).value = '질문';
    d.getElementById('live-ask')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await wait();
    expect(d.getElementById('live-ask')).toBeNull();
  });

  it('다시 렌더되면 새로고침 없이 body를 갈아 끼우고 client를 다시 돌린다', async () => {
    const before = await htmlOf(sampleIr());
    const next = sampleIr();
    next.nodes.push({
      id: 'cache',
      kind: 'db_table',
      label: 'order_cache',
      repo: 'web',
      evidence: [{ type: 'code', location: 'web:src/cache.ts:3', visibility: 'public' }],
    });
    next.edges.push({
      id: 'rw2',
      from: 'mod',
      to: 'cache',
      kind: 'reads_writes',
      evidence: [{ type: 'code', location: 'web:src/cache.ts:3', visibility: 'public' }],
      lineStyle: 'solid',
    });
    next.unresolved.push({
      id: 'q1',
      subject: { nodeId: 'cache' },
      question: '캐시는 언제 비우나요?',
      answer: '주문이 바뀌면 비운다',
    });
    const after = await htmlOf(next);
    const { w, d, srv, poke, handle, reloads, errs } = await open(before);
    const first = handle();
    d.getElementById('live-ask-toggle')!.dispatchEvent(
      new w.MouseEvent('click', { bubbles: true }),
    );
    const card = [...d.querySelectorAll('.level:not([hidden]) .node[data-node-id]')][0]!;
    const picked = card.getAttribute('data-node-id');
    card.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    (d.getElementById('search') as unknown as { value: string }).value = 'order';
    const marker = d.createElement('i');
    marker.id = 'old-body-marker';
    d.body.appendChild(marker);
    (d.getElementById('live-q') as unknown as { value: string }).value = '쓰던 글';
    expect(d.body.textContent).not.toContain('order_cache');

    srv.state.page = after;
    srv.state.tag = '"2-2"';
    await poke();
    expect(reloads()).toBe(0);
    expect(errs).toEqual([]);
    expect(d.getElementById('old-body-marker')).toBeNull();
    expect(d.body.textContent).toContain('order_cache');
    expect(handle()).toBeDefined();
    expect(handle()).not.toBe(first);
    // 입력창은 그대로 옮겨 붙어서 쓰던 글이 남는다
    expect((d.getElementById('live-q') as unknown as { value: string }).value).toBe('쓰던 글');
    expect(d.querySelectorAll('#live-ask')).toHaveLength(1);
    expect(d.querySelectorAll('#live-ask-toggle')).toHaveLength(1);
    expect(d.getElementById('live-ask-toggle')!.getAttribute('aria-expanded')).toBe('true');
    expect((d.getElementById('live-ask') as unknown as { hidden: boolean }).hidden).toBe(false);
    // 고른 카드와 검색어는 새 그림에서도 이어 간다
    expect(handle()!.state().node).toBe(picked);
    expect(d.getElementById('drawer')!.classList.contains('open')).toBe(true);
    expect((d.getElementById('search') as unknown as { value: string }).value).toBe('order');
    expect(d.querySelector('.live-msg')!.textContent).toContain('다시 렌더된 그림');
    // 같은 ETag면 다시 받지 않는다
    const gets = srv.state.reqs.filter(
      (r) => r.url === '/screen-chain.html' && r.method === 'GET',
    ).length;
    await poke();
    expect(
      srv.state.reqs.filter((r) => r.url === '/screen-chain.html' && r.method === 'GET'),
    ).toHaveLength(gets);
  });

  it('새 페이지의 CSP가 다르면 끼우지 않고 새로 읽는다', async () => {
    const before = await htmlOf(sampleIr());
    const { srv, poke, reloads } = await open(before);
    srv.state.page = before.replace("default-src 'none'", "default-src 'none'; img-src data:");
    srv.state.tag = '"3-3"';
    await poke();
    expect(reloads()).toBe(1);
  });

  it('렌더 도중 잘린 페이지는 끼우지 않고 다음 차례를 기다린다', async () => {
    const before = await htmlOf(sampleIr());
    const { d, srv, poke, reloads } = await open(before);
    srv.state.page = before.slice(0, Math.floor(before.length / 2));
    srv.state.tag = '"4-4"';
    await poke();
    expect(reloads()).toBe(0);
    expect(d.getElementById('live-ask')).not.toBeNull();
  });

  it('같은 입력이면 같은 스크립트 글자를 낸다', () => {
    expect(renderLiveScript()).toBe(renderLiveScript());
    expect(renderLiveScript()).not.toContain('</script');
  });
});
