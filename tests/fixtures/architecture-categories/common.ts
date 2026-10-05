import type {
  ArchitectureEdge,
  ArchitectureIr,
  ArchitectureNode,
  Evidence,
} from '../../../src/architecture/index.js';

// 카테고리별 가짜 IR이 같이 쓰는 빌더. 모든 이름은 가공이다

export const code = (location: string): Evidence => ({
  type: 'code',
  location,
  visibility: 'public',
});
export const doc = (location: string): Evidence => ({
  type: 'doc',
  location,
  visibility: 'public',
});
export const user = (location: string): Evidence => ({
  type: 'user',
  location,
  visibility: 'public',
});

export function node(
  id: string,
  kind: ArchitectureNode['kind'],
  extra: Partial<ArchitectureNode> = {},
): ArchitectureNode {
  return { id, kind, label: id, repo: 'app', evidence: [code(`app:src/${id}.ts:1`)], ...extra };
}

export function edge(
  id: string,
  from: string,
  to: string,
  kind: ArchitectureEdge['kind'],
  evidence: Evidence[] = [code(`app:src/${id}.ts:2`)],
): ArchitectureEdge {
  const lineStyle = evidence.some((e) => e.type === 'code' || e.type === 'spec')
    ? 'solid'
    : 'dashed';
  return { id, from, to, kind, evidence, lineStyle };
}

export function base(packs?: string[]): Omit<ArchitectureIr, 'nodes' | 'edges'> {
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    ...(packs !== undefined ? { packs } : {}),
    repos: [{ id: 'app', name: 'acme-app', root: '/srv/acme-app' }],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}
