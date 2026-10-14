import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArchitectureStore,
  mergeArchitectureIrs,
  mergeWithPrevious,
  parseArchitectureIr,
  redactForSharing,
  validateArchitectureIr,
  type ArchitectureIr,
  type ArchitectureNode,
  type Evidence,
  type NodeColumn,
  type ProjectionSlice,
} from '../../../src/architecture/index.js';
import { computeArchitectureDelta, type DeltaSnapshot } from '../../../src/architecture/delta.js';
import {
  ER_BUDGET,
  computeErLayout,
  deriveEr,
  erCounts,
  erOverBudget,
} from '../../../src/architecture/er-layout.js';
import { architectureInputSchema } from '../../../src/mcp/schemas.js';
import { handleArchitecturePassthrough } from '../../../src/mcp/tools/architecture-passthrough.js';
import { flowIr, harnessIr, webIr } from '../../fixtures/architecture-legacy/irs.js';
import { renderBoth } from '../../fixtures/architecture-legacy/render.js';

type Projection = NonNullable<ArchitectureIr['projections']>[number];

const code = (location: string): Evidence => ({ type: 'code', location, visibility: 'public' });
const spec = (location: string): Evidence => ({ type: 'spec', location, visibility: 'public' });
const doc = (location: string): Evidence => ({ type: 'doc', location, visibility: 'public' });

function table(id: string, columns?: NodeColumn[], evidence: Evidence[] = []): ArchitectureNode {
  return {
    id,
    kind: 'db_table',
    label: id,
    repo: 'web',
    parent: 'ds',
    description: `${id} 테이블`,
    evidence: evidence.length > 0 ? evidence : [code(`web:db/schema.sql:1`)],
    ...(columns !== undefined ? { columns } : {}),
  };
}

function erProjection(participants: string[], id = 'er-1'): Projection {
  return {
    id,
    shape: 'er',
    title: '테이블 구조',
    question: '어떤 테이블이 어디를 가리키나요?',
    participants,
    messages: [],
  };
}

function schemaIr(nodes: ArchitectureNode[], projections?: Projection[]): ArchitectureIr {
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'web', name: 'acme-web', root: '/srv/acme-web' }],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-10-15T00:00:00.000Z',
    nodes: [
      {
        id: 'ds',
        kind: 'datastore',
        label: 'shop-db',
        repo: 'web',
        description: '주문 DB',
        evidence: [code('web:db/schema.sql:1')],
      },
      ...nodes,
    ],
    edges: [],
    ...(projections !== undefined ? { projections } : {}),
  };
}

const fk = (
  to: string,
  ev: Evidence[] = [code('web:db/schema.sql:2')],
  extra = {},
): NodeColumn => ({
  name: `${to}_id`,
  references: { table: to, column: 'id', ...extra },
  evidence: ev,
});

