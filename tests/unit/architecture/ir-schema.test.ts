import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  architectureViewSchema,
  contextSourceViaSchema,
  edgeKindSchema,
  evidenceTypeSchema,
  FLOW_ACTOR_KINDS,
  FLOW_PATHS,
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
    ['flowTransition.path', defs.flowTransition?.properties?.path?.enum, FLOW_PATHS],
    [
      'flowTransition.lineStyle',
      defs.flowTransition?.properties?.lineStyle?.enum,
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
});
