import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  redactForSharing,
  stripPrivateExcerpts,
  validateArchitectureIr,
  type ArchitectureEdge,
  type ArchitectureIr,
  type ArchitectureNode,
  type Evidence,
} from '../../../src/architecture/index.js';

const tmpRoot = resolve('.gestalt-test', `architecture-validator-${randomUUID()}`);
const repoRoot = join(tmpRoot, 'acme-web');

beforeAll(() => {
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src/home.tsx'), 'line1\nline2\nline3\n');
  writeFileSync(join(tmpRoot, 'outside.ts'), 'a\nb\nc\n');
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const codeEv = (line = 1): Evidence => ({
  type: 'code',
  location: `web:src/home.tsx:${line}`,
  visibility: 'public',
});

function node(id: string, evidence: Evidence[] = [codeEv()]): ArchitectureNode {
  return { id, kind: 'screen', label: id, repo: 'web', evidence };
}

function edge(
  id: string,
  from: string,
  to: string,
  evidence: Evidence[],
  lineStyle: ArchitectureEdge['lineStyle'] = 'solid',
): ArchitectureEdge {
  return { id, from, to, kind: 'calls', evidence, lineStyle };
}

function makeIr(nodes: ArchitectureNode[], edges: ArchitectureEdge[] = []): ArchitectureIr {
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'web', name: 'acme-web', root: repoRoot }],
    nodes,
    edges,
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function errorCodes(
  ir: ArchitectureIr,
  opts?: Parameters<typeof validateArchitectureIr>[1],
): string[] {
  const result = validateArchitectureIr(ir, opts);
  return result.ok ? [] : result.errors.map((e) => e.code);
}

describe('validateArchitectureIr', () => {
  it('근거가 맞는 IR은 통과하고 전부 그린다', () => {
    const ir = makeIr([node('a'), node('b')], [edge('e1', 'a', 'b', [codeEv(2)])]);
    const result = validateArchitectureIr(ir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.drawableNodeIds]).toEqual(['a', 'b']);
    expect([...result.value.drawableEdgeIds]).toEqual(['e1']);
    expect(result.value.autoUnresolved).toEqual([]);
  });

  it('(a) doc 근거뿐인데 solid면 SOLID_EDGE_WITHOUT_EVIDENCE', () => {
    const docEv: Evidence = { type: 'doc', location: 'docs/flow.md', visibility: 'public' };
    const ir = makeIr([node('a'), node('b')], [edge('e1', 'a', 'b', [docEv], 'solid')]);
    const result = validateArchitectureIr(ir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'SOLID_EDGE_WITHOUT_EVIDENCE', edgeId: 'e1' });
  });

  it('(a) 근거가 하나도 없는데 solid면 미해결로 돌리지 않고 거부한다', () => {
    const ir = makeIr([node('a'), node('b')], [edge('e1', 'a', 'b', [], 'solid')]);
    const result = validateArchitectureIr(ir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'SOLID_EDGE_WITHOUT_EVIDENCE', edgeId: 'e1' });
  });

  it('lineStyle은 근거 종류로 다시 계산해 덮어쓴다', () => {
    const userEv: Evidence = { type: 'user', location: 'interview', visibility: 'public' };
    const ir = makeIr(
      [node('a'), node('b')],
      [edge('e1', 'a', 'b', [userEv], 'dashed'), edge('e2', 'a', 'b', [codeEv()], 'dashed')],
    );
    const result = validateArchitectureIr(ir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ir.edges.map((e) => e.lineStyle)).toEqual(['dashed', 'solid']);
    expect(ir.edges[1]!.lineStyle).toBe('dashed');
  });

  it('(b) 줄 3은 통과하고 줄 4는 CODE_EVIDENCE_NOT_FOUND', () => {
    expect(errorCodes(makeIr([node('a', [codeEv(3)])]))).toEqual([]);
    const result = validateArchitectureIr(makeIr([node('a', [codeEv(4)])]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({
      code: 'CODE_EVIDENCE_NOT_FOUND',
      nodeId: 'a',
      evidenceIndex: 0,
    });
  });

  it('(b) 줄 0, 없는 파일, 모르는 레포, 형식 오류를 거부한다', () => {
    const cases = [
      'web:src/home.tsx:0',
      'web:src/missing.tsx:1',
      'api:src/home.tsx:1',
      'web:src/home.tsx',
    ];
    for (const location of cases) {
      const ir = makeIr([node('a', [{ type: 'code', location, visibility: 'public' }])]);
      expect(errorCodes(ir)).toEqual(['CODE_EVIDENCE_NOT_FOUND']);
    }
  });

  it('(b) 레포 루트 밖으로 나가는 경로를 거부한다', () => {
    const ir = makeIr([
      node('a', [{ type: 'code', location: 'web:../outside.ts:1', visibility: 'public' }]),
    ]);
    expect(errorCodes(ir)).toEqual(['CODE_EVIDENCE_NOT_FOUND']);
  });

  it('(b) checkFiles=false면 파일을 확인하지 않는다', () => {
    expect(errorCodes(makeIr([node('a', [codeEv(99)])]), { checkFiles: false })).toEqual([]);
  });

  it('(b) repoRoots를 주면 ir.repos보다 우선한다', () => {
    const ir = makeIr([node('a', [codeEv(1)])]);
    expect(errorCodes(ir, { repoRoots: { web: tmpRoot } })).toEqual(['CODE_EVIDENCE_NOT_FOUND']);
  });

  it('(c) private 근거에 excerpt가 있으면 PRIVATE_EXCERPT_PRESENT', () => {
    const ev: Evidence = { ...codeEv(), visibility: 'private', excerpt: 'secret' };
    const ir = makeIr([node('a'), node('b')], [edge('e1', 'a', 'b', [ev])]);
    const result = validateArchitectureIr(ir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({
      code: 'PRIVATE_EXCERPT_PRESENT',
      edgeId: 'e1',
      evidenceIndex: 0,
    });
  });

  it('(d) 없는 노드를 가리키는 엣지는 DANGLING_EDGE', () => {
    const ir = makeIr([node('a')], [edge('e1', 'a', 'ghost', [codeEv()])]);
    expect(errorCodes(ir)).toEqual(['DANGLING_EDGE']);
  });

  it('(e) 근거 없는 엣지는 그리지 않고 autoUnresolved로 돌린다', () => {
    const ir = makeIr([node('a'), node('b')], [edge('e1', 'a', 'b', [], 'dashed')]);
    const result = validateArchitectureIr(ir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.drawableEdgeIds.has('e1')).toBe(false);
    expect(result.value.autoUnresolved).toHaveLength(1);
    expect(result.value.autoUnresolved[0]!.subject).toEqual({ edgeId: 'e1' });
  });

  it('(e) 근거 없는 노드와 거기 걸린 엣지를 그리지 않는다', () => {
    const ir = makeIr([node('a'), node('b', [])], [edge('e1', 'a', 'b', [codeEv()])]);
    const result = validateArchitectureIr(ir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.drawableNodeIds]).toEqual(['a']);
    expect(result.value.drawableEdgeIds.size).toBe(0);
    expect(result.value.autoUnresolved.map((q) => q.subject)).toEqual([{ nodeId: 'b' }]);
  });

  it('(e) 이미 같은 대상의 미해결 질문이 있으면 새로 만들지 않는다', () => {
    const ir = makeIr([node('a', [])]);
    ir.unresolved = [{ id: 'q1', subject: { nodeId: 'a' }, question: '어디 있나요?' }];
    const result = validateArchitectureIr(ir);
    expect(result.ok && result.value.autoUnresolved).toEqual([]);
  });
});

