import { INFRA_LEVEL_KINDS, type ArchitectureNode, type CloudProvider } from './types.js';

export interface InfraPlacement {
  provider: ReadonlyMap<string, CloudProvider>;
  region: ReadonlyMap<string, string>;
  /** 노드에 적은 값이나 물려받을 값끼리 서로 다른 노드 id. 정렬돼 있다 */
  conflicts: { provider: string[]; region: string[] };
}

type Field = 'provider' | 'region';

/**
 * 인프라 레벨 노드의 provider와 region. 적지 않았으면 placedIn, parent, account 순으로 물려받는다.
 * 인프라 레벨 kind가 아닌 노드는 건너뛰고 물려주지도 않는다
 */
export function resolveInfraPlacement(nodes: readonly ArchitectureNode[]): InfraPlacement {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isInfra = (n: ArchitectureNode | undefined): n is ArchitectureNode =>
    n !== undefined && INFRA_LEVEL_KINDS.includes(n.kind);
  const resolved = { provider: new Map<string, string>(), region: new Map<string, string>() };
  const conflicts = { provider: new Set<string>(), region: new Set<string>() };

  const resolve = (field: Field, id: string, visiting: Set<string>): string | undefined => {
    const memo = resolved[field];
    if (memo.has(id)) return memo.get(id);
    const node = byId.get(id);
    // parent 순환은 검증기가 따로 막는다. 여기서는 멈추기만 한다
    if (!isInfra(node) || visiting.has(id)) return undefined;
    visiting.add(id);
    const own = node[field];
    const inherited = [node.placedIn, node.parent, node.account]
      .filter((x): x is string => x !== undefined && isInfra(byId.get(x)))
      .map((x) => resolve(field, x, visiting))
      .filter((x): x is string => x !== undefined);
    visiting.delete(id);
    const candidates = own !== undefined ? [own, ...inherited] : inherited;
    if (new Set(candidates).size > 1) conflicts[field].add(id);
    const value = candidates[0];
    if (value !== undefined) memo.set(id, value);
    return value;
  };

  const ids = nodes
    .filter(isInfra)
    .map((n) => n.id)
    .sort();
  for (const id of ids) {
    resolve('provider', id, new Set());
    resolve('region', id, new Set());
  }
  const sorted = (s: Set<string>): string[] => [...s].sort();
  return {
    provider: resolved.provider as Map<string, CloudProvider>,
    region: resolved.region,
    conflicts: { provider: sorted(conflicts.provider), region: sorted(conflicts.region) },
  };
}
