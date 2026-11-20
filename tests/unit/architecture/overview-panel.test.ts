// 클라이언트 스크립트를 happy-dom에서 실제로 돌려 개요 패널을 확인한다
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

function ir(extra: Partial<ArchitectureIr> = {}): ArchitectureIr {
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
    ...extra,
  };
}

const windows: Window[] = [];
afterAll(async () => {
  for (const w of windows) await w.happyDOM.close();
});

async function load(html: string, width = 1400): Promise<{ w: Window; errs: string[] }> {
  const w = new Window({
    url: 'http://localhost/',
    width,
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

async function open(extra: Partial<ArchitectureIr> = {}, width = 1400) {
  const v = validateArchitectureIr(ir(extra), { checkFiles: false });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  const { w, errs } = await load(
    renderDrilldownHtml(v.value, await computeDrilldown(v.value), { audience: 'private' }),
    width,
  );
  const d = w.document;
  const panel = d.getElementById('overview') as unknown as HTMLDetailsElement;
  const body = d.getElementById('overview-body')!;
  const text = (sel: string) => Array.from(body.querySelectorAll(sel)).map((x) => x.textContent);
  const stats = () => {
    const out: Record<string, string> = {};
    for (const dl of Array.from(body.querySelectorAll('.ov-stats'))) {
      const dts = Array.from(dl.querySelectorAll('dt'));
      const dds = Array.from(dl.querySelectorAll('dd'));
      dts.forEach((dt, i) => (out[dt.textContent!] = dds[i]!.textContent!));
    }
    return out;
  };
  // 드릴다운 요약은 개요 패널이 아니라 그림 위 단계 머리에 선다
  const sum = (): string[] => {
    const p = d.querySelector('#level-head .lh-sum') as unknown as HTMLElement | null;
    return p && !p.hidden ? [p.textContent ?? ''] : [];
  };
  const head = (sel: string): string => d.querySelector(`#level-head ${sel}`)?.textContent ?? '';
  const tiles = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const t of Array.from(body.querySelectorAll('.ov-tile')))
      out[t.querySelector('span')!.textContent!] = t.querySelector('b')!.textContent!;
    return out;
  };
  const go = async (hash: string) => {
    w.location.hash = hash;
    w.dispatchEvent(new w.HashChangeEvent('hashchange'));
    await w.happyDOM.waitUntilComplete();
  };
  return { w, d, errs, panel, body, text, stats, go, sum, head, tiles };
}

describe('개요 패널', () => {
  it('루트에서 요약과 일러두기, 종류별 카드 수, 열린 질문과 설명 없는 카드 수를 보인다', async () => {
    const { errs, panel, body, text, stats, sum } = await open({
      summary: '주문 화면에서 주문 테이블까지 잇는 그림',
      note: '결제 서버는 다루지 않는다',
      unresolved: [
        { id: 'q1', subject: { nodeId: 'mod' }, question: '주문 취소는 어디서 처리하나?' },
      ],
    });
    expect(errs).toEqual([]);
    expect(panel.open).toBe(true);
    expect(sum()).toEqual(['주문 화면에서 주문 테이블까지 잇는 그림']);
    // 머리에 선 요약은 개요에서 되풀이하지 않는다
    expect(text('.ov-sum')).toEqual([]);
    expect(text('.ov-note')).toEqual(['결제 서버는 다루지 않는다']);
    expect(text('.ov-h')).toEqual(expect.arrayContaining(['종류별 카드', '살펴볼 것']));
    const s = stats();
    expect(s['열린 질문']).toBe('1');
    expect(s['설명 없는 카드']).toBe('5');
    // 종류별 카드 표는 끝에서 두 번째다. 더하면 카드 수와 같다
    const kindDl = Array.from(body.querySelectorAll('.ov-stats')).at(-2)!;
    const kindSum = Array.from(kindDl.querySelectorAll('dd')).reduce(
      (a, x) => a + Number(x.textContent),
      0,
    );
    expect(kindSum).toBe(5);
  });

  it('summary와 note가 없는 IR이면 그 줄만 빠지고 숫자는 그대로 보인다', async () => {
    const { errs, body, text, stats, sum } = await open();
    expect(errs).toEqual([]);
    expect(sum()).toEqual([]);
    expect(body.querySelector('.ov-sum')).toBeNull();
    expect(body.querySelector('.ov-note')).toBeNull();
    expect(text('.ov-h')).toContain('살펴볼 것');
    expect(stats()['열린 질문']).toBe('0');
  });

  it('레인 제목의 개수를 레인별 카드로 옮긴다', async () => {
    const { d, stats, text } = await open();
    const lanes = Array.from(
      d.querySelectorAll('section.level:not([hidden]) .lane-title[data-lane-id]'),
    );
    expect(lanes.length).toBeGreaterThan(0);
    expect(text('.ov-h')).toContain('레인별 카드');
    const s = stats();
    for (const t of lanes)
      expect(s[t.firstChild!.textContent!]).toBe(t.querySelector('.n')!.textContent);
  });

  it('안쪽 레벨은 그 레벨을 연 카드의 요약이나 설명을 보이고 루트 숫자는 뺀다', async () => {
    const withSummary = await open({
      nodes: ir().nodes.map((n) =>
        n.id === 'mod' ? { ...n, summary: '주문을 읽고 쓰는 모듈' } : n,
      ),
    });
    await withSummary.go('#/level/server%3Amod');
    expect(withSummary.errs).toEqual([]);
    expect(withSummary.sum()).toEqual(['주문을 읽고 쓰는 모듈']);
    expect(withSummary.text('.ov-h')).not.toContain('살펴볼 것');

    const withDesc = await open({
      nodes: ir().nodes.map((n) => (n.id === 'mod' ? { ...n, description: '주문 핸들러' } : n)),
    });
    await withDesc.go('#/level/server%3Amod');
    expect(withDesc.sum()).toEqual(['주문 핸들러']);

    const bare = await open();
    await bare.go('#/level/server%3Amod');
    expect(bare.errs).toEqual([]);
    expect(bare.sum()).toEqual([]);
  });

  it('루트로 돌아오면 루트 내용으로 다시 채운다', async () => {
    const { go, sum } = await open({ summary: '전체 요약' });
    await go('#/level/server%3Amod');
    expect(sum()).toEqual([]);
    await go('#/');
    expect(sum()).toEqual(['전체 요약']);
  });

  it('390px 폭에서는 접힌 채로 시작해 카드를 가리지 않는다', async () => {
    const { panel, errs } = await open({ summary: '전체 요약' }, 390);
    expect(errs).toEqual([]);
    expect(panel.open).toBe(false);
  });

  it('글자는 textContent로만 넣는다', async () => {
    const { d, sum } = await open({ summary: '<img src=x onerror=alert(1)>' });
    expect(sum()).toEqual(['<img src=x onerror=alert(1)>']);
    expect(d.querySelector('#level-head img')).toBeNull();
  });

  it('평면 그림에도 패널이 있고 에러 없이 숫자를 채운다', async () => {
    const v = validateArchitectureIr(ir(), { checkFiles: false });
    if (!v.ok) throw new Error(JSON.stringify(v.errors));
    const { computeLayout } = await import('../../../src/architecture/layout.js');
    const layout = await computeLayout(
      v.value.ir,
      v.value.drawableNodeIds,
      v.value.drawableEdgeIds,
    );
    const { w, errs } = await load(
      renderArchitectureHtml(v.value, layout, { audience: 'private' }),
    );
    expect(errs).toEqual([]);
    expect(w.document.querySelector('#overview-body .ov-stats')).not.toBeNull();
  });
});

describe('단계 머리와 접힌 root', () => {
  // 서비스 둘과 게이트웨이, 저장소에 모듈과 엔드포인트가 12쌍 붙는다. root 카드가 문턱을 넘어 레인 덩어리로 접힌다
  function wide(): ArchitectureIr {
    const base = ir();
    const ids = Array.from({ length: 12 }, (_, i) => `m-${String(i).padStart(2, '0')}`);
    const n = (id: string, kind: ArchitectureNode['kind'], parent?: string): ArchitectureNode => ({
      id,
      kind,
      label: id,
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
      ...base,
      nodes: [
        n('svc-a', 'service'),
        n('svc-b', 'service'),
        n('s-a', 'screen', 'svc-a'),
        n('s-b', 'screen', 'svc-b'),
        n('gw', 'gateway'),
        n('db', 'datastore'),
        ...ids.flatMap((m) => [n(`ep-${m}`, 'endpoint'), n(m, 'app_module')]),
      ],
      edges: ids.flatMap((m, i) => [
        e(`c-${m}`, i % 2 === 0 ? 's-a' : 's-b', `ep-${m}`, 'calls'),
        e(`r-${m}`, 'gw', `ep-${m}`, 'routes'),
        e(`h-${m}`, `ep-${m}`, m, 'handles'),
        e(`rw-${m}`, m, 'db', 'reads_writes'),
      ]),
    };
  }

  async function openWide() {
    const v = validateArchitectureIr(wide(), { checkFiles: false });
    if (!v.ok) throw new Error(JSON.stringify(v.errors));
    const { w, errs } = await load(
      renderDrilldownHtml(v.value, await computeDrilldown(v.value), { audience: 'private' }),
    );
    const d = w.document;
    const body = d.getElementById('overview-body')!;
    const settle = () => w.happyDOM.waitUntilComplete();
    const head = (sel: string): string => d.querySelector(`#level-head ${sel}`)?.textContent ?? '';
    const tiles = (): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const t of Array.from(body.querySelectorAll('.ov-tile')))
        out[t.querySelector('span')!.textContent!] = t.querySelector('b')!.textContent!;
      return out;
    };
    const visible = () => d.querySelector('section.level:not([hidden])')!;
    return { w, d, errs, body, settle, head, tiles, visible };
  }

  it('단계 머리에 종류와 제목을 채우고 안쪽 단계로 가면 바꾼다', async () => {
    const { d, errs, go, head } = await open({ summary: '전체 요약' });
    expect(errs).toEqual([]);
    expect(head('.lh-kind')).toBe('전체 그림');
    expect(head('.lh-title')).toBe(d.querySelector('.bar h1')!.textContent);
    await go('#/level/server%3Amod');
    expect(head('.lh-kind')).toBe('서버 모듈');
    expect(head('.lh-title')).toBe('order-handler');
  });

  it('개요 숫자 타일에 항목, 연결, 엔드포인트 수를 싣는다', async () => {
    const { d, tiles } = await open();
    const t = tiles();
    expect(Object.keys(t)).toEqual(['항목', '연결', '엔드포인트']);
    const cards = d.querySelectorAll('section[data-level-id="root"] .node[data-node-id]').length;
    expect(Number(t['항목'])).toBe(cards);
    expect(Number(t['연결'])).toBeGreaterThan(0);
  });

  it('접힌 root는 덩어리 카드를 그리고 개요에 레인 목록을 싣는다. 누르면 레인 단계로 간다', async () => {
    const { w, d, errs, body, settle, head, tiles, visible } = await openWide();
    expect(errs).toEqual([]);
    const chunks = Array.from(d.querySelectorAll('section[data-level-id="root"] a.chunk'));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const links = Array.from(body.querySelectorAll('.ov-lanes a'));
    expect(links.length).toBe(chunks.length);
    // 덩어리 항목 수를 더하면 root 카드 수(접기 전)와 같다
    const total = links.reduce((a, x) => a + Number(x.querySelector('b')!.textContent), 0);
    expect(Number(tiles()['항목'])).toBe(total);
    expect(tiles()['엔드포인트']).toBe('12');
    const target = chunks[0]!.getAttribute('data-level')!;
    (chunks[0] as unknown as HTMLElement).click();
    await settle();
    expect(decodeURIComponent(w.location.hash)).toBe(`#/level/${target}`);
    expect(visible().getAttribute('data-level-id')).toBe(target);
    expect(head('.lh-kind')).toBe('레인');
    expect(head('.lh-sum')).not.toBe('');
  });

  it('바깥 알약을 누르면 그 카드가 안에 선 단계로 가서 고른다', async () => {
    const { w, d, errs, settle, visible } = await openWide();
    const chunk = d.querySelector(
      'section[data-level-id="root"] a.chunk',
    ) as unknown as HTMLElement;
    chunk.click();
    await settle();
    const pill = visible().querySelector('.node.out-pill') as unknown as HTMLElement | null;
    expect(pill).not.toBeNull();
    const id = pill!.getAttribute('data-node-id')!;
    const from = visible().getAttribute('data-level-id');
    pill!.click();
    await settle();
    expect(errs).toEqual([]);
    const now = visible().getAttribute('data-level-id');
    expect(now).not.toBe(from);
    expect(w.location.hash).toContain('#/level/');
    expect(
      visible().querySelector(`.node[data-node-id="${id}"]`)!.classList.contains('selected'),
    ).toBe(true);
  });

  it('덩어리 사이 묶음 선을 누르면 덩어리 이름으로 묶음 화면을 연다', async () => {
    const { w, d, errs, settle } = await openWide();
    const link = d.querySelector(
      'section[data-level-id="root"] .link.bundle',
    ) as unknown as HTMLElement;
    expect(link).not.toBeNull();
    link.dispatchEvent(new w.MouseEvent('click', { bubbles: true }) as never);
    await settle();
    expect(errs).toEqual([]);
    expect(decodeURIComponent(w.location.hash)).toMatch(/^#\/bundle\/root\/chunk:/);
    const here = d.querySelector('#crumbs .here')!.textContent!;
    expect(here).toContain(' → ');
    expect(here).not.toContain('chunk:');
  });
});
