import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  computeDrilldown,
  parseArchitectureIr,
  renderDrilldownHtml,
  validateArchitectureIr,
  type ArchitectureEdge,
  type ArchitectureIr,
  type ArchitectureNode,
  type DrillLevel,
  type ValidatedIr,
} from '../../../src/architecture/index.js';
import { stackGroups, groupRects, type LayoutResult } from '../../../src/architecture/layout.js';

// 웹 서비스 하나가 게이트웨이 둘을 거쳐 서버 모듈들을 부른다. 서버는 레포 이름으로 묶는다. 이름은 전부 가짜다
const ev = [{ type: 'code' as const, location: 'web:src/api.ts:1', visibility: 'public' as const }];

function node(
  id: string,
  kind: ArchitectureNode['kind'],
  extra: Partial<ArchitectureNode> = {},
): ArchitectureNode {
  return { id, kind, label: id, repo: 'web', evidence: ev, ...extra };
}

function edge(
  id: string,
  from: string,
  to: string,
  kind: ArchitectureEdge['kind'],
): ArchitectureEdge {
  return { id, from, to, kind, evidence: ev, lineStyle: 'solid' };
}

// [모듈 id, 묶음, 거치는 게이트웨이]
const MODULES: Array<[string, string | undefined, string]> = [
  ['m-a1', 'repo-a', 'gw-a'],
  ['m-a2', 'repo-a', 'gw-a'],
  ['m-a3', 'repo-a', 'gw-a'],
  ['m-b1', 'repo-b', 'gw-b'],
  ['m-b2', 'repo-b', 'gw-b'],
  ['m-c', undefined, 'gw-a'],
  ['m-solo', 'repo-solo', 'gw-b'],
];

