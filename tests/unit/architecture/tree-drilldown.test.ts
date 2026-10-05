import { describe, expect, it } from 'vitest';
import { computeDrilldown, shouldDrillDown } from '../../../src/architecture/drilldown.js';
import {
  parseArchitectureIr,
  validateArchitectureIr,
  type ArchitectureIr,
} from '../../../src/architecture/index.js';
import { vocabularyOf } from '../../../src/architecture/packs/index.js';
import { infraIr } from '../../fixtures/architecture-categories/infra.js';
import { renderBoth } from '../../fixtures/architecture-legacy/render.js';

function validated(ir: ArchitectureIr) {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

describe('tree 드릴다운', () => {
  it('generic을 requires로 끌어와도 tree 팩의 전략을 쓴다', () => {
    expect(vocabularyOf(['infra']).drilldown).toBe('tree');
    expect(vocabularyOf(['generic']).drilldown).toBe('none');
    expect(vocabularyOf(['web-product', 'infra']).drilldown).toBe('web-product');
  });

  it('스키마를 통과하고 포함 관계가 있으면 드릴다운으로 그린다', () => {
    const ir = infraIr();
    expect(parseArchitectureIr(JSON.parse(JSON.stringify(ir))).ok).toBe(true);
    expect(shouldDrillDown(validated(ir))).toBe(true);
    const flat = infraIr();
    flat.nodes = flat.nodes.map(({ parent: _p, ...n }) => n);
    expect(shouldDrillDown(validated(flat))).toBe(false);
  });

  it('전체에는 parent 없는 노드만 세우고 자손 선은 끌어올려 묶는다', async () => {
    const d = await computeDrilldown(validated(infraIr()));
    const root = d.levels[0]!;
    expect(root.nodeIds).toEqual(['saas', 'vpc-data', 'vpc-main']);
    const pair = (from: string, to: string) =>
      root.edges.find((e) => e.from === from && e.to === to);
    expect(pair('vpc-main', 'vpc-data')).toMatchObject({ kind: 'bundle', count: 3 });
    expect(pair('vpc-main', 'saas')).toMatchObject({ kind: 'bundle', lineStyle: 'dashed' });
    expect(d.enter).toEqual({
      k8s: 'group:k8s',
      'sn-private': 'group:sn-private',
      'sn-public': 'group:sn-public',
      'vpc-data': 'group:vpc-data',
      'vpc-main': 'group:vpc-main',
    });
  });

  it('그룹 레벨은 직속 자식과 한 단계 위 형제 높이의 바깥 끝점을 세운다', async () => {
    const d = await computeDrilldown(validated(infraIr()));
    const level = (id: string) => d.levels.find((l) => l.id === id)!;
    const k8s = level('group:k8s');
    expect(k8s.kind).toBe('group');
    expect(k8s.trail).toEqual(['root', 'group:vpc-main', 'group:sn-private', 'group:k8s']);
    // lb는 옆 서브넷이라 sn-public으로, db는 옆 네트워크라 vpc-data로 올라온다
    expect(k8s.nodeIds).toEqual(['api', 'saas', 'sn-public', 'vpc-data', 'worker']);
    expect(k8s.edges.find((e) => e.from === 'api' && e.to === 'worker')?.kind).toBe('sends');
    const main = level('group:vpc-main');
    expect(main.nodeIds).toEqual(['fw-edge', 'saas', 'sn-private', 'sn-public', 'vpc-data']);
    expect(main.edges.find((e) => e.from === 'fw-edge')?.kind).toBe('allows');
  });

  it('바깥 끝점은 kind 순위마다 열을 나누고 한 열에 네 장이 넘으면 옆 열로 넘긴다', async () => {
    const ir = infraIr();
    for (let i = 1; i <= 5; i += 1) {
      ir.nodes.push({
        ...ir.nodes.find((n) => n.id === 'saas')!,
        id: `saas-${i}`,
        label: `saas-${i}`,
      });
      ir.edges.push({
        ...ir.edges.find((e) => e.id === 'e-worker-saas')!,
        id: `e-saas-${i}`,
        to: `saas-${i}`,
      });
    }
    const d = await computeDrilldown(validated(ir));
    const k8s = d.levels.find((l) => l.id === 'group:k8s')!;
    const x = (id: string) => k8s.layout.nodes.find((n) => n.id === id)!.x;
    const saas = ['saas', 'saas-1', 'saas-2', 'saas-3', 'saas-4', 'saas-5'];
    // 받는 쪽 바깥 카드는 vpc-data(network)와 SaaS(component) 여섯 장이다. kind마다 열이 갈리고 SaaS는 두 열로 나뉜다
    expect(new Set(saas.map(x)).size).toBe(2);
    expect(saas.every((id) => x(id) !== x('vpc-data'))).toBe(true);
    const inside = Math.max(x('api'), x('worker'));
    expect(Math.min(x('vpc-data'), ...saas.map(x))).toBeGreaterThan(inside);
    // 보내기만 하는 바깥 카드는 안쪽 카드보다 왼쪽에 선다
    expect(x('sn-public')).toBeLessThan(Math.min(x('api'), x('worker')));
  });

  it('그룹 레벨을 HTML에 싣고 같은 입력이면 같은 HTML이 나온다', async () => {
    const a = await renderBoth(infraIr());
    const b = await renderBoth(infraIr());
    expect(a.private).toBe(b.private);
    expect(a.private).toContain('data-level-id="group:k8s"');
    expect(a.private).toContain('class="kc k-subnet"');
  });

  it('팩에 없는 parent kind는 막는다', () => {
    const ir = infraIr();
    ir.nodes.find((n) => n.id === 'k8s')!.parent = 'api';
    const r = validateArchitectureIr(ir, { checkFiles: false });
    expect(r.ok ? [] : r.errors.map((e) => e.code)).toContain('INVALID_PARENT_KIND');
  });
});
