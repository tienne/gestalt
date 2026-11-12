import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  architectureViewSchema,
  CLOUD_PROVIDERS,
  ENGINE_KINDS,
  INFRA_LEVEL_KINDS,
  PLACED_IN_SOURCE_KINDS,
  SUBNET_EXPOSURES,
  contextSourceViaSchema,
  edgeKindSchema,
  evidenceTypeSchema,
  FLOW_ACTOR_KINDS,
  FLOW_PATHS,
  FLOW_STEP_KINDS,
  PROJECTION_SHAPES,
  SEQUENCE_BLOCK_KINDS,
  lineStyleSchema,
  nodeKindSchema,
  parseArchitectureIr,
  visibilitySchema,
} from '../../../src/architecture/index.js';

function minimalIr(): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'web', name: 'acme-web', root: '/repos/acme-web' }],
    nodes: [
      {
        id: 'screen:home',
        kind: 'screen',
        label: 'Home',
        repo: 'web',
        evidence: [{ type: 'code', location: 'web:src/pages/home.tsx:12', visibility: 'public' }],
      },
      {
        id: 'endpoint:get-items',
        kind: 'endpoint',
        label: 'GET /items',
        repo: 'web',
        evidence: [],
      },
    ],
    edges: [
      {
        id: 'e1',
        from: 'screen:home',
        to: 'endpoint:get-items',
        kind: 'calls',
        evidence: [{ type: 'doc', location: 'docs/api.md', visibility: 'private' }],
        lineStyle: 'dashed',
      },
    ],
    unresolved: [],
    sourcesUsed: [
      { via: 'repo', identifier: 'web', readOnly: true, probeHit: true, visibility: 'public' },
    ],
    generatedAt: '2026-10-03T00:00:00.000Z',
  };
}

describe('parseArchitectureIr', () => {
  it('최소 IR을 파싱한다', () => {
    const result = parseArchitectureIr(minimalIr());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodes).toHaveLength(2);
      expect(result.value.edges[0]!.lineStyle).toBe('dashed');
    }
  });

  it('parent는 비어 있지 않은 문자열만 받고 없어도 된다', () => {
    const withParent = (parent: unknown) => {
      const ir = minimalIr();
      (ir['nodes'] as Record<string, unknown>[])[0]!['parent'] = parent;
      return parseArchitectureIr(ir).ok;
    };
    expect(withParent('svc-web')).toBe(true);
    expect(withParent(undefined)).toBe(true);
    expect(withParent('')).toBe(false);
    expect(withParent(3)).toBe(false);
  });

  it('displayName과 displayNameInferred는 선택이고 displayName은 비어 있으면 안 된다', () => {
    const withName = (fields: Record<string, unknown>) => {
      const ir = minimalIr();
      Object.assign((ir['nodes'] as Record<string, unknown>[])[0]!, fields);
      return parseArchitectureIr(ir);
    };
    expect(withName({ displayName: '홈 화면' }).ok).toBe(true);
    expect(withName({ displayName: '홈 화면', displayNameInferred: true }).ok).toBe(true);
    expect(withName({ displayName: '홈 화면', displayNameInferred: false }).ok).toBe(true);
    expect(withName({ displayName: '' }).ok).toBe(false);
    expect(withName({ displayName: '홈', displayNameInferred: 'yes' }).ok).toBe(false);
  });

  it('displayName 없이 displayNameInferred만 오면 거부한다', () => {
    const ir = minimalIr();
    (ir['nodes'] as Record<string, unknown>[])[0]!['displayNameInferred'] = true;
    const result = parseArchitectureIr(ir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.some((i) => i.startsWith('nodes.0.displayNameInferred'))).toBe(
        true,
      );
    }
  });

  it('모르는 노드 kind를 거부한다', () => {
    const ir = minimalIr();
    (ir.nodes as Array<Record<string, unknown>>)[0]!.kind = 'microservice';
    const result = parseArchitectureIr(ir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.issues.some((i) => i.startsWith('nodes.0.kind'))).toBe(true);
    }
  });

  it('evidence.type 밖의 값을 거부한다', () => {
    const ir = minimalIr();
    const edge = (ir.edges as Array<Record<string, unknown>>)[0]!;
    edge.evidence = [{ type: 'guess', location: 'x', visibility: 'public' }];
    const result = parseArchitectureIr(ir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.some((i) => i.startsWith('edges.0.evidence.0.type'))).toBe(true);
    }
  });

  it('schemaVersion이 다르면 거부한다', () => {
    const ir = minimalIr();
    ir.schemaVersion = '2.0.0';
    expect(parseArchitectureIr(ir).ok).toBe(false);
  });
});

