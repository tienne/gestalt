// 라이브 갱신이 기대는 client 스크립트의 dispose와 state를 happy-dom에서 실제로 돌려 확인한다
import { afterAll, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import {
  computeDrilldown,
  renderDrilldownHtml,
  validateArchitectureIr,
  type ArchitectureEdge,
  type ArchitectureIr,
  type ArchitectureNode,
  type Evidence,
} from '../../../src/architecture/index.js';
import { CLIENT_HANDLE } from '../../../src/architecture/html-client.js';
import { executableScripts } from './csp-check.js';

const codeEv: Evidence = { type: 'code', location: 'web:src/a.ts:1', visibility: 'public' };

function ir(): ArchitectureIr {
  const n = (
    id: string,
    kind: ArchitectureNode['kind'],
    label = id,
    parent?: string,
  ): ArchitectureNode => ({
    id,
    kind,
    label,
    repo: 'web',
    evidence: [codeEv],
    ...(parent ? { parent } : {}),
  });
  const e = (
    id: string,
    from: string,
    to: string,
    kind: ArchitectureEdge['kind'],
  ): ArchitectureEdge => ({ id, from, to, kind, evidence: [codeEv], lineStyle: 'solid' });
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'web', name: 'acme-web', root: '/srv/acme-web' }],
    nodes: [
      n('shop', 'service'),
      n('list', 'screen', 'OrderList', 'shop'),
      n('ep', 'endpoint', 'GET /orders'),
      n('mod', 'app_module', 'order-handler'),
      n('tbl', 'db_table', 'orders'),
    ],
    edges: [
      e('c1', 'list', 'ep', 'calls'),
      e('h1', 'ep', 'mod', 'handles'),
      e('rw', 'mod', 'tbl', 'reads_writes'),
    ],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

interface ClientState {
  level: string;
  node: string | null;
  focus: string | null;
  search: string;
  searchFocused: boolean;
  drawer: boolean;
}
interface ClientHandle {
  dispose(): void;
  state(): ClientState;
  restore(s: ClientState): void;
}

const windows: Window[] = [];
afterAll(async () => {
  for (const w of windows) await w.happyDOM.close();
});

async function open() {
  const v = validateArchitectureIr(ir(), { checkFiles: false });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  const html = renderDrilldownHtml(v.value, await computeDrilldown(v.value), {
    audience: 'private',
  });
  const w = new Window({
    url: 'http://localhost/',
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
  w.document.write(html);
  await w.happyDOM.waitUntilComplete();
  const handle = () => (w as unknown as Record<string, ClientHandle | undefined>)[CLIENT_HANDLE];
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 20));
    await w.happyDOM.waitUntilComplete();
  };
  // body를 새로 만든 뒤 같은 client 본문을 다시 실행한다. 라이브 갱신이 하는 일과 같다
  const rerun = async () => {
    const client = executableScripts(html).find((b) => b.includes(CLIENT_HANDLE))!;
    const s = w.document.createElement('script');
    s.textContent = client;
    w.document.body.appendChild(s);
    await settle();
  };
  return { w, d: w.document, errs, handle, settle, rerun, html };
}