function validated(ir: ArchitectureIr) {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

function errorsOf(ir: ArchitectureIr) {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  return r.ok ? [] : r.errors;
}

function modelOf(ir: ArchitectureIr, at = 0) {
  const v = validated(ir);
  return deriveEr(ir.projections![at]!, { nodes: ir.nodes, drawableNodeIds: v.drawableNodeIds });
}

/** 컬럼 n개짜리 테이블 하나를 그리는 IR */
function widthIr(n: number): ArchitectureIr {
  const columns: NodeColumn[] = Array.from({ length: n }, (_, i) =>
    i === 0 ? { name: 'id', pk: true } : { name: `c${i}`, type: 'text' },
  );
  return schemaIr([table('t', columns)], [erProjection(['t'])]);
}

/** 테이블 n개를 사슬로 잇는다. 사슬이라 외래 키는 n-1개다 */
function chainIr(n: number): ArchitectureIr {
  const nodes = Array.from({ length: n }, (_, i) =>
    table(`t${i}`, [{ name: 'id', pk: true }, ...(i > 0 ? [fk(`t${i - 1}`)] : [])]),
  );
  return schemaIr(nodes, [erProjection(nodes.map((x) => x.id))]);
}

/** a 테이블이 b의 id를 가리키는 외래 키 n개를 가진다 */
function fanIr(n: number): ArchitectureIr {
  const cols: NodeColumn[] = [{ name: 'id', pk: true }];
  for (let i = 0; i < n; i++) cols.push({ ...fk('b'), name: `b${i}` });
  return schemaIr(
    [table('a', cols), table('b', [{ name: 'id', pk: true }])],
    [erProjection(['a', 'b'])],
  );
}

const budgetOf = (ir: ArchitectureIr) =>
  validated(ir).warnings.filter((w) => w.code === 'ER_OVER_BUDGET');

describe('er 스키마와 검증 — 기존 IR 호환', () => {
  it('columns가 없는 기존 IR은 그대로 통과하고 er 경고도 없다', () => {
    for (const make of [flowIr, webIr, harnessIr]) {
      const r = validateArchitectureIr(make(), { checkFiles: false });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.warnings.filter((w) => w.code === 'ER_OVER_BUDGET')).toEqual([]);
    }
  });

  it('er 그림이 없는 그림에는 er 스타일과 행이 실리지 않는다', async () => {
    const { private: html } = await renderBoth(webIr());
    expect(html).not.toContain('er-row');
    expect(html).not.toContain('data-fk-id');
  });

  it('빈 columns 배열과 컬럼 없는 db_table을 받는다', () => {
    const ir = schemaIr([table('a', []), table('b')], [erProjection(['a', 'b'])]);
    expect(validateArchitectureIr(ir, { checkFiles: false }).ok).toBe(true);
  });

  it('서로 다른 테이블의 같은 컬럼 이름은 겹침이 아니다', () => {
    const parsed = parseArchitectureIr(
      schemaIr([table('a', [{ name: 'id' }]), table('b', [{ name: 'id' }])]),
    );
    expect(parsed.ok).toBe(true);
  });

  it('db_table이 아닌 어떤 kind에도 columns를 못 단다', () => {
    for (const kind of ['datastore', 'screen', 'endpoint', 'feature']) {
      const ir = schemaIr([]);
      ir.nodes.push({
        id: 'x',
        kind: kind as ArchitectureNode['kind'],
        label: 'x',
        repo: 'web',
        evidence: [code('web:db/schema.sql:1')],
        columns: [{ name: 'id' }],
      });
      expect(parseArchitectureIr(ir).ok, kind).toBe(false);
    }
  });

  it('빈 컬럼 이름과 빈 references.column은 거부한다', () => {
    expect(parseArchitectureIr(schemaIr([table('a', [{ name: '' }])])).ok).toBe(false);
    expect(
      parseArchitectureIr(
        schemaIr([table('a', [{ name: 'x', references: { table: 'b', column: '' } }])]),
      ).ok,
    ).toBe(false);
  });
});

describe('er 외래 키 대상 검증', () => {
  it('오류에 노드 id와 컬럼 이름이 실린다', () => {
    const ir = schemaIr([table('a', [fk('ghost')])]);
    const e = errorsOf(ir).find((x) => x.code === 'COLUMN_REFERENCE_NOT_FOUND');
    expect(e).toMatchObject({ nodeId: 'a', column: 'ghost_id' });
  });

  it('대상이 컬럼을 적었으면 가리킨 컬럼이 없을 때 거부한다', () => {
    const ir = schemaIr([table('a', [fk('b')]), table('b', [{ name: 'uid' }])]);
    expect(errorsOf(ir).map((e) => e.code)).toContain('COLUMN_REFERENCE_NOT_FOUND');
  });

  it('대상이 컬럼을 안 적었거나 빈 배열이면 가리킨 컬럼을 따지지 않는다', () => {
    for (const target of [table('b'), table('b', [])]) {
      expect(errorsOf(schemaIr([table('a', [fk('b')]), target]))).toEqual([]);
    }
  });

  it('references.column 없이 테이블만 가리켜도 통과하고 선은 머리에 붙는다', () => {
    const ir = schemaIr(
      [
        table('a', [
          { name: 'b_id', references: { table: 'b' }, evidence: [code('web:db/schema.sql:2')] },
        ]),
        table('b', [{ name: 'id' }]),
      ],
      [erProjection(['a', 'b'])],
    );
    const model = modelOf(ir);
    expect(model.links).toHaveLength(1);
    expect(model.links[0]!.toIndex).toBeUndefined();
    const route = computeErLayout(model).routes[0]!;
    const b = computeErLayout(model).tables.find((t) => t.id === 'b')!;
    expect(route.points.at(-1)!.y).toBe(b.y + 20);
  });

  it('자기 참조 외래 키는 검증을 통과하고 선이 같은 테이블에 돌아온다', () => {
    const ir = schemaIr(
      [
        table('cat', [
          { name: 'id', pk: true },
          { ...fk('cat'), name: 'parent_id' },
        ]),
      ],
      [erProjection(['cat'])],
    );
    const model = modelOf(ir);
    expect(model.links).toHaveLength(1);
    const layout = computeErLayout(model);
    expect(
      layout.routes[0]!.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
    ).toBe(true);
  });

  it('외래 키가 데이터 저장소 같은 다른 kind를 가리키면 거부한다', () => {
    const ir = schemaIr([table('a', [fk('ds')])]);
    expect(errorsOf(ir).map((e) => e.code)).toContain('INVALID_COLUMN_REFERENCE_KIND');
  });
});