function fixture(opts: { groups?: boolean; console?: boolean } = {}): ArchitectureIr {
  const withGroups = opts.groups ?? true;
  const g = (label: string | undefined): Partial<ArchitectureNode> =>
    withGroups && label !== undefined ? { group: label } : {};
  const consoleNodes = opts.console
    ? [
        node('svc-console', 'service', { repo: 'console' }),
        node('app-shell', 'micro_app', { repo: 'console', parent: 'svc-console' }),
        // 앱 테두리에 든 카드는 묶음 값이 있어도 묶음 테두리에서 빠진다
        node('app-coupon', 'micro_app', { repo: 'console', parent: 'svc-console', ...g('repo-a') }),
      ]
    : [];
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [
      { id: 'web', name: 'acme-web', root: '/srv/acme-web' },
      ...(opts.console ? [{ id: 'console', name: 'acme-console', root: '/srv/acme-console' }] : []),
    ],
    nodes: [
      node('svc-web', 'service'),
      node('f-web', 'feature', { parent: 'svc-web' }),
      node('s-web', 'screen', { parent: 'f-web' }),
      node('gw-a', 'gateway', g('repo-a')),
      node('gw-b', 'gateway', g('repo-b')),
      ...MODULES.flatMap(([m, label]) => [
        node(`ep-${m}`, 'endpoint'),
        node(m, 'app_module', g(label)),
      ]),
      ...consoleNodes,
    ],
    edges: [
      ...MODULES.flatMap(([m, , gw]) => [
        edge(`c-${m}`, 's-web', `ep-${m}`, 'calls'),
        edge(`r-${m}`, gw, `ep-${m}`, 'routes'),
        edge(`h-${m}`, `ep-${m}`, m, 'handles'),
      ]),
      ...(opts.console ? [edge('ld-coupon', 'app-shell', 'app-coupon', 'loads')] : []),
    ],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function validated(ir: ArchitectureIr): ValidatedIr {
  const result = validateArchitectureIr(ir, { checkFiles: false });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

async function rootOf(ir: ArchitectureIr): Promise<DrillLevel> {
  const d = await computeDrilldown(validated(ir));
  return d.levels.find((l) => l.id === 'root')!;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const contains = (outer: Box, inner: Box): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

const groupFrames = (l: DrillLevel) => (l.layout.frames ?? []).filter((f) => f.label !== undefined);

/** 같은 열에서 위에서부터 셌을 때 멤버 자리가 끊기지 않는지 본다 */
function contiguousInColumns(layout: LayoutResult, members: readonly string[]): boolean {
  const set = new Set(members);
  const xs = new Set(layout.nodes.filter((n) => set.has(n.id)).map((n) => n.x));
  for (const x of xs) {
    const col = layout.nodes.filter((n) => n.x === x).sort((a, b) => a.y - b.y);
    const idx = col.flatMap((n, i) => (set.has(n.id) ? [i] : []));
    if (idx[idx.length - 1]! - idx[0]! !== idx.length - 1) return false;
  }
  return true;
}

describe('묶음 테두리 — 전체 보기', () => {
  it('group이 없으면 테두리가 없다', async () => {
    const plain = await rootOf(fixture({ groups: false }));
    expect(plain.layout.frames).toBeUndefined();
  });

  it('서버 셋 이상인 묶음에 라벨 단 테두리를 두르고 묶음 카드는 열 안에서 이어진다', async () => {
    const root = await rootOf(fixture());
    const frames = groupFrames(root);
    const aFrames = frames.filter((f) => f.label === 'repo-a');
    expect(aFrames.length).toBeGreaterThan(0);

    const box = (id: string) => root.layout.nodes.find((n) => n.id === id)!;
    const aModules = ['m-a1', 'm-a2', 'm-a3'];
    const aModuleFrame = aFrames.find((f) => contains(f, box('m-a1')))!;
    for (const id of aModules) expect(contains(aModuleFrame, box(id))).toBe(true);
    expect(contiguousInColumns(root.layout, aModules)).toBe(true);
    expect(contiguousInColumns(root.layout, ['m-b1', 'm-b2'])).toBe(true);

    // 테두리끼리 안 겹치고 묶음 밖 카드와도 안 겹친다
    for (const [i, f] of frames.entries()) {
      for (const other of frames.slice(i + 1)) expect(overlaps(f, other)).toBe(false);
      for (const n of root.layout.nodes) {
        if (contains(f, n)) continue;
        expect(overlaps(f, n)).toBe(false);
      }
    }
  });

  it('한 묶음이 두 열에 걸치면 열마다 테두리를 하나씩 단다', async () => {
    const root = await rootOf(fixture());
    const box = (id: string) => root.layout.nodes.find((n) => n.id === id)!;
    expect(box('gw-a').x).not.toBe(box('m-a1').x);
    const aFrames = groupFrames(root).filter((f) => f.label === 'repo-a');
    expect(aFrames).toHaveLength(2);
    expect(aFrames.map((f) => f.id).sort()).toEqual(
      [`group:repo-a:${box('gw-a').x}`, `group:repo-a:${box('m-a1').x}`].sort(),
    );
  });

  it('멤버가 하나뿐인 묶음도 그 카드에 라벨 단 테두리를 두른다', async () => {
    const root = await rootOf(fixture());
    const solo = groupFrames(root).filter((f) => f.label === 'repo-solo');
    expect(solo).toHaveLength(1);
    const card = root.layout.nodes.find((n) => n.id === 'm-solo')!;
    expect(contains(solo[0]!, card)).toBe(true);
    for (const n of root.layout.nodes) {
      if (n.id !== 'm-solo') expect(overlaps(solo[0]!, n)).toBe(false);
    }
  });

  it('앱 테두리와 묶음 테두리가 같이 있어도 서로 안 겹치고 앱 카드는 묶음에서 빠진다', async () => {
    const root = await rootOf(fixture({ console: true }));
    const frames = root.layout.frames ?? [];
    const appFrame = frames.find((f) => f.id === 'svc-console');
    expect(appFrame).toBeDefined();
    expect(appFrame!.label).toBeUndefined();
    const box = (id: string) => root.layout.nodes.find((n) => n.id === id)!;
    for (const id of ['svc-console', 'app-shell', 'app-coupon']) {
      expect(contains(appFrame!, box(id))).toBe(true);
    }
    const grouped = groupFrames(root);
    expect(grouped.length).toBeGreaterThan(0);
    for (const f of grouped) {
      expect(overlaps(f, appFrame!)).toBe(false);
      expect(contains(f, box('app-coupon'))).toBe(false);
    }
    for (const [i, f] of frames.entries()) {
      for (const other of frames.slice(i + 1)) expect(overlaps(f, other)).toBe(false);
    }
  });

  it('렌더된 HTML에 묶음 라벨이 frame-label 글자로 들어간다', async () => {
    const v = validated(fixture());
    const html = renderDrilldownHtml(v, await computeDrilldown(v), { audience: 'private' });
    expect(html).toMatch(/<text class="frame-label"[^>]*>repo-a<\/text>/);
    expect(html).toMatch(/<text class="frame-label"[^>]*>repo-b<\/text>/);
    expect(html).toContain('.frame-label');
  });
});

describe('stackGroups와 groupRects', () => {
  const card = (id: string, x: number, y: number) => ({
    id,
    label: id,
    rank: 0,
    lane: 'server' as const,
    kind: 'app_module' as const,
    x,
    y,
    width: 100,
    height: 48,
  });

  it('열 안에서 묶음 카드를 맨 위 멤버 자리로 모으고 옆 열로는 옮기지 않는다', () => {
    const layout = {
      width: 400,
      height: 400,
      nodes: [card('a1', 0, 0), card('x', 0, 72), card('a2', 0, 144), card('a3', 200, 0)],
      edges: [],
      lanes: [],
    } as unknown as LayoutResult;
    const groups = [{ label: 'repo-a', members: ['a1', 'a2', 'a3'] }];
    const stacked = groupRects(stackGroups(layout, groups), groups);
    const y = (id: string) => stacked.nodes.find((n) => n.id === id)!.y;
    expect(stacked.nodes.map((n) => n.x)).toEqual([0, 0, 0, 200]);
    expect(y('a1')).toBeLessThan(y('a2'));
    expect(y('a2')).toBeLessThan(y('x'));
    expect(stacked.frames?.map((f) => f.id)).toEqual(['group:repo-a:0', 'group:repo-a:200']);
    const colFrame = stacked.frames![0]!;
    expect(colFrame.y + colFrame.height).toBeLessThan(y('x'));
    expect(stacked.movedNodeIds).toEqual(expect.arrayContaining(['a1', 'a2', 'x', 'a3']));
  });

  it('기존 테두리는 그대로 두고 뒤에 붙인다', () => {
    const layout = {
      width: 400,
      height: 400,
      nodes: [card('a1', 0, 0), card('a2', 0, 72)],
      edges: [],
      lanes: [],
      frames: [{ id: 'svc', x: 200, y: 0, width: 50, height: 50 }],
    } as unknown as LayoutResult;
    const out = groupRects(layout, [{ label: 'repo-a', members: ['a1', 'a2'] }]);
    expect(out.frames?.map((f) => f.id)).toEqual(['svc', 'group:repo-a:0']);
  });
});

describe('group 필드 스키마', () => {
  it('group을 가진 IR이 형식 검사와 검증을 통과하고 빈 문자열은 거부한다', () => {
    const parsed = parseArchitectureIr(fixture());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.nodes.find((n) => n.id === 'gw-a')?.group).toBe('repo-a');
    expect(validateArchitectureIr(parsed.value, { checkFiles: false }).ok).toBe(true);

    const bad = fixture();
    bad.nodes.find((n) => n.id === 'gw-a')!.group = '';
    expect(parseArchitectureIr(bad).ok).toBe(false);
  });

  it('JSON 스키마의 node에도 group이 있다', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const schema = JSON.parse(
      readFileSync(resolve(here, '../../../schemas/architecture-ir.schema.json'), 'utf-8'),
    ) as { definitions: { node: { properties: Record<string, unknown> } } };
    expect(schema.definitions.node.properties.group).toMatchObject({
      type: 'string',
      minLength: 1,
    });
  });
});