describe('validateArchitectureIr — 제품 그룹과 저장소', () => {
  it('그룹 멤버가 nodes에 없거나 그룹 id가 겹치면 거부한다', () => {
    const ir = makeIr([node('a'), node('b')]);
    ir.groups = [
      { id: 'g1', name: '쇼핑', members: ['a', 'ghost'] },
      { id: 'g1', name: '운영', members: ['b'] },
    ];
    expect(errorCodes(ir).sort()).toEqual(['DUPLICATE_GROUP_ID', 'GROUP_MEMBER_NOT_FOUND']);
  });

  it('테이블의 parent는 저장소 클러스터일 수 있다', () => {
    const store: ArchitectureNode = { ...node('ds:main'), kind: 'datastore', environment: 'prod' };
    const table: ArchitectureNode = { ...node('t:orders'), kind: 'db_table', parent: 'ds:main' };
    const wrong: ArchitectureNode = { ...node('t:items'), kind: 'db_table', parent: 'a' };
    expect(errorCodes(makeIr([store, table]))).toEqual([]);
    expect(errorCodes(makeIr([node('a'), wrong]))).toEqual(['INVALID_PARENT_KIND']);
  });
});

describe('redactForSharing', () => {
  it('private 근거는 type과 visibility만 남기고 public은 그대로 둔다', () => {
    const pub: Evidence = { ...codeEv(), excerpt: 'export default Home' };
    const priv: Evidence = {
      type: 'doc',
      location: 'notes/internal.md',
      visibility: 'private',
      excerpt: 'x',
    };
    const ir = makeIr([node('a', [pub, priv])]);
    const snapshot = structuredClone(ir);

    const redacted = redactForSharing(ir);
    expect(redacted.nodes[0]!.evidence[0]).toEqual(pub);
    expect(redacted.nodes[0]!.evidence[1]).toEqual({ type: 'doc', visibility: 'private' });
    expect(JSON.stringify(redacted)).not.toContain('notes/internal.md');
    expect(ir).toEqual(snapshot);
  });
});