describe('parseArchitectureIr — db_table 컬럼', () => {
  function withColumns(kind: string, columns: unknown[]): Record<string, unknown> {
    const ir = minimalIr();
    (ir.nodes as Record<string, unknown>[]).push({
      id: 'tbl:orders',
      kind,
      label: 'orders',
      repo: 'web',
      evidence: [],
      columns,
    });
    return ir;
  }

  it('db_table 노드는 columns를 받고 references와 evidence는 선택이다', () => {
    const result = parseArchitectureIr(
      withColumns('db_table', [
        { name: 'id', type: 'uuid', pk: true },
        { name: 'user_id', references: { table: 'tbl:users', column: 'id', onDelete: 'CASCADE' } },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('db_table이 아닌 노드의 columns와 이름이 겹치는 컬럼을 거부한다', () => {
    const notTable = parseArchitectureIr(withColumns('datastore', [{ name: 'id' }]));
    expect(notTable.ok).toBe(false);
    if (!notTable.ok)
      expect(notTable.error.issues.some((i) => i.startsWith('nodes.2.columns'))).toBe(true);

    const dup = parseArchitectureIr(withColumns('db_table', [{ name: 'id' }, { name: 'id' }]));
    expect(dup.ok).toBe(false);
  });

  it('references에 table이 없으면 거부한다', () => {
    const result = parseArchitectureIr(
      withColumns('db_table', [{ name: 'user_id', references: {} }]),
    );
    expect(result.ok).toBe(false);
  });
});

describe('JSON Schema 파일과 zod 정합', () => {
  const schema = JSON.parse(
    readFileSync(resolve(__dirname, '../../../schemas/architecture-ir.schema.json'), 'utf-8'),
  ) as {
    properties: Record<string, { enum?: string[] }>;
    definitions: Record<
      string,
      { enum?: string[]; properties?: Record<string, { enum?: string[] }> }
    >;
  };
  const defs = schema.definitions;

  const pairs: Array<[string, string[] | undefined, readonly string[]]> = [
    ['view', schema.properties.view?.enum, architectureViewSchema.options],
    ['node.kind', defs.node?.properties?.kind?.enum, nodeKindSchema.options],
    ['edge.kind', defs.edge?.properties?.kind?.enum, edgeKindSchema.options],
    ['edge.lineStyle', defs.edge?.properties?.lineStyle?.enum, lineStyleSchema.options],
    ['evidence.type', defs.evidence?.properties?.type?.enum, evidenceTypeSchema.options],
    ['visibility', defs.visibility?.enum, visibilitySchema.options],
    [
      'contextSource.via',
      defs.contextSource?.properties?.via?.enum,
      contextSourceViaSchema.options,
    ],
    ['flowActor.kind', defs.flowActor?.properties?.kind?.enum, FLOW_ACTOR_KINDS],
    ['flowStep.kind', defs.flowStep?.properties?.kind?.enum, FLOW_STEP_KINDS],
    ['flowTransition.path', defs.flowTransition?.properties?.path?.enum, FLOW_PATHS],
    [
      'flowTransition.lineStyle',
      defs.flowTransition?.properties?.lineStyle?.enum,
      lineStyleSchema.options,
    ],
    ['projection.shape', defs.projection?.properties?.shape?.enum, PROJECTION_SHAPES],
    ['projectionBlock.kind', defs.projectionBlock?.properties?.kind?.enum, SEQUENCE_BLOCK_KINDS],
    [
      'projectionMessage.lineStyle',
      defs.projectionMessage?.properties?.lineStyle?.enum,
      lineStyleSchema.options,
    ],
  ];

  it.each(pairs)('%s enum 목록이 같다', (_name, jsonEnum, zodOptions) => {
    expect(jsonEnum).toBeDefined();
    expect(new Set(jsonEnum)).toEqual(new Set(zodOptions));
  });

  it('node의 displayName은 minLength 1, displayNameInferred는 displayName에 기대는 boolean이다', () => {
    const node = defs.node as {
      properties?: Record<string, { type?: string; minLength?: number }>;
      required?: string[];
      dependencies?: Record<string, string[]>;
    };
    expect(node.properties?.displayName).toMatchObject({ type: 'string', minLength: 1 });
    expect(node.properties?.displayNameInferred).toMatchObject({ type: 'boolean' });
    expect(node.required).not.toContain('displayName');
    expect(node.dependencies?.displayNameInferred).toEqual(['displayName']);
  });

  it('column 정의는 name만 필수이고 references는 table을 요구한다', () => {
    const column = defs.column as {
      properties?: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
      required?: string[];
    };
    expect(column.required).toEqual(['name']);
    expect(Object.keys(column.properties ?? {}).sort()).toEqual(
      ['evidence', 'name', 'nullable', 'pk', 'references', 'type', 'unique'].sort(),
    );
    expect(column.properties?.references?.required).toEqual(['table']);
    expect(Object.keys(column.properties?.references?.properties ?? {}).sort()).toEqual([
      'column',
      'onDelete',
      'table',
    ]);
    expect((defs.node?.properties as Record<string, unknown>).columns).toBeDefined();
  });
});

describe('인프라 배치 필드 (provider, region, exposure, placedIn, engine)', () => {
  const schemaFile = JSON.parse(
    readFileSync(resolve(__dirname, '../../../schemas/architecture-ir.schema.json'), 'utf-8'),
  ) as {
    definitions: {
      node: { properties: Record<string, { enum?: string[]; type?: string; minLength?: number }> };
    };
  };
  const props = schemaFile.definitions.node.properties;

  function withNode(extra: Record<string, unknown>, kind = 'datastore'): Record<string, unknown> {
    const ir = minimalIr();
    (ir.nodes as Array<Record<string, unknown>>).push({
      id: 'n-infra',
      kind,
      label: 'infra node',
      repo: 'web',
      evidence: [],
      ...extra,
    });
    return ir;
  }
  const issues = (r: ReturnType<typeof parseArchitectureIr>): string[] =>
    r.ok ? [] : r.error.issues;

  it('JSON 스키마의 enum이 zod 상수와 같다', () => {
    expect(new Set(props.provider?.enum)).toEqual(new Set(CLOUD_PROVIDERS));
    expect(new Set(props.exposure?.enum)).toEqual(new Set(SUBNET_EXPOSURES));
  });

  it.each(['region', 'placedIn', 'engine'])(
    'JSON 스키마의 %s는 비어 있지 않은 문자열이다',
    (name) => {
      expect(props[name]).toMatchObject({ type: 'string', minLength: 1 });
    },
  );

  it('인프라 레벨 kind는 provider와 region을 받는다', () => {
    for (const kind of INFRA_LEVEL_KINDS) {
      const r = parseArchitectureIr(withNode({ provider: 'aws', region: 'us-east-1' }, kind));
      expect(r.ok, `${kind}: ${issues(r).join(', ')}`).toBe(true);
    }
  });

  it.each(['service', 'screen', 'endpoint'])('%s에 provider나 region을 쓰면 거부한다', (kind) => {
    for (const extra of [{ provider: 'aws' }, { region: 'us-east-1' }]) {
      const r = parseArchitectureIr(withNode(extra, kind));
      expect(r.ok).toBe(false);
      expect(issues(r).some((i) => i.includes(Object.keys(extra)[0]!))).toBe(true);
    }
  });

  it('모르는 provider와 exposure 값을 거부한다', () => {
    expect(parseArchitectureIr(withNode({ provider: 'oracle' })).ok).toBe(false);
    expect(parseArchitectureIr(withNode({ exposure: 'internal' }, 'subnet')).ok).toBe(false);
  });

  it('빈 문자열 region과 placedIn을 거부한다', () => {
    expect(parseArchitectureIr(withNode({ region: '' })).ok).toBe(false);
    expect(parseArchitectureIr(withNode({ placedIn: '' })).ok).toBe(false);
  });

  it('exposure는 subnet에만 쓸 수 있다', () => {
    expect(parseArchitectureIr(withNode({ exposure: 'public' }, 'subnet')).ok).toBe(true);
    const r = parseArchitectureIr(withNode({ exposure: 'public' }, 'network'));
    expect(r.ok).toBe(false);
    expect(issues(r).some((i) => i.includes('exposure'))).toBe(true);
  });

  it('placedIn은 deploy_target, datastore, bucket에만 쓸 수 있다', () => {
    for (const kind of PLACED_IN_SOURCE_KINDS) {
      expect(parseArchitectureIr(withNode({ placedIn: 'x' }, kind)).ok, kind).toBe(true);
    }
    for (const kind of ['subnet', 'cluster', 'workload', 'service']) {
      const r = parseArchitectureIr(withNode({ placedIn: 'x' }, kind));
      expect(r.ok, kind).toBe(false);
      expect(issues(r).some((i) => i.includes('placedIn'))).toBe(true);
    }
  });

  it('placedIn이 자기 자신을 가리키면 거부한다', () => {
    const r = parseArchitectureIr(withNode({ placedIn: 'n-infra' }));
    expect(r.ok).toBe(false);
    expect(issues(r).some((i) => i.includes('자기 자신'))).toBe(true);
  });

  it('engine은 datastore, deploy_target, cluster에만 쓸 수 있다', () => {
    for (const kind of ENGINE_KINDS) {
      expect(parseArchitectureIr(withNode({ engine: 'ecs' }, kind)).ok, kind).toBe(true);
    }
    const r = parseArchitectureIr(withNode({ engine: 'ecs' }, 'service'));
    expect(r.ok).toBe(false);
    expect(issues(r).some((i) => i.includes('engine'))).toBe(true);
  });
});