describe('er 컬럼 근거 검증', () => {
  it('private 컬럼 근거에 excerpt가 있으면 PRIVATE_EXCERPT_PRESENT다', () => {
    const col: NodeColumn = {
      name: 'x',
      evidence: [
        { type: 'code', location: 'web:db/schema.sql:3', visibility: 'private', excerpt: 'SECRET' },
      ],
    };
    const e = errorsOf(schemaIr([table('a', [col])])).find(
      (x) => x.code === 'PRIVATE_EXCERPT_PRESENT',
    );
    expect(e).toMatchObject({ nodeId: 'a', column: 'x' });
  });

  it('컬럼 근거의 위치가 파일 줄 수를 넘으면 checkFiles에서 거부한다', () => {
    const root = resolve('.gestalt-test', `er-files-${randomUUID()}`);
    mkdirSync(join(root, 'db'), { recursive: true });
    writeFileSync(join(root, 'db/schema.sql'), 'a\nb\n');
    try {
      const ir = schemaIr([
        table(
          'a',
          [{ name: 'x', evidence: [code('web:db/schema.sql:99')] }],
          [code('web:db/schema.sql:1')],
        ),
      ]);
      ir.repos = [{ id: 'web', name: 'acme-web', root }];
      const r = validateArchitectureIr(ir, { checkFiles: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => e.column === 'x')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('er 투영 오용 규칙', () => {
  const codesOf = (p: Projection, ...rest: ArchitectureNode[]) =>
    errorsOf(schemaIr([table('a', [{ name: 'id' }]), ...rest], [p])).map((e) => e.code);

  it('flow가 있으면 모양 오용이다', () => {
    expect(codesOf({ ...erProjection(['a']), flow: 'queue' })).toContain('PROJECTION_SHAPE_FIELD');
  });

  it('blocks, phases, sides가 있으면 모양 오용이다', () => {
    expect(codesOf({ ...erProjection(['a']), blocks: [] })).toContain('PROJECTION_SHAPE_FIELD');
    expect(codesOf({ ...erProjection(['a']), phases: [] })).toContain('PROJECTION_SHAPE_FIELD');
    expect(codesOf({ ...erProjection(['a']), sides: [] })).toContain('PROJECTION_SHAPE_FIELD');
  });

  it('participants가 아예 없어도 PROJECTION_EMPTY다', () => {
    const p = erProjection(['a']);
    delete p.participants;
    expect(codesOf(p)).toContain('PROJECTION_EMPTY');
  });

  it('participants에 없는 노드 id를 적으면 거부한다', () => {
    expect(codesOf(erProjection(['a', 'ghost'])).length).toBeGreaterThan(0);
  });

  it('participants가 screen 같은 다른 kind여도 모양 오용이다', () => {
    const screen: ArchitectureNode = {
      id: 's',
      kind: 'screen',
      label: 's',
      repo: 'web',
      evidence: [code('web:db/schema.sql:1')],
    };
    expect(codesOf(erProjection(['a', 's']), screen)).toContain('PROJECTION_SHAPE_FIELD');
  });
});

describe('er 외래 키 선과 질문', () => {
  it('spec 근거도 실선이고 doc만 있으면 점선이다', () => {
    const ir = schemaIr(
      [
        table('a', [fk('b', [spec('docs/spec.md')]), { ...fk('c', [doc('https://w.test/x')]) }]),
        table('b', [{ name: 'id' }]),
        table('c', [{ name: 'id' }]),
      ],
      [erProjection(['a', 'b', 'c'])],
    );
    const styles = Object.fromEntries(modelOf(ir).links.map((l) => [l.id, l.lineStyle]));
    expect(styles).toEqual({ 'a:b_id': 'solid', 'a:c_id': 'dashed' });
  });

  it('노드 근거가 code여도 컬럼 근거가 비면 선이 없고 질문이 선다', () => {
    const ir = schemaIr(
      [table('a', [fk('b', [])]), table('b', [{ name: 'id' }])],
      [erProjection(['a', 'b'])],
    );
    expect(modelOf(ir).links).toEqual([]);
    const q = validated(ir).autoUnresolved.filter((x) => x.id.startsWith('auto:fk:'));
    expect(q.map((x) => x.id)).toEqual(['auto:fk:a:b_id']);
  });

  it('ON DELETE 글자는 근거 있는 외래 키에만 나온다', async () => {
    const ir = schemaIr(
      [
        table('a', [
          fk('b', [code('web:db/schema.sql:2')], { onDelete: 'CASCADE' }),
          { ...fk('c', [], { onDelete: 'SET NULL' }) },
        ]),
        table('b', [{ name: 'id' }]),
        table('c', [{ name: 'id' }]),
      ],
      [erProjection(['a', 'b', 'c'])],
    );
    const { private: html } = await renderBoth(ir);
    expect(html).toContain('ON DELETE CASCADE');
    expect(html).not.toContain('ON DELETE SET NULL');
    expect(modelOf(ir).links.map((l) => l.onDelete)).toEqual(['CASCADE']);
  });

  it('그림 밖 테이블을 가리키는 외래 키는 선이 없고 행 배지만 남는다', async () => {
    const ir = schemaIr(
      [table('a', [fk('b')]), table('b', [{ name: 'id' }])],
      [erProjection(['a'])],
    );
    expect(modelOf(ir).links).toEqual([]);
    const { private: html } = await renderBoth(ir);
    expect(html).not.toContain('data-fk-id');
    expect(html).toContain('(이 그림 밖)');
  });

  it('질문은 그려지는 db_table의 컬럼마다 하나씩 선다', () => {
    const ir = schemaIr(
      [
        table('a', [
          { ...fk('b', []), name: 'x' },
          { ...fk('b', []), name: 'y' },
        ]),
        table('b', [{ name: 'id' }]),
      ],
      [erProjection(['a', 'b'])],
    );
    const ids = validated(ir)
      .autoUnresolved.map((q) => q.id)
      .filter((id) => id.startsWith('auto:fk:'));
    expect(ids.sort()).toEqual(['auto:fk:a:x', 'auto:fk:a:y']);
  });

  it('근거 있는 외래 키에는 질문이 없다', () => {
    const ir = schemaIr(
      [table('a', [fk('b')]), table('b', [{ name: 'id' }])],
      [erProjection(['a', 'b'])],
    );
    expect(validated(ir).autoUnresolved.filter((q) => q.id.startsWith('auto:fk:'))).toEqual([]);
  });
});

describe('er 컬럼 행 접기 경계', () => {
  it('여덟 컬럼은 접힘 행이 없고 아홉 컬럼은 "1개 더" 하나다', async () => {
    const eight = modelOf(widthIr(8)).tables[0]!;
    expect(eight.rows).toHaveLength(8);
    expect(eight.rows.some((r) => r.type === 'fold')).toBe(false);
    expect((await renderBoth(widthIr(8))).private).not.toContain('개 더</span>');

    const nine = modelOf(widthIr(9)).tables[0]!;
    expect(nine.rows).toHaveLength(9);
    expect(nine.rows.at(-1)).toEqual({ type: 'fold', indexes: [8] });
    expect((await renderBoth(widthIr(9))).private).toContain('컬럼 1개 더');
  });

  it('PK와 외래 키 컬럼은 뒤쪽 자리여도 접힘 행에 안 들어간다', () => {
    const cols: NodeColumn[] = Array.from({ length: 12 }, (_, i) => ({ name: `c${i}` }));
    cols[10] = { name: 'id', pk: true };
    cols[11] = { ...fk('b'), name: 'b_id' };
    const ir = schemaIr(
      [table('a', cols), table('b', [{ name: 'id' }])],
      [erProjection(['a', 'b'])],
    );
    const a = modelOf(ir).tables.find((t) => t.id === 'a')!;
    const shown = a.rows.flatMap((r) => (r.type === 'column' ? [r.index] : []));
    expect(shown).toContain(10);
    expect(shown).toContain(11);
    expect(shown).toHaveLength(8);
    expect(a.rows.at(-1)).toMatchObject({ type: 'fold' });
  });

  it('접힌 컬럼을 대상으로 한 선도 그려지고 대상은 접히지 않는다', () => {
    const cols: NodeColumn[] = Array.from({ length: 12 }, (_, i) => ({ name: `c${i}` }));
    const ir = schemaIr(
      [
        table('a', [
          {
            name: 'k',
            references: { table: 'b', column: 'c11' },
            evidence: [code('web:db/schema.sql:2')],
          },
        ]),
        table('b', cols),
      ],
      [erProjection(['a', 'b'])],
    );
    const b = modelOf(ir).tables.find((t) => t.id === 'b')!;
    expect(b.rows.some((r) => r.type === 'column' && r.index === 11)).toBe(true);
  });
});

describe('er 예산 경계', () => {
  it('상수는 테이블 5, 컬럼 8, 외래 키 6이다', () => {
    expect(ER_BUDGET).toEqual({ tables: 5, columns: 8, foreignKeys: 6 });
    expect(erOverBudget({ tables: 5, columns: 8, foreignKeys: 6 })).toEqual([]);
    expect(erOverBudget({ tables: 6, columns: 9, foreignKeys: 7 })).toHaveLength(3);
  });

  it('테이블 5개는 경고가 없고 6개는 경고다', () => {
    expect(budgetOf(chainIr(5))).toEqual([]);
    expect(budgetOf(chainIr(6))).toHaveLength(1);
    expect(budgetOf(chainIr(6))[0]).toMatchObject({ counts: { tables: 6 } });
  });

  it('외래 키 6개는 경고가 없고 7개는 경고다', () => {
    expect(budgetOf(fanIr(6))).toEqual([]);
    expect(budgetOf(fanIr(7))[0]).toMatchObject({ counts: { foreignKeys: 7 } });
  });

  it('컬럼 8개는 경고가 없고 9개는 경고다', () => {
    expect(budgetOf(widthIr(8))).toEqual([]);
    expect(budgetOf(widthIr(9))[0]).toMatchObject({ counts: { columns: 9 } });
  });

  it('근거 없는 외래 키는 선이 아니라서 외래 키 수에 안 든다', () => {
    const ir = fanIr(6);
    ir.nodes.find((n) => n.id === 'a')!.columns!.push({ ...fk('b', []), name: 'extra' });
    expect(erCounts(modelOf(ir)).foreignKeys).toBe(6);
    expect(budgetOf(ir)).toEqual([]);
  });

  it('그리기를 막지 않는다', async () => {
    const { private: html } = await renderBoth(chainIr(7));
    expect(html).toContain('data-fk-id="t6:t5_id"');
  });
});

describe('er 렌더와 공유본', () => {
  const ACCOUNT = '123456789012';

  it('컬럼 이름과 타입과 테이블 이름의 마크업은 이스케이프된다', async () => {
    const ir = schemaIr(
      [
        table('a', [
          { name: '<script>alert(1)</script>', type: '<img src=x onerror=alert(2)>' },
          {
            name: 'k',
            references: { table: 'b', column: 'id', onDelete: '<b>x</b>' },
            evidence: [code('web:db/schema.sql:2')],
          },
        ]),
        table('b', [{ name: 'id' }]),
      ],
      [erProjection(['a', 'b'])],
    );
    ir.nodes.find((n) => n.id === 'a')!.label = '<script>alert(3)</script>';
    const { private: priv, shared } = await renderBoth(ir);
    for (const html of [priv, shared]) {
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('<script>alert(3)</script>');
      expect(html).toContain('&lt;img src=x');
      expect(html).not.toContain('ON DELETE <b>');
      expect(html).toContain('&lt;script&gt;alert(1)');
    }
  });

  it('두 번 그려도 바이트가 같다', async () => {
    const a = await renderBoth(chainIr(4));
    const b = await renderBoth(chainIr(4));
    expect(b.private).toBe(a.private);
    expect(b.shared).toBe(a.shared);
  });

  it('공유본에 컬럼 근거의 private 위치와 excerpt가 없다', async () => {
    const secretLoc = 'web:db/secret-migration.sql:7';
    const ir = schemaIr(
      [
        table('a', [
          {
            ...fk('b', [
              { type: 'code', location: secretLoc, visibility: 'private' },
              {
                type: 'code',
                location: 'web:db/schema.sql:2',
                visibility: 'public',
                excerpt: 'PUBLIC_EXCERPT',
              },
            ]),
          },
        ]),
        table('b', [{ name: 'id' }]),
      ],
      [erProjection(['a', 'b'])],
    );
    const { shared } = await renderBoth(ir);
    expect(shared).not.toContain(secretLoc);
    expect(shared).not.toContain('secret-migration');
    const redacted = redactForSharing(ir);
    const ev = redacted.nodes.find((n) => n.id === 'a')!.columns![0]!.evidence!;
    expect(ev[0]).toEqual({ type: 'code', visibility: 'private' });
  });

  it('저장용 사본은 컬럼 근거의 private excerpt를 지운다', () => {
    const root = resolve('.gestalt-test', `er-store-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    try {
      const ir = schemaIr(
        [
          table('a', [
            {
              name: 'x',
              evidence: [
                {
                  type: 'code',
                  location: 'web:db/schema.sql:3',
                  visibility: 'private',
                  excerpt: 'SECRET_EXCERPT',
                },
              ],
            },
          ]),
        ],
        [erProjection(['a'])],
      );
      const paths = new ArchitectureStore(root).saveViews(ir);
      expect(readFileSync(paths[0]!, 'utf-8')).not.toContain('SECRET_EXCERPT');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('컬럼 이름과 타입과 외래 키 대상 컬럼의 계정 ID 꼴을 가리고 원본은 남긴다', async () => {
    const ir = schemaIr(
      [
        table('a', [
          { name: `acct_${ACCOUNT}`, type: `varchar_${ACCOUNT}` },
          {
            name: 'k',
            references: { table: 'b', column: `id_${ACCOUNT}`, onDelete: `ON_${ACCOUNT}` },
            evidence: [code('web:db/schema.sql:2')],
          },
        ]),
        table('b', [{ name: `id_${ACCOUNT}` }]),
      ],
      [erProjection(['a', 'b'])],
    );
    const { private: priv, shared } = await renderBoth(ir);
    expect(priv).toContain(ACCOUNT);
    expect(shared).not.toContain(ACCOUNT);
    expect(shared).toContain('[계정 ID]');
  });

  it('공유본의 질문 id와 글자에 컬럼 이름의 계정 ID가 새지 않는다', async () => {
    const ir = schemaIr(
      [table('a', [{ ...fk('b', []), name: `acct_${ACCOUNT}` }]), table('b', [{ name: 'id' }])],
      [erProjection(['a', 'b'])],
    );
    const { shared } = await renderBoth(ir);
    expect(shared).not.toContain(ACCOUNT);
  });
});

describe('er 병합', () => {
  const repo = (id: string) => ({
    id,
    name: 'acme-api',
    root: `/c/${id}`,
    remote: 'git@github.com:acme/acme-api.git',
  });
  const mk = (repoId: string, nodes: ArchitectureNode[]): ArchitectureIr => ({
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [repo(repoId)],
    nodes: nodes.map(({ parent: _p, ...n }) => ({ ...n, repo: repoId })),
    edges: [],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-10-15T00:00:00.000Z',
  });
  const ev = (repoId: string, line: number): Evidence => code(`${repoId}:db/schema.sql:${line}`);

  it('두 입력의 컬럼 이름 합집합을 만들고 근거는 합친다', () => {
    const a = mk('api', [
      table(
        't1',
        [
          { name: 'id', pk: true },
          { name: 'a', evidence: [ev('api', 1)] },
        ],
        [ev('api', 1)],
      ),
    ]);
    const b = mk('server', [
      table(
        't1',
        [{ name: 'a', type: 'int', evidence: [ev('server', 5)] }, { name: 'b' }],
        [ev('server', 1)],
      ),
    ]);
    const r = mergeArchitectureIrs([a, b], {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.ir.nodes.find((n) => n.kind === 'db_table')!;
    expect(t.columns!.map((c) => c.name)).toEqual(['id', 'a', 'b']);
    const col = t.columns!.find((c) => c.name === 'a')!;
    expect(col.type).toBe('int');
    expect(col.evidence).toHaveLength(2);
  });

  it('합쳐도 한쪽만 columns를 가졌으면 그대로 남고 둘 다 없으면 필드가 안 생긴다', () => {
    const r = mergeArchitectureIrs(
      [
        mk('api', [table('t1'), table('t2', [{ name: 'id' }])]),
        mk('server', [table('t1'), table('t2')]),
      ],
      {},
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byLabel = (l: string) => r.ir.nodes.find((n) => n.label === l)!;
    expect(byLabel('t1').columns).toBeUndefined();
    expect(byLabel('t2').columns!.map((c) => c.name)).toEqual(['id']);
  });
});

describe('er 이월과 저장', () => {
  let root: string;
  beforeEach(() => {
    root = resolve('.gestalt-test', `er-carry-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  function base(): ArchitectureIr {
    return schemaIr(
      [
        table('users', [{ name: 'id', pk: true }]),
        table('orders', [{ name: 'id', pk: true }, fk('users')]),
        table('coupons', [{ name: 'id', pk: true }]),
      ],
      [erProjection(['orders', 'coupons'])],
    );
  }

  it('그림 파일에 외래 키 대상 테이블과 auto:fk 질문을 싣는다', () => {
    const ir = base();
    ir.nodes
      .find((n) => n.id === 'orders')!
      .columns!.push({ ...fk('users', []), name: 'closer_id' });
    ir.unresolved = [
      { id: 'auto:fk:orders:closer_id', subject: { nodeId: 'orders' }, question: '근거 어디?' },
      { id: 'auto:fk:users:x', subject: { nodeId: 'users' }, question: '그림 밖' },
    ];
    const paths = new ArchitectureStore(root).saveViews(ir);
    const slice = JSON.parse(readFileSync(paths[0]!, 'utf-8')) as ProjectionSlice;
    expect(slice.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining(['orders', 'coupons', 'users']),
    );
    expect(slice.unresolved.map((q) => q.id)).toEqual(['auto:fk:orders:closer_id']);
  });

  it('다음 실행 IR에 er이 없어도 테이블이 살아 있으면 이월한다', () => {
    const next = base();
    delete next.projections;
    expect(mergeWithPrevious(base(), next).projections?.map((p) => p.id)).toEqual(['er-1']);
  });

  it('그림이 가리킨 테이블이 사라지면 er을 버린다', () => {
    const next = base();
    delete next.projections;
    next.nodes = next.nodes.filter((n) => n.id !== 'coupons');
    expect(mergeWithPrevious(base(), next).projections ?? []).toEqual([]);
  });

  it('그림이 가리킨 id를 이번에는 테이블이 아닌 노드가 쓰면 er을 버린다', () => {
    const next = base();
    delete next.projections;
    next.nodes = next.nodes.map((n) =>
      n.id === 'coupons' ? { ...n, kind: 'module', columns: undefined } : n,
    );
    expect(mergeWithPrevious(base(), next).projections ?? []).toEqual([]);
  });

  it('재실행에서 id가 바뀌면 references.table을 지난 id로 따라간다', () => {
    const prev = base();
    const next = base();
    next.nodes = next.nodes.map((n) => (n.id === 'users' ? { ...n, id: 'users-new' } : n));
    next.nodes.find((n) => n.id === 'orders')!.columns![1]!.references!.table = 'users-new';
    const merged = mergeWithPrevious(prev, next);
    const orders = merged.nodes.find((n) => n.id === 'orders')!;
    expect(orders.columns![1]!.references!.table).toBe('users');
    expect(merged.nodes.some((n) => n.id === 'users-new')).toBe(false);
    expect(validateArchitectureIr(merged, { checkFiles: false }).ok).toBe(true);
  });

  it('재실행은 지난 컬럼을 되살리지 않는다', () => {
    const prev = base();
    const next = base();
    next.nodes.find((n) => n.id === 'users')!.columns = [{ name: 'id', pk: true }];
    prev.nodes.find((n) => n.id === 'users')!.columns!.push({ name: 'old_col' });
    const merged = mergeWithPrevious(prev, next);
    expect(merged.nodes.find((n) => n.id === 'users')!.columns!.map((c) => c.name)).toEqual(['id']);
  });

  it('mergeWithPrevious는 입력 IR의 컬럼을 바꾸지 않는다', () => {
    const prev = base();
    const next = base();
    next.nodes = next.nodes.map((n) => (n.id === 'users' ? { ...n, id: 'users-new' } : n));
    next.nodes.find((n) => n.id === 'orders')!.columns![1]!.references!.table = 'users-new';
    const before = JSON.stringify(next);
    mergeWithPrevious(prev, next);
    expect(JSON.stringify(next)).toBe(before);
  });
});

describe('er 구조 변경 원장', () => {
  const EV = [code('web:db/schema.sql:1')];
  const snap = (nodes: ArchitectureNode[]): DeltaSnapshot => {
    const v = validated(schemaIr(nodes));
    return { ir: v.ir, nodeIds: v.drawableNodeIds, edgeIds: v.drawableEdgeIds };
  };
  const changed = (a: ArchitectureNode[], b: ArchitectureNode[]) =>
    computeArchitectureDelta(snap(a), snap(b)).ledger.filter((x) => x.target === 't');

  it('컬럼이 그대로면 원장에 아무것도 없다', () => {
    const cols = [{ name: 'id', type: 'int' }];
    expect(changed([table('t', cols)], [table('t', structuredClone(cols))])).toEqual([]);
  });

  it('컬럼 생김, 빠짐, 바뀜을 한 건의 CHANGED에 모은다', () => {
    const before = [table('t', [{ name: 'a' }, { name: 'b', type: 'int' }])];
    const after = [table('t', [{ name: 'b', type: 'text' }, { name: 'c' }])];
    const rows = changed(before, after);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.change).toBe('CHANGED');
    expect(rows[0]!.text).toContain('컬럼 c 생김');
    expect(rows[0]!.text).toContain('컬럼 a 빠짐');
    expect(rows[0]!.text).toContain('컬럼 b 바뀜');
  });

  it('외래 키 근거가 생기면 바뀜으로 잡고 일반 컬럼의 근거 변화는 안 잡는다', () => {
    const fkNo = [table('t', [{ name: 'x', references: { table: 't', column: 'x' } }], EV)];
    const fkYes = [
      table('t', [{ name: 'x', references: { table: 't', column: 'x' }, evidence: EV }], EV),
    ];
    expect(changed(fkNo, fkYes)[0]!.text).toContain('컬럼 x 바뀜');
    expect(
      changed([table('t', [{ name: 'y' }])], [table('t', [{ name: 'y', evidence: EV }])]),
    ).toEqual([]);
  });

  it('ON DELETE만 바뀌어도 바뀜이다', () => {
    const mk = (od: string) =>
      table(
        't',
        [{ name: 'x', references: { table: 't', column: 'x', onDelete: od }, evidence: EV }],
        EV,
      );
    expect(changed([mk('CASCADE')], [mk('SET NULL')])[0]!.text).toContain('컬럼 x 바뀜');
  });

  it('columns가 처음 생기면 모든 컬럼이 생김이다', () => {
    const rows = changed([table('t')], [table('t', [{ name: 'a' }, { name: 'b' }])]);
    expect(rows[0]!.text).toContain('컬럼 a, b 생김');
  });
});

describe('ges_architecture er 경고', () => {
  let tmpRoot: string;
  let repoRoot: string;
  let homeDir: string;

  beforeEach(() => {
    tmpRoot = resolve('.gestalt-test', `er-pt-${randomUUID()}`);
    repoRoot = join(tmpRoot, 'acme-web');
    homeDir = join(tmpRoot, 'home');
    mkdirSync(join(repoRoot, 'db'), { recursive: true });
    mkdirSync(join(homeDir, '.claude', 'projects'), { recursive: true });
    writeFileSync(join(repoRoot, 'db/schema.sql'), 'a\nb\nc\nd\n');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function ir(base: ArchitectureIr): ArchitectureIr {
    return {
      ...base,
      repos: [{ id: 'web', name: 'acme-web', root: '.' }],
      sourcesUsed: [
        {
          via: 'repo',
          identifier: 'CLAUDE.md',
          readOnly: true,
          probeHit: true,
          visibility: 'public',
        },
      ],
    };
  }

  async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = architectureInputSchema.parse({ repoRoot, ...args });
    return (await handleArchitecturePassthrough(input, process.cwd(), {
      homeDir,
      projectsRoot: join(homeDir, '.claude', 'projects'),
    })) as Record<string, unknown>;
  }

  type W = { code: string; subjectId?: string; counts: Record<string, number> };
  const budget = (r: Record<string, unknown>): W[] =>
    ((r['warnings'] as W[] | undefined) ?? []).filter((w) => w.code === 'ER_OVER_BUDGET');

  it.each([
    ['테이블 6개', () => chainIr(6), { tables: 6 }],
    ['외래 키 7개', () => fanIr(7), { foreignKeys: 7 }],
    ['컬럼 9개', () => widthIr(9), { columns: 9 }],
  ])('%s는 validate와 render 응답에 같은 counts로 실린다', async (_n, make, expected) => {
    const validate = await call({ action: 'validate', ir: ir(make()) });
    expect(validate['ok']).toBe(true);
    const render = await call({ action: 'render', ir: ir(make()) });
    expect(render['ok']).toBe(true);
    expect(budget(validate)).toHaveLength(1);
    expect(budget(render)).toEqual(budget(validate));
    expect(budget(render)[0]!.counts).toMatchObject(expected);
    expect(existsSync(render['htmlPath'] as string)).toBe(true);
  });

  it('예산 안의 그림은 두 응답 모두 경고가 없다', async () => {
    expect(budget(await call({ action: 'validate', ir: ir(chainIr(5)) }))).toEqual([]);
    expect(budget(await call({ action: 'render', ir: ir(chainIr(5)) }))).toEqual([]);
  });
});
