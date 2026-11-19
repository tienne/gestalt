import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArchitectureStore,
  mergeWithPrevious,
  mergeWithPreviousDetailed,
  previousRunSummary,
  type ArchitectureEdge,
  type ArchitectureFlow,
  type ArchitectureIr,
  type ArchitectureNode,
} from '../../../src/architecture/index.js';
import { FAKE_PASSWORD, FAKE_TOKEN } from './fake-secrets.js';

let repoRoot: string;

beforeEach(() => {
  repoRoot = resolve('.gestalt-test', `architecture-store-${randomUUID()}`);
  mkdirSync(repoRoot, { recursive: true });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function node(
  id: string,
  label: string,
  overrides: Partial<ArchitectureNode> = {},
): ArchitectureNode {
  return { id, kind: 'screen', label, repo: 'acme-web', evidence: [], ...overrides };
}

function edge(
  id: string,
  from: string,
  to: string,
  overrides: Partial<ArchitectureEdge> = {},
): ArchitectureEdge {
  return { id, from, to, kind: 'calls', evidence: [], lineStyle: 'dashed', ...overrides };
}

function makeIr(overrides: Partial<ArchitectureIr> = {}): ArchitectureIr {
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'acme-web', name: 'acme-web', root: '/repo/acme-web' }],
    nodes: [],
    edges: [],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ArchitectureStore', () => {
  it('뷰와 대상별 경로를 .gestalt/architecture 아래로 잡는다', () => {
    const store = new ArchitectureStore(repoRoot);
    const dir = join(repoRoot, '.gestalt', 'architecture');
    expect(store.irPath('screen-chain')).toBe(join(dir, 'screen-chain.json'));
    expect(store.htmlPath('deploy-path', 'private')).toBe(join(dir, 'deploy-path.html'));
    expect(store.htmlPath('deploy-path', 'shared')).toBe(join(dir, 'deploy-path.shared.html'));
  });

  it('save 후 load하면 같은 IR이 돌아온다', () => {
    const store = new ArchitectureStore(repoRoot);
    const ir = makeIr({
      nodes: [node('n1', 'Home'), node('n2', 'Detail')],
      edges: [edge('e1', 'n1', 'n2')],
      unresolved: [{ id: 'q1', subject: { edgeId: 'e1' }, question: '정말 호출하나요?' }],
    });
    store.save(ir);
    expect(store.load('screen-chain')).toEqual(ir);
  });

  it('저장 파일에 private 근거의 excerpt가 남지 않는다', () => {
    const store = new ArchitectureStore(repoRoot);
    const ir = makeIr({
      nodes: [
        node('n1', 'Home', {
          evidence: [
            { type: 'doc', location: 'secret-doc', visibility: 'private', excerpt: 'SECRET-TEXT' },
            {
              type: 'code',
              location: 'acme-web:src/a.ts:1',
              visibility: 'public',
              excerpt: 'PUBLIC-TEXT',
            },
          ],
        }),
      ],
    });
    const path = store.save(ir);
    const raw = readFileSync(path, 'utf-8');
    expect(raw).not.toContain('SECRET-TEXT');
    expect(raw).toContain('PUBLIC-TEXT');
    // 넘긴 IR 자체는 건드리지 않는다
    expect(ir.nodes[0]!.evidence[0]!.excerpt).toBe('SECRET-TEXT');
  });

  it('저장 IR과 투영 파일에 비밀값이 남지 않는다', () => {
    const store = new ArchitectureStore(repoRoot);
    const ir = makeIr({
      nodes: [
        node('n1', 'Home', {
          description: `postgres://app:${FAKE_PASSWORD}@db:5432/app`,
          evidence: [
            {
              type: 'code',
              location: 'acme-web:src/a.ts:1',
              visibility: 'public',
              excerpt: `const token = "${FAKE_TOKEN}";`,
            },
          ],
        }),
      ],
      projections: [
        {
          id: 'p1',
          shape: 'sequence',
          title: '흐름',
          question: `키 ${FAKE_TOKEN}`,
          messages: [
            { id: 'm1', from: 'n1', to: 'n1', label: 'x', evidence: [], lineStyle: 'solid' },
          ],
        },
      ],
    });
    const raw = readFileSync(store.save(ir), 'utf-8');
    const views = store.saveViews(ir).map((p) => readFileSync(p, 'utf-8'));
    for (const text of [raw, ...views]) {
      expect(text).not.toContain(FAKE_TOKEN);
      expect(text).not.toContain(FAKE_PASSWORD);
    }
    expect(views).toHaveLength(1);
    expect(ir.nodes[0]!.evidence[0]!.excerpt).toContain(FAKE_TOKEN);
  });

  it('없는 뷰를 load하면 null', () => {
    expect(new ArchitectureStore(repoRoot).load('deploy-path')).toBeNull();
  });

  it('깨진 파일은 .corrupt-로 옮기고 null', () => {
    const store = new ArchitectureStore(repoRoot);
    const path = store.irPath('screen-chain');
    mkdirSync(join(repoRoot, '.gestalt', 'architecture'), { recursive: true });
    writeFileSync(path, '{ not json');
    expect(store.load('screen-chain')).toBeNull();
    expect(existsSync(path)).toBe(false);
    const files = readdirSync(join(repoRoot, '.gestalt', 'architecture'));
    expect(files.some((f) => f.startsWith('screen-chain.json.corrupt-'))).toBe(true);
  });

  it('스키마에 안 맞는 파일도 .corrupt-로 옮기고 null', () => {
    const store = new ArchitectureStore(repoRoot);
    const path = store.irPath('screen-chain');
    mkdirSync(join(repoRoot, '.gestalt', 'architecture'), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...makeIr(), nodes: [{ id: 'x', kind: 'unknown' }] }));
    expect(store.load('screen-chain')).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it('saveHtml은 대상별 파일에 쓴다', () => {
    const store = new ArchitectureStore(repoRoot);
    const path = store.saveHtml('screen-chain', 'shared', '<html></html>');
    expect(path).toBe(store.htmlPath('screen-chain', 'shared'));
    expect(readFileSync(path, 'utf-8')).toBe('<html></html>');
  });
});

