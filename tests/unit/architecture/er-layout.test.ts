import { describe, expect, it } from 'vitest';
import {
  validateArchitectureIr,
  type ArchitectureIr,
  type ArchitectureNode,
  type Evidence,
  type NodeColumn,
} from '../../../src/architecture/index.js';
import {
  ER_HEAD_H,
  ER_ROW_H,
  computeErLayout,
  deriveEr,
  erFoldText,
  type ErModel,
} from '../../../src/architecture/er-layout.js';
import { renderBoth } from '../../fixtures/architecture-legacy/render.js';

type Projection = NonNullable<ArchitectureIr['projections']>[number];

const code = (location: string): Evidence => ({ type: 'code', location, visibility: 'public' });
const doc = (location: string): Evidence => ({ type: 'doc', location, visibility: 'public' });

function table(id: string, columns: NodeColumn[]): ArchitectureNode {
  return {
    id,
    kind: 'db_table',
    label: id,
    repo: 'web',
    parent: 'ds-shop',
    description: `${id} 테이블`,
    evidence: [code(`web:db/migrations/${id}.sql:1`)],
    columns,
  };
}

const ER: Projection = {
  id: 'order-schema',
  shape: 'er',
  title: '주문 테이블 구조',
  question: '주문을 지우면 어떤 행이 같이 지워지나요?',
  participants: ['users', 'products', 'orders', 'order_items', 'payments'],
  messages: [],
};

/** 외래 키 셋이 각각 code 근거, 문서 근거, 근거 없음이다 */
function erIr(projections: Projection[] = [ER], extraUserColumns = 0): ArchitectureIr {
  const userColumns: NodeColumn[] = [
    { name: 'id', type: 'uuid', pk: true },
    { name: 'email', type: 'text', unique: true },
    { name: 'phone', type: 'text', nullable: true },
  ];
  for (let i = 0; i < extraUserColumns; i++) userColumns.push({ name: `c${i}`, type: 'text' });
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'web', name: 'acme-web', root: '/srv/acme-web' }],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-10-15T00:00:00.000Z',
    nodes: [
      {
        id: 'ds-shop',
        kind: 'datastore',
        label: 'shop-db',
        repo: 'web',
        description: '주문 DB',
        evidence: [code('web:db/schema.prisma:1')],
      },
      table('users', userColumns),
      table('products', [{ name: 'id', type: 'uuid', pk: true }]),
      table('orders', [
        { name: 'id', type: 'uuid', pk: true },
        {
          name: 'user_id',
          type: 'uuid',
          references: { table: 'users', column: 'id', onDelete: 'CASCADE' },
          evidence: [code('web:db/migrations/orders.sql:4')],
        },
      ]),
      table('order_items', [
        { name: 'id', type: 'uuid', pk: true },
        {
          name: 'product_id',
          type: 'uuid',
          references: { table: 'products', column: 'id', onDelete: 'SET NULL' },
          evidence: [doc('https://wiki.acme.test/db/order_items')],
        },
      ]),
      table('payments', [
        { name: 'id', type: 'uuid', pk: true },
        { name: 'order_id', type: 'uuid', references: { table: 'orders', column: 'id' } },
      ]),
    ],
    edges: [],
    projections,
  };
}

