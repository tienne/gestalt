import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArchitectureStore,
  mergeWithPrevious,
  previousRunSummary,
  type ArchitectureEdge,
  type ArchitectureIr,
  type ArchitectureNode,
} from '../../../src/architecture/index.js';

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