describe('mergeWithPrevious', () => {
  it('재실행 IR의 노드와 엣지가 이전 id를 물려받는다', () => {
    const prev = makeIr({
      nodes: [node('old-home', 'Home'), node('old-detail', 'Detail Page')],
      edges: [edge('old-e', 'old-home', 'old-detail')],
    });
    const next = makeIr({
      nodes: [node('h', '  home '), node('d', 'detail   page'), node('new', 'Settings')],
      edges: [edge('e1', 'h', 'd'), edge('e2', 'h', 'new')],
      unresolved: [{ id: 'q1', subject: { nodeId: 'h', edgeId: 'e1' }, question: '?' }],
    });

    const merged = mergeWithPrevious(prev, next);

    expect(merged.nodes.map((n) => n.id)).toEqual(['old-home', 'old-detail', 'new']);
    expect(merged.edges).toEqual([
      edge('old-e', 'old-home', 'old-detail'),
      edge('e2', 'old-home', 'new'),
    ]);
    expect(merged.unresolved[0]!.subject).toEqual({ nodeId: 'old-home', edgeId: 'old-e' });
    // 입력은 바꾸지 않는다
    expect(next.nodes[0]!.id).toBe('h');
  });

  it('제품 그룹 멤버도 이전 id로 바꿔 단다', () => {
    const prev = makeIr({ nodes: [node('old-home', 'Home')] });
    const next = makeIr({
      nodes: [node('h', 'home'), node('new', 'Settings')],
      groups: [{ id: 'g1', name: '쇼핑', members: ['new', 'h'] }],
    });
    expect(mergeWithPrevious(prev, next).groups).toEqual([
      { id: 'g1', name: '쇼핑', members: ['new', 'old-home'] },
    ]);
  });

  it('표시 이름은 병합 키에 안 들어가 바뀌어도 id를 물려받고 next 값을 쓴다', () => {
    const prev = makeIr({
      nodes: [node('old-home', 'Home', { displayName: '홈', displayNameInferred: true })],
    });
    const next = makeIr({ nodes: [node('h', 'Home', { displayName: '메인 화면' })] });

    const merged = mergeWithPrevious(prev, next);

    expect(merged.nodes).toEqual([node('old-home', 'Home', { displayName: '메인 화면' })]);
  });

  it('parent도 물려받은 id로 바꾼다', () => {
    const prev = makeIr({ nodes: [node('old-svc', 'Shop', { kind: 'service' })] });
    const next = makeIr({
      nodes: [node('svc', 'Shop', { kind: 'service' }), node('h', 'Home', { parent: 'svc' })],
    });
    expect(mergeWithPrevious(prev, next).nodes.map((n) => [n.id, n.parent])).toEqual([
      ['old-svc', undefined],
      ['h', 'old-svc'],
    ]);
  });

  it('kind나 repo가 다르면 같은 label이어도 물려받지 않는다', () => {
    const prev = makeIr({ nodes: [node('old', 'Home', { kind: 'endpoint' })] });
    const next = makeIr({
      nodes: [node('a', 'Home'), node('b', 'Home', { kind: 'endpoint', repo: 'acme-api' })],
    });
    expect(mergeWithPrevious(prev, next).nodes.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('같은 키의 노드가 여럿이면 첫 번째만 물려받는다', () => {
    const prev = makeIr({ nodes: [node('old', 'Home')] });
    const next = makeIr({ nodes: [node('a', 'Home'), node('b', 'home')] });
    expect(mergeWithPrevious(prev, next).nodes.map((n) => n.id)).toEqual(['old', 'b']);
  });

  it('물려받을 id가 next의 다른 노드 id와 겹치면 바꾸지 않는다', () => {
    const prev = makeIr({ nodes: [node('x', 'Home')] });
    const next = makeIr({ nodes: [node('a', 'Home'), node('x', 'Other')] });
    expect(mergeWithPrevious(prev, next).nodes.map((n) => n.id)).toEqual(['a', 'x']);
  });

  it('답이 달린 이전 질문은 대상이 남아 있으면 유지하고 없어졌으면 버린다', () => {
    const prev = makeIr({
      nodes: [node('old-home', 'Home'), node('gone', 'Removed')],
      unresolved: [
        { id: 'q1', subject: { nodeId: 'old-home' }, question: '로그인 필요?', answer: '네' },
        { id: 'q2', subject: { nodeId: 'gone' }, question: '아직 쓰나요?', answer: '아니요' },
        { id: 'q3', subject: { nodeId: 'old-home' }, question: '답 없는 질문' },
      ],
    });
    const next = makeIr({ nodes: [node('h', 'Home')] });

    const merged = mergeWithPrevious(prev, next);

    expect(merged.unresolved).toEqual([
      { id: 'q1', subject: { nodeId: 'old-home' }, question: '로그인 필요?', answer: '네' },
    ]);
  });

  it('같은 대상에 같은 질문을 다시 물었으면 답만 옮긴다', () => {
    const prev = makeIr({
      nodes: [node('old-home', 'Home')],
      unresolved: [
        { id: 'q1', subject: { nodeId: 'old-home' }, question: '로그인 필요?', answer: '네' },
      ],
    });
    const next = makeIr({
      nodes: [node('h', 'Home')],
      unresolved: [{ id: 'q9', subject: { nodeId: 'h' }, question: '로그인 필요?' }],
    });
    expect(mergeWithPrevious(prev, next).unresolved).toEqual([
      { id: 'q9', subject: { nodeId: 'old-home' }, question: '로그인 필요?', answer: '네' },
    ]);
  });

  it('sourcesUsed와 generatedAt은 next 것을 쓴다', () => {
    const prev = makeIr({
      sourcesUsed: [
        { via: 'repo', identifier: 'old', readOnly: true, probeHit: true, visibility: 'public' },
      ],
    });
    const nextSources = [
      {
        via: 'mcp' as const,
        identifier: 'new',
        readOnly: true,
        probeHit: false,
        visibility: 'private' as const,
      },
    ];
    const next = makeIr({ sourcesUsed: nextSources, generatedAt: '2026-10-02T00:00:00.000Z' });
    const merged = mergeWithPrevious(prev, next);
    expect(merged.sourcesUsed).toEqual(nextSources);
    expect(merged.generatedAt).toBe('2026-10-02T00:00:00.000Z');
  });
});

function code(...locations: string[]): ArchitectureNode['evidence'] {
  return locations.map((location) => ({
    type: 'code' as const,
    location,
    visibility: 'public' as const,
  }));
}

function flow(id: string, refs: string[], stepId = `${id}-s1`): ArchitectureFlow {
  return {
    id,
    title: id,
    actors: [{ id: 'user', label: '사용자', kind: 'person' }],
    steps: [{ id: stepId, actor: 'user', label: '진입', refs, evidence: [] }],
    transitions: [],
  };
}

describe('mergeWithPreviousDetailed', () => {
  it('label과 id를 함께 바꿔도 code 근거 파일 집합이 같으면 이어서 설명과 답이 남는다', () => {
    const prev = makeIr({
      nodes: [
        node('old-list', 'Order List', {
          description: '주문 목록 화면',
          evidence: code('acme-web:src/orders/List.tsx:10', 'acme-web:src/orders/api.ts:3'),
        }),
        node('old-home', 'Home'),
      ],
      edges: [edge('old-e', 'old-home', 'old-list')],
      unresolved: [
        { id: 'q1', subject: { nodeId: 'old-list' }, question: '로그인 필요?', answer: '네' },
      ],
      projections: [
        {
          id: 'p1',
          title: '홈에서 목록',
          question: '홈에서 목록으로 어떻게 가나요?',
          shape: 'sequence',
          messages: [
            {
              id: 'm1',
              from: 'old-home',
              to: 'old-list',
              label: '이동',
              edge: 'old-e',
              evidence: [],
              lineStyle: 'dashed',
            },
          ],
        },
      ],
    });
    const next = makeIr({
      nodes: [
        node('orders', 'Orders', {
          // 줄 번호가 밀리고 순서가 바뀌어도 파일 집합이 같으면 같은 노드다
          evidence: code('acme-web:src/orders/api.ts:5', 'acme-web:src/orders/List.tsx:12'),
        }),
        node('h', 'Home'),
      ],
      edges: [edge('e1', 'h', 'orders')],
    });

    const { ir, report } = mergeWithPreviousDetailed(prev, next);

    expect(ir.nodes.map((n) => [n.id, n.label, n.description])).toEqual([
      ['old-list', 'Orders', '주문 목록 화면'],
      ['old-home', 'Home', undefined],
    ]);
    expect(ir.edges.map((e) => e.id)).toEqual(['old-e']);
    expect(ir.unresolved).toEqual([
      { id: 'q1', subject: { nodeId: 'old-list' }, question: '로그인 필요?', answer: '네' },
    ]);
    expect(ir.projections?.map((p) => p.id)).toEqual(['p1']);
    expect(report).toEqual({
      descriptionCarried: ['old-list'],
      relabeled: [
        { id: 'old-list', previousLabel: 'Order List', label: 'Orders', matchedBy: 'evidence' },
      ],
      flowsCarried: [],
      warnings: [],
    });
  });

  it('같은 id로 label만 바꾸면 id로 이어 설명과 답이 남는다', () => {
    const prev = makeIr({
      nodes: [node('list', 'Order List', { description: '주문 목록' })],
      unresolved: [{ id: 'q1', subject: { nodeId: 'list' }, question: '?', answer: '답' }],
    });
    const next = makeIr({ nodes: [node('list', 'Orders')] });

    const { ir, report } = mergeWithPreviousDetailed(prev, next);

    expect(ir.nodes).toEqual([node('list', 'Orders', { description: '주문 목록' })]);
    expect(ir.unresolved.map((q) => q.id)).toEqual(['q1']);
    expect(report.relabeled).toEqual([
      { id: 'list', previousLabel: 'Order List', label: 'Orders', matchedBy: 'id' },
    ]);
    expect(report.warnings).toEqual([]);
  });

  it('kind가 다르면 같은 id여도 2차 매칭으로 잇지 않는다', () => {
    const prev = makeIr({
      nodes: [node('x', 'Orders', { kind: 'endpoint', description: '설명' })],
    });
    const next = makeIr({ nodes: [node('x', 'Order List')] });
    const { ir, report } = mergeWithPreviousDetailed(prev, next);
    expect(ir.nodes[0]!.description).toBeUndefined();
    expect(report.relabeled).toEqual([]);
  });

  it('근거 파일이 같은 후보가 2:2로 모호하면 잇지 않고 LABEL_CHANGED_ID_LOST로 알린다', () => {
    const shared = code('acme-web:src/shared/page.tsx:1');
    const prev = makeIr({
      nodes: [
        node('old-a', 'Alpha', { description: '알파', evidence: shared }),
        node('old-b', 'Beta', { evidence: shared }),
      ],
      unresolved: [{ id: 'q1', subject: { nodeId: 'old-b' }, question: '?', answer: '답' }],
    });
    const next = makeIr({
      nodes: [
        node('a2', 'Alpha 2', { evidence: shared }),
        node('b2', 'Beta 2', { evidence: shared }),
      ],
    });

    const { ir, report } = mergeWithPreviousDetailed(prev, next);

    expect(ir.nodes.map((n) => [n.id, n.description])).toEqual([
      ['a2', undefined],
      ['b2', undefined],
    ]);
    expect(ir.unresolved).toEqual([]);
    expect(report.relabeled).toEqual([]);
    expect(
      report.warnings.map((w) => [w.code, w.code === 'LABEL_CHANGED_ID_LOST' && w.previousId]),
    ).toEqual([
      ['LABEL_CHANGED_ID_LOST', 'old-a'],
      ['LABEL_CHANGED_ID_LOST', 'old-b'],
    ]);
    expect(report.warnings[0]).toMatchObject({
      previousLabel: 'Alpha',
      kind: 'screen',
      repo: 'acme-web',
      candidates: ['a2', 'b2'],
    });
    expect(report.warnings[0]!.message).toContain('Alpha');
  });

  it('code 근거가 없으면 근거 파일로 잇지 않는다', () => {
    const prev = makeIr({ nodes: [node('old', 'Alpha', { description: '알파' })] });
    const next = makeIr({ nodes: [node('new', 'Beta')] });
    const { ir, report } = mergeWithPreviousDetailed(prev, next);
    expect(ir.nodes.map((n) => n.id)).toEqual(['new']);
    expect(report.warnings.map((w) => w.code)).toEqual(['LABEL_CHANGED_ID_LOST']);
  });

  it('남길 것이 없는 지난 노드나 같은 자리에 새 노드가 없으면 경고하지 않는다', () => {
    const prev = makeIr({
      nodes: [
        node('plain', 'Plain'),
        node('ep', 'GET /x', { kind: 'endpoint', description: '설명' }),
      ],
    });
    const next = makeIr({ nodes: [node('other', 'Other')] });
    expect(mergeWithPreviousDetailed(prev, next).report.warnings).toEqual([]);
  });

  it('description이 next에 없으면 이어받고 빈 문자열이면 지운 것으로 둔다', () => {
    const prev = makeIr({
      nodes: [
        node('old-a', 'A', { description: '에이' }),
        node('old-b', 'B', { description: '비' }),
        node('old-c', 'C', { description: '씨' }),
        node('old-d', 'D', { description: '  ' }),
      ],
    });
    const next = makeIr({
      nodes: [
        node('a', 'A'),
        node('b', 'B', { description: '' }),
        node('c', 'C', { description: '새 설명' }),
        node('d', 'D'),
      ],
    });

    const { ir, report } = mergeWithPreviousDetailed(prev, next);

    expect(ir.nodes.map((n) => [n.id, n.description])).toEqual([
      ['old-a', '에이'],
      ['old-b', ''],
      ['old-c', '새 설명'],
      ['old-d', undefined],
    ]);
    expect(report.descriptionCarried).toEqual(['old-a']);
  });

  it('next에 같은 병합 키가 여럿이고 prev에 그 키가 있으면 MERGE_KEY_DUPLICATE로 알린다', () => {
    const prev = makeIr({ nodes: [node('old', 'Home'), node('solo', 'Solo')] });
    const next = makeIr({
      nodes: [node('a', 'Home'), node('b', ' home '), node('n1', 'New'), node('n2', 'new')],
    });

    const { report } = mergeWithPreviousDetailed(prev, next);

    expect(report.warnings).toEqual([
      {
        code: 'MERGE_KEY_DUPLICATE',
        key: 'screen/acme-web/home',
        nodeIds: ['old', 'b'],
        message: expect.stringContaining('screen/acme-web/home') as string,
      },
    ]);
  });

  it('이번에 없는 지난 흐름은 가리키는 노드가 살아 있으면 이어 싣고 답 달린 단계 질문도 남긴다', () => {
    const prev = makeIr({
      nodes: [node('old-home', 'Home'), node('old-list', 'List')],
      flows: [flow('browse', ['old-home', 'old-list']), flow('kept', ['old-home'])],
      unresolved: [{ id: 'q1', subject: { stepId: 'browse-s1' }, question: '?', answer: '답' }],
    });
    const next = makeIr({
      nodes: [node('h', 'Home'), node('l', 'List')],
      flows: [flow('kept', ['h'], 'kept-new')],
    });

    const { ir, report } = mergeWithPreviousDetailed(prev, next);

    expect(ir.flows?.map((f) => f.id)).toEqual(['kept', 'browse']);
    expect(ir.flows?.[0]!.steps[0]!.refs).toEqual(['old-home']);
    expect(ir.flows?.[1]!.steps[0]!.refs).toEqual(['old-home', 'old-list']);
    expect(ir.unresolved.map((q) => q.id)).toEqual(['q1']);
    expect(report.flowsCarried).toEqual(['browse']);
  });

  it('next에 flows가 없어도 지난 흐름을 이어 싣는다', () => {
    const prev = makeIr({
      nodes: [node('old-home', 'Home')],
      flows: [flow('browse', ['old-home'])],
    });
    const next = makeIr({ nodes: [node('h', 'Home')] });
    expect(mergeWithPreviousDetailed(prev, next).ir.flows?.map((f) => f.id)).toEqual(['browse']);
  });

  it('지난 흐름이 가리키는 노드가 사라지거나 단계 id가 겹치면 이어 싣지 않는다', () => {
    const prev = makeIr({
      nodes: [node('old-home', 'Home'), node('gone', 'Removed')],
      flows: [flow('lost', ['old-home', 'gone']), flow('clash', ['old-home'], 'shared-step')],
    });
    const next = makeIr({
      nodes: [node('h', 'Home')],
      flows: [flow('now', ['h'], 'shared-step')],
    });

    const { ir, report } = mergeWithPreviousDetailed(prev, next);

    expect(ir.flows?.map((f) => f.id)).toEqual(['now']);
    expect(report.flowsCarried).toEqual([]);
  });

  it('같은 입력이면 같은 결과를 낸다', () => {
    const shared = code('acme-web:src/a.tsx:1');
    const prev = makeIr({
      nodes: [node('old-a', 'A', { description: '에이', evidence: shared }), node('old-b', 'B')],
      flows: [flow('f', ['old-a'])],
    });
    const next = makeIr({ nodes: [node('a2', 'A2', { evidence: shared }), node('b', 'B')] });
    expect(mergeWithPreviousDetailed(prev, next)).toEqual(mergeWithPreviousDetailed(prev, next));
    expect(mergeWithPrevious(prev, next)).toEqual(mergeWithPreviousDetailed(prev, next).ir);
  });
});

describe('previousRunSummary', () => {
  it('개수와 열린 질문 수를 센다', () => {
    const prev = makeIr({
      nodes: [node('a', 'A'), node('b', 'B')],
      edges: [edge('e', 'a', 'b')],
      unresolved: [
        { id: 'q1', subject: {}, question: '?', answer: '답' },
        { id: 'q2', subject: {}, question: '?' },
        { id: 'q3', subject: {}, question: '?', answer: '  ' },
      ],
    });
    expect(previousRunSummary(prev)).toEqual({
      generatedAt: prev.generatedAt,
      nodeCount: 2,
      edgeCount: 1,
      unresolvedOpen: 2,
      sourcesUsed: [],
    });
  });
});