describe('client dispose와 state', () => {
  it('window에 등록한 이름으로 dispose와 state를 내놓는다', async () => {
    const { handle, errs } = await open();
    expect(errs).toEqual([]);
    expect(typeof handle()?.dispose).toBe('function');
    expect(typeof handle()?.restore).toBe('function');
    expect(handle()?.state()).toEqual({
      level: 'root',
      node: null,
      focus: null,
      search: '',
      searchFocused: false,
      drawer: false,
      view: expect.objectContaining({ k: expect.any(Number) }),
      overviewOpen: expect.any(Boolean),
      overviewTouched: false,
    });
  });

  it('state가 레벨 이동과 노드 선택을 따라간다', async () => {
    const { w, d, handle, settle } = await open();
    w.location.hash = '#/level/server:mod';
    await settle();
    expect(handle()?.state().level).toBe('server:mod');
    w.location.hash = '#/';
    await settle();
    expect(handle()?.state().level).toBe('root');
    const card = [...d.querySelectorAll('.level:not([hidden]) .node[data-node-id]')][0]!;
    const id = card.getAttribute('data-node-id');
    card.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await settle();
    expect(handle()?.state().node).toBe(id);
  });

  it('dispose 뒤에는 hashchange와 keydown 핸들러가 돌지 않는다', async () => {
    const { w, d, handle, settle } = await open();
    const h = handle()!;
    h.dispose();
    expect(handle()).toBeUndefined();
    w.location.hash = '#/level/server:mod';
    await settle();
    // 레벨 전환은 hashchange 핸들러가 하므로 dispose 뒤에는 그대로다
    expect(h.state().level).toBe('root');
    const drawer = d.getElementById('drawer')!;
    const before = drawer.className;
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(drawer.className).toBe(before);
  });

  it('같은 스크립트를 다시 실행하면 앞 실행의 window 리스너를 떼고 새로 하나씩만 붙인다', async () => {
    const { w, handle, rerun, settle, errs } = await open();
    const first = handle()!;
    const added: string[] = [];
    const removed: string[] = [];
    const win = w as unknown as {
      addEventListener: (t: string, ...rest: unknown[]) => void;
      removeEventListener: (t: string, ...rest: unknown[]) => void;
    };
    const add = win.addEventListener.bind(w);
    const remove = win.removeEventListener.bind(w);
    win.addEventListener = (t, ...rest) => {
      added.push(t);
      add(t, ...rest);
    };
    win.removeEventListener = (t, ...rest) => {
      removed.push(t);
      remove(t, ...rest);
    };
    await rerun();
    expect(errs).toEqual([]);
    const count = (xs: string[], t: string) => xs.filter((x) => x === t).length;
    expect(count(removed, 'hashchange')).toBe(1);
    expect(count(added, 'hashchange')).toBe(1);
    expect(count(removed, 'resize')).toBe(count(added, 'resize'));
    const second = handle()!;
    expect(second).not.toBe(first);
    w.location.hash = '#/level/server:mod';
    await settle();
    // 앞 실행은 다시 실행될 때 스스로 떨어져 레벨 전환을 따라가지 않는다
    expect(first.state().level).toBe('root');
    expect(second.state().level).toBe('server:mod');
  });

  it('restore가 새 실행에서 고른 카드와 검색어를 되살리고 리스너는 하나씩만 붙인다', async () => {
    const { w, d, handle, rerun, errs } = await open();
    const card = [...d.querySelectorAll('.level:not([hidden]) .node[data-node-id]')][0]!;
    const id = card.getAttribute('data-node-id');
    card.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const search = d.getElementById('search') as unknown as { value: string };
    search.value = 'order';
    const saved = handle()!.state();
    expect(saved).toMatchObject({ node: id, search: 'order', drawer: true });

    const added: string[] = [];
    const win = w as unknown as { addEventListener: (t: string, ...rest: unknown[]) => void };
    const add = win.addEventListener.bind(w);
    win.addEventListener = (t, ...rest) => {
      added.push(t);
      add(t, ...rest);
    };
    await rerun();
    const next = handle()!;
    next.restore(saved);
    expect(errs).toEqual([]);
    expect(next.state()).toMatchObject({ node: id, search: 'order', drawer: true });
    expect(d.getElementById('drawer')!.classList.contains('open')).toBe(true);
    expect(added.filter((t) => t === 'hashchange')).toHaveLength(1);
    // 새 그림에 없는 카드는 고르지 않는다
    next.restore({ ...saved, node: 'gone', search: '' });
    expect(next.state().node).toBe(id);
  });

  it('restore가 배율과 위치, 사람이 닫아 둔 개요를 fit 뒤에 되살린다', async () => {
    const { w, d, handle, rerun, errs } = await open();
    const overview = d.getElementById('overview') as unknown as { open: boolean } | null;
    expect(overview).not.toBeNull();
    expect(overview!.open).toBe(true);
    overview!.open = false;
    d.getElementById('overview')!.dispatchEvent(new w.Event('toggle'));
    const saved = {
      ...handle()!.state(),
      view: { x: 37, y: -12, k: 1.6 },
    };
    expect(saved).toMatchObject({ overviewOpen: false, overviewTouched: true });
    // 라이브 질문 단추가 개요 시트를 비켜 서는 기준 클래스
    expect(d.body.classList.contains('overview-open')).toBe(false);

    await rerun();
    const next = handle()!;
    // 새 클라이언트는 넓은 화면이라 개요를 다시 열고 fit으로 처음 배율에 맞춘다
    expect(overview!.open).toBe(true);
    expect(next.state()).toMatchObject({ overviewTouched: false });
    expect(d.body.classList.contains('overview-open')).toBe(true);
    next.restore(saved);
    expect(errs).toEqual([]);
    expect(next.state()).toMatchObject({
      view: { x: 37, y: -12, k: 1.6 },
      overviewOpen: false,
      overviewTouched: true,
    });
    expect(overview!.open).toBe(false);
    expect(d.body.classList.contains('overview-open')).toBe(false);
    const viewport = d.getElementById('viewport') as unknown as { style: { transform: string } };
    expect(viewport.style.transform).toBe('translate(37px,-12px) scale(1.6)');

    // 레벨이 바뀐 화면에는 앞 레벨 좌표를 걸지 않는다
    const before = next.state().view;
    next.restore({ ...saved, level: 'server:gone', view: { x: 1, y: 2, k: 0.5 } });
    expect(next.state().view).toEqual(before);
  });
});