function validated(ir: ArchitectureIr) {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

function modelOf(ir: ArchitectureIr): ErModel {
  const v = validated(ir);
  return deriveEr(ir.projections![0]!, { nodes: ir.nodes, drawableNodeIds: v.drawableNodeIds });
}

function errorCodes(ir: ArchitectureIr): string[] {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  return r.ok ? [] : r.errors.map((e) => e.code);
}

describe('er 투영 — 검증', () => {
  it('db_table 참가자와 빈 messages를 받는다', () => {
    expect(validateArchitectureIr(erIr(), { checkFiles: false }).ok).toBe(true);
  });

  it('db_table이 아닌 참가자, 빈 참가자, messages가 있으면 모양 오용이다', () => {
    expect(errorCodes(erIr([{ ...ER, participants: ['users', 'ds-shop'] }]))).toContain(
      'PROJECTION_SHAPE_FIELD',
    );
    expect(errorCodes(erIr([{ ...ER, participants: [] }]))).toContain('PROJECTION_EMPTY');
    expect(
      errorCodes(
        erIr([
          {
            ...ER,
            messages: [{ from: 'orders', to: 'users', label: 'x', evidence: [code('web:a.ts:1')] }],
          },
        ]),
      ),
    ).toContain('PROJECTION_SHAPE_FIELD');
  });

  it('없는 대상 테이블과 대상에 없는 컬럼, db_table이 아닌 대상을 거부한다', () => {
    const missingTable = erIr();
    missingTable.nodes.find((n) => n.id === 'payments')!.columns![1]!.references = {
      table: 'refunds',
    };
    expect(errorCodes(missingTable)).toContain('COLUMN_REFERENCE_NOT_FOUND');

    const missingColumn = erIr();
    missingColumn.nodes.find((n) => n.id === 'payments')!.columns![1]!.references = {
      table: 'orders',
      column: 'order_no',
    };
    expect(errorCodes(missingColumn)).toContain('COLUMN_REFERENCE_NOT_FOUND');

    const notTable = erIr();
    notTable.nodes.find((n) => n.id === 'payments')!.columns![1]!.references = { table: 'ds-shop' };
    expect(errorCodes(notTable)).toContain('INVALID_COLUMN_REFERENCE_KIND');
  });
});

describe('er 투영 — 컬럼 행과 외래 키 선', () => {
  it('컬럼마다 행 하나를 적힌 순서대로 만든다', () => {
    const users = modelOf(erIr()).tables.find((t) => t.id === 'users')!;
    expect(users.rows).toEqual([
      { type: 'column', index: 0 },
      { type: 'column', index: 1 },
      { type: 'column', index: 2 },
    ]);
  });

  it('code 근거는 실선, 문서 근거만 있으면 점선, 근거가 없으면 선 없이 질문으로 간다', () => {
    const ir = erIr();
    const model = modelOf(ir);
    expect(model.links.map((l) => [l.id, l.lineStyle, l.onDelete])).toEqual([
      ['orders:user_id', 'solid', 'CASCADE'],
      ['order_items:product_id', 'dashed', 'SET NULL'],
    ]);
    const asked = validated(ir).autoUnresolved.find((q) => q.id === 'auto:fk:payments:order_id');
    expect(asked?.subject).toEqual({ nodeId: 'payments' });
  });

  it('선 양 끝이 출발 컬럼 행과 대상 컬럼 행 가운데에 붙는다', () => {
    const model = modelOf(erIr());
    const layout = computeErLayout(model);
    const box = (id: string) => layout.tables.find((t) => t.id === id)!;
    const rowY = (id: string, row: number) => box(id).y + ER_HEAD_H + row * ER_ROW_H + ER_ROW_H / 2;
    const route = layout.routes.find((r) => r.id === 'orders:user_id')!;
    expect(route.points[0]).toEqual({ x: box('orders').x, y: rowY('orders', 1) });
    expect(route.points.at(-1)).toEqual({
      x: box('users').x + box('users').width,
      y: rowY('users', 0),
    });
  });

  it('여덟 행을 넘는 컬럼은 접힘 행 하나로 묶는다', async () => {
    const users = modelOf(erIr([ER], 7)).tables.find((t) => t.id === 'users')!;
    expect(users.total).toBe(10);
    expect(users.rows.filter((r) => r.type === 'column')).toHaveLength(8);
    expect(users.rows.at(-1)).toEqual({ type: 'fold', indexes: [8, 9] });
    expect((await renderBoth(erIr([ER], 7))).private).toContain(erFoldText(2));
  });

  it('예산을 넘으면 ER_OVER_BUDGET을 싣되 그리기는 한다', async () => {
    expect(validated(erIr()).warnings.filter((w) => w.code === 'ER_OVER_BUDGET')).toEqual([]);
    const over = validated(erIr([ER], 6));
    const w = over.warnings.find((x) => x.code === 'ER_OVER_BUDGET');
    expect(w).toMatchObject({ subjectId: 'order-schema', counts: { tables: 5, columns: 9 } });
    expect((await renderBoth(erIr([ER], 6))).private).toContain('data-fk-id="orders:user_id"');
  });

  it('공유본은 컬럼 이름을 가리고 선 자리는 그대로 둔다', async () => {
    const ir = erIr();
    ir.nodes.find((n) => n.id === 'users')!.columns![2]!.name = 'aws_account_123456789012';
    const { private: priv, shared } = await renderBoth(ir);
    expect(priv).toContain('aws_account_123456789012');
    expect(shared).not.toContain('123456789012');
    expect(shared).toContain('data-fk-id="orders:user_id"');
    expect(shared).toContain('er-fk doc-only');
  });
});
