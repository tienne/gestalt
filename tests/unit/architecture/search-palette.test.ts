// 클라이언트 스크립트를 happy-dom에서 실제로 돌려 전체 검색 목록을 확인한다
import { afterAll, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import {
  computeDrilldown,
  renderArchitectureHtml,
  renderDrilldownHtml,
  validateArchitectureIr,
  type ArchitectureEdge,
  type ArchitectureIr,
  type ArchitectureNode,
  type Evidence,
} from '../../../src/architecture/index.js';

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
  ): ArchitectureEdge => ({
    id,
    from,
    to,
    kind,
    evidence: [codeEv],
    lineStyle: 'solid',
  });
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

const windows: Window[] = [];
afterAll(async () => {
  for (const w of windows) await w.happyDOM.close();
});

async function load(html: string): Promise<{ w: Window; errs: string[] }> {
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
  return { w, errs };
}

async function openDrill() {
  const v = validateArchitectureIr(ir(), { checkFiles: false });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  const { w, errs } = await load(
    renderDrilldownHtml(v.value, await computeDrilldown(v.value), { audience: 'private' }),
  );
  const d = w.document;
  const search = d.getElementById('search') as unknown as HTMLInputElement;
  const list = d.getElementById('search-list')!;
  const type = (q: string) => {
    search.focus();
    search.value = q;
    search.dispatchEvent(new w.Event('input'));
  };
  const key = (k: string, init: Record<string, unknown> = {}, target: EventTarget = search) =>
    target.dispatchEvent(
      new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
    );
  const items = () =>
    [...list.querySelectorAll('li')].map((li) => [
      li.querySelector('.nm')?.textContent,
      li.querySelector('.lv')?.textContent,
    ]);
  const shown = () =>
    [...d.querySelectorAll('.level[data-level-id]')]
      .filter((s) => !(s as unknown as HTMLElement).hidden)
      .map((s) => s.getAttribute('data-level-id'));
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 20));
    await w.happyDOM.waitUntilComplete();
  };
  return { w, d, errs, search, list, type, key, items, shown, settle };
}

describe('전체 검색 목록', () => {
  it('드릴다운 검색창은 combobox이고 목록(listbox)을 가리킨다', async () => {
    const { search, list, errs } = await openDrill();
    expect(errs).toEqual([]);
    expect(search.getAttribute('role')).toBe('combobox');
    expect(search.getAttribute('aria-controls')).toBe('search-list');
    expect(search.getAttribute('aria-expanded')).toBe('false');
    expect(list.getAttribute('role')).toBe('listbox');
    expect(list.hidden).toBe(true);
  });

  it('루트에서 찾으면 지금 레벨 카드를 먼저 두고 다른 레벨 카드는 그 레벨 제목과 함께 띄운다', async () => {
    const { type, items, list, search } = await openDrill();
    type('order');
    expect(list.hidden).toBe(false);
    expect(search.getAttribute('aria-expanded')).toBe('true');
    // 다른 레벨 카드는 이름순이고 대소문자를 가리지 않는다
    expect(items()).toEqual([
      ['order-handler', '이 화면'],
      ['GET /orders', 'order-handler'],
      ['OrderList', 'shop'],
      ['orders', 'order-handler'],
    ]);
  });

  it('화살표로 고르고 Enter를 누르면 그 레벨로 들어가 카드를 고른다', async () => {
    const { w, d, type, key, search, list, items, shown, settle } = await openDrill();
    type('orders');
    expect(shown()).toEqual(['root']);
    expect(items().map((i) => i[0])).toEqual(['GET /orders', 'orders']);
    // 위로 가면 맨 끝으로 돈다
    key('ArrowUp');
    const last = list.querySelectorAll('li')[1]!;
    expect(last.getAttribute('aria-selected')).toBe('true');
    expect(search.getAttribute('aria-activedescendant')).toBe(last.id);
    expect(list.querySelector('li')!.getAttribute('aria-selected')).toBe('false');
    key('Enter');
    await settle();
    expect(decodeURIComponent(w.location.hash)).toBe('#/level/server:mod');
    expect(shown()).toEqual(['server:mod']);
    expect(
      d.querySelector('[data-level-id="server:mod"] .node.selected')?.getAttribute('data-node-id'),
    ).toBe('tbl');
    expect(list.hidden).toBe(true);
    expect(search.value).toBe('');
  });

  it('지금 레벨의 카드를 고르면 레벨은 그대로 두고 카드를 고른다', async () => {
    const { w, d, type, key, shown, settle } = await openDrill();
    type('order-handler');
    key('ArrowDown');
    key('Enter');
    await settle();
    expect(w.location.hash).toBe('');
    expect(shown()).toEqual(['root']);
    expect(
      d.querySelector('[data-level-id="root"] .node.selected')?.getAttribute('data-node-id'),
    ).toBe('mod');
  });

  it('Esc는 목록만 닫고 한 번 더 누르면 검색어를 지운다', async () => {
    const { type, key, list, search } = await openDrill();
    type('order');
    key('Escape');
    expect(list.hidden).toBe(true);
    expect(search.getAttribute('aria-expanded')).toBe('false');
    expect(search.value).toBe('order');
    key('Escape');
    expect(search.value).toBe('');
  });

  it('못 찾으면 고를 수 없는 안내 한 줄만 띄운다', async () => {
    const { type, list } = await openDrill();
    type('zzz');
    const li = list.querySelectorAll('li');
    expect(li).toHaveLength(1);
    expect(li[0]!.getAttribute('aria-disabled')).toBe('true');
  });

  it('⌘K와 Ctrl+K는 어디서든 검색창으로 가고 / 와 0 키 뜻은 그대로다', async () => {
    const { w, d, search, key } = await openDrill();
    (d.activeElement as unknown as HTMLElement | null)?.blur();
    expect(key('k', { metaKey: true }, d.body)).toBe(false);
    expect(d.activeElement).toBe(search);
    search.blur();
    expect(key('K', { ctrlKey: true }, d.body)).toBe(false);
    expect(d.activeElement).toBe(search);
    search.blur();
    key('/', {}, d.body);
    expect(d.activeElement).toBe(search);
    search.blur();
    // 0은 화면 맞춤이라 검색창으로 가지 않는다
    key('0', {}, d.body);
    expect(d.activeElement).not.toBe(search);
    expect(w.document.getElementById('search-list')!.hidden).toBe(true);
  });
});

describe('평면 그림의 검색', () => {
  it('레벨이 없는 그림에는 목록도 combobox 역할도 붙이지 않는다', async () => {
    const v = validateArchitectureIr(ir(), { checkFiles: false });
    if (!v.ok) throw new Error(JSON.stringify(v.errors));
    const { computeLayout } = await import('../../../src/architecture/layout.js');
    const layout = await computeLayout(
      v.value.ir,
      v.value.drawableNodeIds,
      v.value.drawableEdgeIds,
    );
    const html = renderArchitectureHtml(v.value, layout, { audience: 'private' });
    expect(html).not.toContain('id="search-list"');
    expect(html).not.toContain('role="combobox"');
    const { w, errs } = await load(html);
    expect(errs).toEqual([]);
    const search = w.document.getElementById('search') as unknown as HTMLInputElement;
    search.value = 'order';
    search.dispatchEvent(new w.Event('input'));
    expect(w.document.getElementById('search-count')!.textContent).not.toBe('');
  });
});
