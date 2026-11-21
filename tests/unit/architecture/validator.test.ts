import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARCHITECTURE_VALIDATION_ERROR_CODES,
  SECRET_MASK,
  isPathlikeTitle,
  maskIrSecrets,
  redactForSharing,
  stripPrivateExcerpts,
  validateArchitectureIr,
  type ArchitectureEdge,
  type ArchitectureIr,
  type ArchitectureNode,
  type Evidence,
} from '../../../src/architecture/index.js';
import { FAKE_PASSWORD, FAKE_TOKEN } from './fake-secrets.js';
import {
  deployIr,
  flowIr,
  harnessIr,
  partnerIr,
  webIr,
} from '../../fixtures/architecture-legacy/irs.js';

const tmpRoot = resolve('.gestalt-test', `architecture-validator-${randomUUID()}`);
const repoRoot = join(tmpRoot, 'acme-web');

beforeAll(() => {
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src/home.tsx'), 'line1\nline2\nline3\n');
  writeFileSync(
    join(repoRoot, 'src/shifted.ts'),
    'pad\npad\nexport function foo() {\n  return 1;\n}\n',
  );
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

function warningsOf(ir: ArchitectureIr) {
  const result = validateArchitectureIr(ir);
  expect(result.ok).toBe(true);
  return result.ok
    ? result.value.warnings.filter((w) => w.code === 'CODE_EVIDENCE_EXCERPT_MISMATCH')
    : [];
}

const excerptEv = (
  line: number,
  excerpt?: string,
  visibility: Evidence['visibility'] = 'public',
): Evidence => ({
  type: 'code',
  location: `web:src/shifted.ts:${line}`,
  visibility,
  ...(excerpt !== undefined ? { excerpt } : {}),
});

describe('code 근거 excerpt 대조 (이슈 #57)', () => {
  it('줄이 밀린 근거에는 후보 줄이 담긴 경고가 나오고 오류는 아니다', () => {
    const warnings = warningsOf(makeIr([node('a', [excerptEv(1, 'export function foo(')])]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: 'CODE_EVIDENCE_EXCERPT_MISMATCH',
      nodeId: 'a',
      evidenceIndex: 0,
      candidates: [3],
    });
    expect(warnings[0]!.message).toContain('3');
  });

  it('근처에서도 못 찾으면 후보 없는 경고가 나온다', () => {
    const warnings = warningsOf(makeIr([node('a', [excerptEv(1, 'nowhere()')])]));
    expect(warnings).toMatchObject([{ candidates: [] }]);
  });

  it('저장 IR에서 다시 들어온 가린 excerpt는 가린 자리 앞까지만 맞춘다', () => {
    expect(warningsOf(makeIr([node('a', [excerptEv(3, 'export function [비밀값]')])]))).toEqual([]);
    const moved = warningsOf(makeIr([node('a', [excerptEv(1, 'export function [비밀값]')])]));
    expect(moved).toMatchObject([{ candidates: [3] }]);
  });

  it('줄이 excerpt로 시작하면 경고가 없다', () => {
    expect(warningsOf(makeIr([node('a', [excerptEv(3, 'export function foo(')])]))).toEqual([]);
  });

  it('excerpt가 없는 근거와 private 근거에는 경고가 없다', () => {
    expect(warningsOf(makeIr([node('a', [excerptEv(1)])]))).toEqual([]);
    // private 근거의 excerpt는 PRIVATE_EXCERPT_PRESENT 오류이고 대조 경고는 따로 나지 않는다
    const privateIr = makeIr([node('a', [excerptEv(1, 'export function foo(', 'private')])]);
    expect(errorCodes(privateIr)).toEqual(['PRIVATE_EXCERPT_PRESENT']);
  });

  it('checkFiles=false면 대조하지 않는다', () => {
    const result = validateArchitectureIr(
      makeIr([node('a', [excerptEv(1, 'export function foo(')])]),
      {
        checkFiles: false,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.map((w) => w.code)).not.toContain(
      'CODE_EVIDENCE_EXCERPT_MISMATCH',
    );
  });
});

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

  it('계정 ID 가림 뒤에 글자 칸의 비밀값도 가린다', () => {
    const pub: Evidence = { ...codeEv(), excerpt: `const token = "${FAKE_TOKEN}";` };
    const n: ArchitectureNode = {
      ...node('a', [pub]),
      description: `계정 123456789012 에서 postgres://app:${FAKE_PASSWORD}@db:5432/app 로 붙는다`,
    };
    const ir = makeIr([n]);
    ir.unresolved = [{ id: 'q1', subject: { nodeId: 'a' }, question: `키 ${FAKE_TOKEN} 맞나요?` }];
    const snapshot = structuredClone(ir);

    const text = JSON.stringify(redactForSharing(ir));
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(FAKE_PASSWORD);
    expect(text).toContain(SECRET_MASK);
    expect(text).toContain('[계정 ID]');
    expect(ir).toEqual(snapshot);
  });

  it('노드 summary와 IR summary, note도 description처럼 가린다', () => {
    const n: ArchitectureNode = {
      ...node('a'),
      summary: `계정 123456789012 의 키 ${FAKE_TOKEN}`,
    };
    const ir = makeIr([n]);
    ir.summary = `계정 210987654321 전체 요약 ${FAKE_TOKEN}`;
    ir.note = `배포 E2ABCDEFGHIJKL 일러두기 postgres://app:${FAKE_PASSWORD}@db:5432/app`;
    const snapshot = structuredClone(ir);

    const redacted = redactForSharing(ir);
    expect(JSON.stringify(redacted)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(redacted)).not.toContain(FAKE_PASSWORD);
    expect(redacted.nodes[0]!.summary).toContain('[계정 ID]');
    expect(redacted.nodes[0]!.summary).toContain(SECRET_MASK);
    expect(redacted.summary).toContain('[계정 ID]');
    expect(redacted.summary).toContain(SECRET_MASK);
    expect(redacted.note).not.toContain('E2ABCDEFGHIJKL');
    expect(redacted.note).toContain(SECRET_MASK);
    expect(ir).toEqual(snapshot);
  });

  it('summary와 note가 없으면 공유본에도 키가 안 생긴다', () => {
    const ir = makeIr([node('a')]);
    const redacted = redactForSharing(ir);
    expect('summary' in redacted).toBe(false);
    expect('note' in redacted).toBe(false);
    expect('summary' in redacted.nodes[0]!).toBe(false);
  });
});

describe('maskIrSecrets', () => {
  it('글자 칸마다 가리고 hits에는 위치만 담는다', () => {
    const n: ArchitectureNode = {
      ...node('a', [{ ...codeEv(), excerpt: `token: "${FAKE_TOKEN}"` }]),
      displayName: FAKE_TOKEN,
      columns: [{ name: 'id', type: `varchar ${FAKE_TOKEN}` }],
    };
    const ir = makeIr([n], [edge('e1', 'a', 'a', [{ ...codeEv(), excerpt: FAKE_TOKEN }])]);
    ir.flows = [
      {
        id: 'f1',
        title: '결제',
        actors: [{ id: 'u', label: '고객', kind: 'person' }],
        steps: [{ id: 's1', actor: 'u', label: FAKE_TOKEN, evidence: [] }],
        transitions: [],
      },
    ];
    ir.projections = [
      {
        id: 'p1',
        shape: 'sequence',
        title: '흐름',
        question: FAKE_TOKEN,
        messages: [
          {
            id: 'm1',
            from: 'a',
            to: 'a',
            label: FAKE_TOKEN,
            evidence: [],
            lineStyle: 'solid',
          },
        ],
      },
    ];
    ir.unresolved = [{ id: 'q1', subject: { nodeId: 'a' }, question: '?', answer: FAKE_TOKEN }];
    ir.stages = [{ id: 'st', label: FAKE_TOKEN }];
    ir.groups = [{ id: 'g', name: FAKE_TOKEN, members: ['a'] }];
    const snapshot = structuredClone(ir);

    const { ir: masked, hits } = maskIrSecrets(ir);
    expect(JSON.stringify(masked)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(hits)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(hits)).not.toContain(FAKE_TOKEN.slice(4, 12));
    expect(hits).toEqual(
      expect.arrayContaining([
        { nodeId: 'a', field: 'displayName' },
        { nodeId: 'a', field: 'evidence[0].excerpt' },
        { nodeId: 'a', field: 'columns[0].type' },
        { edgeId: 'e1', field: 'evidence[0].excerpt' },
        { flowId: 'f1', field: 'steps[s1].label' },
        { projectionId: 'p1', field: 'question' },
        { projectionId: 'p1', field: 'messages[m1].label' },
        { questionId: 'q1', field: 'answer' },
        { stageId: 'st', field: 'label' },
        { groupId: 'g', field: 'name' },
      ]),
    );
    expect(hits).toHaveLength(10);
    expect(ir).toEqual(snapshot);
  });

  it('비밀값이 없으면 같은 객체를 돌려준다', () => {
    const ir = makeIr([node('a', [{ ...codeEv(), excerpt: 'export default Home' }])]);
    const r = maskIrSecrets(ir);
    expect(r.ir).toBe(ir);
    expect(r.hits).toEqual([]);
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

describe('validateArchitectureIr description 경고', () => {
  const withDesc = (id: string, description?: string): ArchitectureNode => ({
    ...node(id),
    ...(description !== undefined ? { description } : {}),
  });

  function warningsOf(ir: ArchitectureIr): NonNullable<ReturnType<typeof okValue>>['warnings'] {
    return okValue(ir)!.warnings;
  }
  function okValue(ir: ArchitectureIr) {
    const r = validateArchitectureIr(ir);
    return r.ok ? r.value : undefined;
  }

  it('description이 비었거나 공백뿐인 노드를 코드 하나에 묶고 nodeIds를 정렬한다', () => {
    const ir = makeIr([
      withDesc('zeta'),
      withDesc('alpha', '   '),
      withDesc('mid', '있어요.'),
      withDesc('beta', ''),
    ]);
    const w = warningsOf(ir);
    expect(w).toHaveLength(1);
    expect(w[0]!.code).toBe('NODE_DESCRIPTION_MISSING');
    expect(w[0]!.nodeIds).toEqual(['alpha', 'beta', 'zeta']);
    expect(w[0]!.message).toContain('3개');
  });

  it('근거가 없어 안 그려지는 노드는 경고 대상이 아니다', () => {
    const ir = makeIr([withDesc('shown'), { ...withDesc('ghost'), evidence: [] }]);
    const result = validateArchitectureIr(ir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.drawableNodeIds.has('ghost')).toBe(false);
    expect(result.value.warnings[0]!.nodeIds).toEqual(['shown']);
  });

  it('전부 채우면 경고가 빈 배열이다', () => {
    expect(warningsOf(makeIr([withDesc('a', '하나예요.'), withDesc('b', '둘이에요.')]))).toEqual(
      [],
    );
  });

  it('경고가 있어도 ok:true이고 그릴 노드는 그대로다', () => {
    const result = validateArchitectureIr(makeIr([withDesc('a'), withDesc('b')]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.drawableNodeIds]).toEqual(['a', 'b']);
    expect(result.value.warnings).toHaveLength(1);
  });

  it('경고를 IR에 저장하는 자동 질문에 섞지 않는다', () => {
    const result = validateArchitectureIr(makeIr([withDesc('a')]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.autoUnresolved).toEqual([]);
    expect(JSON.stringify(result.value.ir)).not.toContain('NODE_DESCRIPTION_MISSING');
  });
});

describe('없는 id에 붙는 제안 하나', () => {
  function errorsOf(ir: ArchitectureIr) {
    const result = validateArchitectureIr(ir);
    return result.ok ? [] : result.errors;
  }

  it('DANGLING_EDGE는 가장 가까운 노드 id 하나를 제안한다', () => {
    const ir = makeIr(
      [node('svc-orders'), node('svc-users')],
      [edge('e1', 'svc-users', 'svc-order', [codeEv()])],
    );
    const [error] = errorsOf(ir);
    expect(error).toMatchObject({ code: 'DANGLING_EDGE', suggestion: 'svc-orders' });
    expect(error!.message).toContain('"svc-orders"');
  });

  it('가까운 id가 없으면 제안을 비운다', () => {
    const ir = makeIr([node('a')], [edge('e1', 'a', 'completely-different', [codeEv()])]);
    const [error] = errorsOf(ir);
    expect(error?.code).toBe('DANGLING_EDGE');
    expect(error?.suggestion).toBeUndefined();
  });

  it('PARENT_NOT_FOUND도 제안 하나를 붙인다', () => {
    const child: ArchitectureNode = { ...node('s1'), parent: 'feat-cart' };
    const parent: ArchitectureNode = { ...node('feat-carts'), kind: 'feature' };
    const errors = errorsOf(makeIr([child, parent]));
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'PARENT_NOT_FOUND', suggestion: 'feat-carts' }),
    );
  });
});

describe('에러 코드 배열', () => {
  it('겹치는 코드가 없다', () => {
    expect(new Set(ARCHITECTURE_VALIDATION_ERROR_CODES).size).toBe(
      ARCHITECTURE_VALIDATION_ERROR_CODES.length,
    );
  });
});

describe('옮겨진 근거 파일의 movedTo 후보', () => {
  const movedEv: Evidence = {
    type: 'code',
    location: 'web:src/old-home.tsx:2',
    visibility: 'public',
  };

  function notFound(opts: Parameters<typeof validateArchitectureIr>[1]) {
    const result = validateArchitectureIr(makeIr([node('a', [movedEv])]), opts);
    expect(result.ok).toBe(false);
    return result.ok ? undefined : result.errors.find((e) => e.code === 'CODE_EVIDENCE_NOT_FOUND');
  }

  it('findMoved가 지금 있는 파일을 돌려주면 위치 후보를 싣는다', () => {
    const calls: string[] = [];
    const error = notFound({
      findMoved: (repoId, _root, relPath) => {
        calls.push(`${repoId}:${relPath}`);
        return ['src/home.tsx'];
      },
    });
    expect(calls).toEqual(['web:src/old-home.tsx']);
    expect(error?.movedTo).toEqual(['web:src/home.tsx:2']);
    expect(error?.message).toContain('web:src/home.tsx:2');
  });

  it('후보 파일이 지금도 없으면 버린다', () => {
    const error = notFound({ findMoved: () => ['src/also-gone.tsx'] });
    expect(error?.movedTo).toBeUndefined();
  });

  it('findMoved가 없거나 던지면 예전처럼 에러만 낸다', () => {
    expect(notFound({})?.movedTo).toBeUndefined();
    const error = notFound({
      findMoved: () => {
        throw new Error('git 없음');
      },
    });
    expect(error?.code).toBe('CODE_EVIDENCE_NOT_FOUND');
    expect(error?.movedTo).toBeUndefined();
  });
});

describe('문서의 에러 코드 표', () => {
  it('docs/architecture-view.md 검증 규칙 표가 validator 에러 코드와 같다', () => {
    const doc = readFileSync(resolve('docs/architecture-view.md'), 'utf-8');
    const start = doc.indexOf('## 검증 규칙');
    const end = doc.indexOf('`checkFiles: false`', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = doc.slice(start, end);
    const documented = [...section.matchAll(/^\| `([A-Z_]+)` +\|/gm)].map((m) => m[1]!);
    expect([...documented].sort()).toEqual([...ARCHITECTURE_VALIDATION_ERROR_CODES].sort());
    expect(documented).toHaveLength(54);
    expect(section).toContain('아래 쉰넷은 IR 전체를 거부한다');
  });
});

describe('작성 품질 경고 (카드 제목, 표시 이름 언어, 레벨 요약, 단계 설명)', () => {
  function warningOf(ir: ArchitectureIr, code: string) {
    const result = validateArchitectureIr(ir);
    expect(result.ok).toBe(true);
    if (!result.ok) return undefined;
    return result.value.warnings.find((w) => w.code === code) as
      | {
          code: string;
          nodeIds?: string[];
          levelIds?: string[];
          flowId?: string;
          stepIds?: string[];
        }
      | undefined;
  }
  const titled = (
    id: string,
    label: string,
    extra: Partial<ArchitectureNode> = {},
  ): ArchitectureNode => ({ ...node(id), label, description: '하는 일이에요.', ...extra });

  it('isPathlikeTitle은 경로와 파일 이름, scheme:경로를 잡고 사람 이름과 프레임워크 이름은 거른다', () => {
    for (const t of [
      'src/interview/engine.ts',
      'memory.json',
      'sqlite:.gestalt/events.db',
      'SKILL.md',
      'C:\\dir\\a.ts',
      'sqlite:events.db',
      'classpath:application.yml',
      'app.sh',
    ]) {
      expect(isPathlikeTitle(t), t).toBe(true);
    }
    for (const t of [
      '주문 서버',
      'OrderService',
      'Next.js',
      'Node.js',
      'v1.2',
      '로그인/회원가입',
      '',
      'kafka:orders',
      'redis:cache',
      'queue:emails',
    ]) {
      expect(isPathlikeTitle(t), t).toBe(false);
    }
  });

  it('displayName이 없고 label이 경로인 노드를 잡고 엔드포인트와 표시 이름을 단 노드는 뺀다', () => {
    const ir = makeIr([
      titled('b-file', 'src/b.ts'),
      titled('a-file', 'memory.json'),
      titled('named', 'src/c.ts', { displayName: '기억 저장' }),
      titled('ep', 'GET /items', { kind: 'endpoint' }),
      titled('plain', 'OrderService'),
    ]);
    const w = warningOf(ir, 'NODE_TITLE_PATHLIKE');
    expect(w?.nodeIds).toEqual(['a-file', 'b-file']);
  });

  it('displayName 자체가 경로면 그것도 잡는다', () => {
    const w = warningOf(
      makeIr([titled('x', 'x', { displayName: 'lib/x.ts' })]),
      'NODE_TITLE_PATHLIKE',
    );
    expect(w?.nodeIds).toEqual(['x']);
  });

  it('설명 글이 대부분 한글이면 한글 없는 displayName을 잡는다', () => {
    const ir = makeIr([
      titled('en', 'svc', { displayName: 'Order Service' }),
      titled('ko', 'svc2', { displayName: '주문 서버' }),
      titled('none', 'svc3'),
    ]);
    expect(warningOf(ir, 'DISPLAY_NAME_LANGUAGE')?.nodeIds).toEqual(['en']);
  });

  it('설명 글이 대부분 영어면 표시 이름 언어를 묻지 않는다', () => {
    const ir = makeIr([
      titled('en', 'svc', { displayName: 'Order Service', description: 'Handles orders.' }),
      titled('en2', 'svc2', { displayName: 'Cart', description: 'Keeps the cart.' }),
    ]);
    expect(warningOf(ir, 'DISPLAY_NAME_LANGUAGE')).toBeUndefined();
  });

  it('그려지는 흐름의 설명 없는 단계를 흐름마다 한 건씩 낸다', () => {
    const ir = makeIr([titled('a', 'a')]);
    ir.flows = [
      {
        id: 'f1',
        title: '결제',
        actors: [{ id: 'u', label: '고객', kind: 'person' }],
        steps: [
          { id: 's1', actor: 'u', label: '담기', evidence: [codeEv()] },
          {
            id: 's2',
            actor: 'u',
            label: '결제',
            evidence: [codeEv()],
            description: '카드로 낸다.',
          },
          { id: 's3', actor: 'u', label: '근거 없음', evidence: [] },
        ],
        transitions: [],
      },
    ];
    const w = warningOf(ir, 'FLOW_STEP_DESCRIPTION_MISSING');
    expect(w?.flowId).toBe('f1');
    // 근거 없어 안 그려지는 단계는 묻지 않는다
    expect(w?.stepIds).toEqual(['s1']);
  });

  it('드릴다운 그림에서 요약 없는 레벨과 그 레벨을 여는 노드를 알린다', () => {
    const svc: ArchitectureNode = {
      ...titled('svc', 'shop'),
      kind: 'service',
      displayName: '가게',
    };
    const child = { ...titled('home', 'home'), parent: 'svc' };
    const ir = makeIr([svc, child]);
    const w = warningOf(ir, 'LEVEL_SUMMARY_MISSING');
    expect(w?.levelIds).toEqual(expect.arrayContaining(['root']));
    expect(w?.nodeIds).toContain('svc');

    const filled = makeIr([{ ...svc, summary: '가게 서비스예요.' }, child]);
    filled.summary = '가게 하나를 그린 그림이에요.';
    expect(warningOf(filled, 'LEVEL_SUMMARY_MISSING')).toBeUndefined();
  });

  it('summary와 note가 없는 예전 픽스처는 경고만 받고 막히지 않는다', () => {
    for (const ir of [webIr(), flowIr(), harnessIr(), deployIr(), partnerIr()]) {
      const result = validateArchitectureIr(ir, { checkFiles: false });
      expect(result.ok, ir.view).toBe(true);
      if (!result.ok) continue;
      // 경고는 코드마다 한 건이다. 흐름 단계 경고만 흐름마다 한 건이다
      const codes = result.value.warnings
        .map((w) => w.code)
        .filter((c) => c !== 'FLOW_STEP_DESCRIPTION_MISSING');
      expect(new Set(codes).size).toBe(codes.length);
    }
  });

  it('드릴다운이 없는 평면 그림은 레벨 요약을 묻지 않고 예전 IR도 ok다', () => {
    const result = validateArchitectureIr(makeIr([titled('a', 'a')]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.map((w) => w.code)).not.toContain('LEVEL_SUMMARY_MISSING');
  });
});
