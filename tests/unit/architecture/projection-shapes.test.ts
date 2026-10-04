import { describe, expect, it } from 'vitest';
import {
  parseArchitectureIr,
  validateArchitectureIr,
  type ArchitectureIr,
} from '../../../src/architecture/index.js';
import { computeCompareLayout } from '../../../src/architecture/compare-layout.js';
import { computeDataflowLayout } from '../../../src/architecture/dataflow-layout.js';
import {
  orderDataflowIr,
  paymentCompareIr,
} from '../../fixtures/architecture-categories/projection-shapes.js';
import { renderBoth } from '../../fixtures/architecture-legacy/render.js';

function errorCodes(ir: ArchitectureIr): string[] {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  return r.ok ? [] : r.errors.map((e) => e.code);
}

describe('dataflow 투영', () => {
  it('스키마를 통과하고 근거 없는 선만 질문으로 돌린다', () => {
    const ir = orderDataflowIr();
    expect(parseArchitectureIr(JSON.parse(JSON.stringify(ir))).ok).toBe(true);
    const r = validateArchitectureIr(ir, { checkFiles: false });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect([...(r.value.drawableMessageIds ?? [])].sort()).toEqual([
      'd1',
      'd2',
      'd3',
      'd4',
      'd5',
      'd6',
      'd7',
    ]);
    const q = r.value.autoUnresolved.find((x) => x.id === 'auto:message:d8');
    expect(q?.question).toContain('옮겨 가나요');
  });

  it('되돌아가는 선이 있어도 열이 정해지고 같은 쌍의 선은 벌어진다', () => {
    const ir = orderDataflowIr();
    const p = ir.projections![0]!;
    const drawn = new Set(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
    const layout = computeDataflowLayout(p, drawn, new Map(ir.nodes.map((n) => [n.id, n])));
    const x = new Map(layout.cards.map((c) => [c.id, c.x]));
    expect(x.get('app')!).toBeLessThan(x.get('api')!);
    expect(x.get('api')!).toBeLessThan(x.get('db')!);
    expect(x.get('etl')!).toBeLessThan(x.get('dw')!);
    const d = new Map(layout.edges.map((e) => [e.id, e.d]));
    expect(d.get('d2')).not.toBe(d.get('d3'));
    // dw → api는 뒤로 가므로 카드 아래로 돈다
    const back = layout.edges.find((e) => e.id === 'd6')!;
    const bottom = Math.max(...layout.cards.map((c) => c.y + c.height));
    expect(back.labelY).toBeGreaterThan(bottom);
  });

  it.each<[string, (ir: ArchitectureIr) => void]>([
    ['PROJECTION_SHAPE_FIELD', (ir) => (ir.projections![0]!.messages[0]!.reply = true)],
    [
      'PROJECTION_SHAPE_FIELD',
      (ir) => (ir.projections![0]!.blocks = [{ id: 'b', kind: 'alt', label: 'x' }]),
    ],
    [
      'PROJECTION_SHAPE_FIELD',
      (ir) => (ir.projections![0]!.sides = paymentCompareIr().projections![0]!.sides),
    ],
    ['PROJECTION_EMPTY', (ir) => (ir.projections![0]!.messages = [])],
  ])('%s를 거부한다', (expected, mutate) => {
    const ir = orderDataflowIr();
    mutate(ir);
    expect(errorCodes(ir)).toContain(expected);
  });

  it('투영 레벨에 선과 데이터 이름을 그린다', async () => {
    const html = (await renderBoth(orderDataflowIr())).private;
    expect(html).toContain('data-level-id="view:order-data"');
    expect(html).toContain('class="link seq-m df-m"');
    expect(html).toContain('data-message-id="d7"');
    expect(html).not.toContain('data-message-id="d8"');
    expect(html).toContain('"shape":"dataflow"');
  });
});

describe('compare 투영', () => {
  it('스키마를 통과하고 세 열로 나눈다', () => {
    const ir = paymentCompareIr();
    expect(parseArchitectureIr(JSON.parse(JSON.stringify(ir))).ok).toBe(true);
    const r = validateArchitectureIr(ir, { checkFiles: false });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect([...(r.value.drawableProjectionIds ?? [])]).toEqual(['card-vs-wallet']);
    const layout = computeCompareLayout(
      ir.projections![0]!,
      new Set(ir.nodes.map((n) => n.id)),
      new Map(ir.nodes.map((n) => [n.id, n])),
    );
    const col = (k: string): string[] =>
      layout.cards.filter((c) => c.column === k).map((c) => c.id);
    expect(col('left')).toEqual(['pg', 'ledger']);
    expect(col('both')).toEqual(['app', 'api']);
    expect(col('right')).toEqual(['wallet']);
    expect(layout.columns.map((c) => c.title)).toEqual(['카드에만', '둘 다', '간편결제에만']);
  });

  it.each<[string, (ir: ArchitectureIr) => void]>([
    ['PROJECTION_SHAPE_FIELD', (ir) => ir.projections![0]!.sides!.pop()],
    ['PROJECTION_SHAPE_FIELD', (ir) => (ir.projections![0]!.sides![1]!.id = 'card')],
    [
      'PROJECTION_SHAPE_FIELD',
      (ir) =>
        ir.projections![0]!.messages.push({
          id: 'x',
          from: 'app',
          to: 'api',
          label: 'x',
          evidence: [],
          lineStyle: 'dashed',
        }),
    ],
    ['PROJECTION_NODE_NOT_FOUND', (ir) => ir.projections![0]!.sides![0]!.nodes.push('ghost')],
  ])('%s를 거부한다', (expected, mutate) => {
    const ir = paymentCompareIr();
    mutate(ir);
    expect(errorCodes(ir)).toContain(expected);
  });

  it('열 머리와 카드를 그리고 같은 입력이면 같은 HTML이 나온다', async () => {
    const a = await renderBoth(paymentCompareIr());
    const b = await renderBoth(paymentCompareIr());
    expect(a.private).toBe(b.private);
    expect(a.private).toContain('data-level-id="view:card-vs-wallet"');
    expect(a.private).toContain('class="cmp-col cmp-both"');
    expect(a.private).toContain('간편결제에만');
  });
});