describe('stripPrivateExcerpts', () => {
  it('private excerpt만 지우고 location과 public excerpt는 남긴다', () => {
    const pub: Evidence = { ...codeEv(), excerpt: 'export default Home' };
    const priv: Evidence = { ...codeEv(2), visibility: 'private', excerpt: 'secret' };
    const ir = makeIr([node('a')], []);
    ir.edges = [edge('e1', 'a', 'a', [pub, priv])];
    const snapshot = structuredClone(ir);

    const stripped = stripPrivateExcerpts(ir);
    expect(stripped.edges[0]!.evidence[0]).toEqual(pub);
    expect(stripped.edges[0]!.evidence[1]).toEqual({
      type: 'code',
      location: 'web:src/home.tsx:2',
      visibility: 'private',
    });
    expect(ir).toEqual(snapshot);
  });
});

describe('validateArchitectureIr parent', () => {
  const withKind = (
    id: string,
    kind: ArchitectureNode['kind'],
    parent?: string,
  ): ArchitectureNode => ({ ...node(id), kind, ...(parent !== undefined ? { parent } : {}) });

  const codesOf = (ir: ArchitectureIr): string[] => {
    const result = validateArchitectureIr(ir, { checkFiles: false });
    return result.ok ? [] : result.errors.map((e) => e.code);
  };

  it('screen은 feature나 service, feature는 service를 parent로 둘 수 있다', () => {
    const ir = makeIr([
      withKind('svc', 'service'),
      withKind('feat', 'feature', 'svc'),
      withKind('s1', 'screen', 'feat'),
      withKind('s2', 'screen', 'svc'),
    ]);
    expect(codesOf(ir)).toEqual([]);
  });

  it('nodes에 없는 parent는 PARENT_NOT_FOUND', () => {
    const result = validateArchitectureIr(makeIr([withKind('s1', 'screen', 'nope')]), {
      checkFiles: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        expect.objectContaining({ code: 'PARENT_NOT_FOUND', nodeId: 's1' }),
      ]);
    }
  });

  it('포함 규칙을 어기면 INVALID_PARENT_KIND', () => {
    expect(
      codesOf(makeIr([withKind('svc', 'service'), withKind('ep', 'endpoint', 'svc')])),
    ).toEqual(['INVALID_PARENT_KIND']);
    expect(codesOf(makeIr([withKind('s0', 'screen'), withKind('feat', 'feature', 's0')]))).toEqual([
      'INVALID_PARENT_KIND',
    ]);
    expect(
      codesOf(
        makeIr([
          withKind('f0', 'feature'),
          withKind('s1', 'screen', 'f0'),
          withKind('s2', 'screen', 's1'),
        ]),
      ),
    ).toEqual(['INVALID_PARENT_KIND']);
  });

  it('parent를 따라가다 자기로 돌아오면 PARENT_CYCLE', () => {
    const codes = codesOf(
      makeIr([
        withKind('a', 'feature', 'b'),
        withKind('b', 'feature', 'a'),
        withKind('c', 'screen', 'a'),
      ]),
    );
    expect(codes.filter((c) => c === 'PARENT_CYCLE')).toHaveLength(2);
    expect(codesOf(makeIr([withKind('self', 'screen', 'self')]))).toContain('PARENT_CYCLE');
  });
});
