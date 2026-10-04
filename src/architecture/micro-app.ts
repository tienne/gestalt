import type { ArchitectureEdge, ArchitectureNode } from './types.js';

/** 마이크로 프론트엔드 묶음을 그래프에서 읽은 결과 */
export interface MicroAppIndex {
  /** service id → parent로 달린 micro_app id. id 순이다 */
  appsOf: Map<string, string[]>;
  /** 들어오는 loads가 없는 micro_app. 사용자가 받는 진입 도메인은 이 앱 것이다 */
  hosts: Set<string>;
  /** service id → 진입 앱. 호스트가 하나일 때만 정한다. 여럿이거나 없으면 어느 쪽이 진입인지 모른다 */
  entryOf: Map<string, string>;
  /** micro_app → micro_app loads. id 순이다 */
  loads: ArchitectureEdge[];
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 호스트와 리모트를 따로 적게 하지 않고 loads에서 끌어낸다. 리모트는 누군가 불러와야 뜨는 앱이라
 * 들어오는 loads가 있으면 리모트, 없으면 호스트다. 근거 줄도 호스트 쪽 remotes 설정 하나로 끝난다
 */
export function indexMicroApps(
  nodes: readonly ArchitectureNode[],
  edges: readonly ArchitectureEdge[],
): MicroAppIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isApp = (id: string): boolean => byId.get(id)?.kind === 'micro_app';
  const loads = edges
    .filter((e) => e.kind === 'loads' && isApp(e.from) && isApp(e.to))
    .sort((a, b) => compareStr(a.id, b.id));
  const loaded = new Set(loads.map((e) => e.to));
  const appsOf = new Map<string, string[]>();
  const hosts = new Set<string>();
  for (const n of [...nodes].sort((a, b) => compareStr(a.id, b.id))) {
    if (n.kind !== 'micro_app') continue;
    if (!loaded.has(n.id)) hosts.add(n.id);
    const parent = n.parent !== undefined ? byId.get(n.parent) : undefined;
    if (parent?.kind !== 'service') continue;
    appsOf.set(parent.id, [...(appsOf.get(parent.id) ?? []), n.id]);
  }
  const entryOf = new Map<string, string>();
  for (const [service, apps] of appsOf) {
    const entries = apps.filter((a) => hosts.has(a));
    if (entries.length === 1) entryOf.set(service, entries[0]!);
  }
  return { appsOf, hosts, entryOf, loads };
}

/** 서비스 안 앱 순서. 진입 앱이 맨 앞이고 나머지는 id 순이다 */
export function orderedApps(index: MicroAppIndex, serviceId: string): string[] {
  const apps = index.appsOf.get(serviceId) ?? [];
  const entry = index.entryOf.get(serviceId);
  return entry === undefined ? apps : [entry, ...apps.filter((a) => a !== entry)];
}
