import { compareEnvironment } from './layout.js';
import { PLATFORMS, type ArchitectureEdge, type ArchitectureNode, type Platform } from './types.js';

export interface ServiceDomain {
  id: string;
  label: string;
  environment?: string;
}

/** 서비스 카드와 패널이 그래프에서 끌어내 보여주는 사실 */
export interface ServiceFacts {
  /** 웹, AOS, iOS 순서로 고정. 근거가 있는 것만 든다 */
  platforms: Platform[];
  /** 이 서비스를 서빙하는 버킷 id. 웹 판정의 근거다 */
  servingBuckets: string[];
  /** 버킷 → CDN → 도메인을 거슬러 닿은 도메인. 환경 순서로 정렬한다 */
  domains: ServiceDomain[];
  /** environment가 prod인 첫 도메인 */
  prodDomain?: string;
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 그릴 노드와 엣지만 받아 서비스마다 플랫폼과 도메인을 낸다.
 * 웹은 버킷이 serves로 서빙하거나 platformEvidence.web이 있을 때, android와 ios는 platforms에 있고 근거가 있을 때만 든다
 */
export function computeServiceFacts(
  nodes: readonly ArchitectureNode[],
  edges: readonly ArchitectureEdge[],
): Map<string, ServiceFacts> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kindOf = (id: string): string | undefined => byId.get(id)?.kind;
  const incoming = (kind: ArchitectureEdge['kind'], to: string, fromKind: string): string[] =>
    edges
      .filter((e) => e.kind === kind && e.to === to && kindOf(e.from) === fromKind)
      .map((e) => e.from);

  const out = new Map<string, ServiceFacts>();
  for (const n of [...nodes].sort((a, b) => compareStr(a.id, b.id))) {
    if (n.kind !== 'service') continue;
    const buckets = [...new Set(incoming('serves', n.id, 'bucket'))].sort(compareStr);
    const cdns = new Set(buckets.flatMap((b) => incoming('origin', b, 'cdn')));
    const domainIds = new Set([...cdns].flatMap((c) => incoming('resolves_to', c, 'domain')));
    const domains = [...domainIds]
      .map((id) => byId.get(id)!)
      .map((d) => ({
        id: d.id,
        label: d.label,
        ...(d.environment !== undefined ? { environment: d.environment } : {}),
      }))
      .sort(
        (a, b) =>
          compareEnvironment(a.environment, b.environment) ||
          compareStr(a.label, b.label) ||
          compareStr(a.id, b.id),
      );
    const evidenced = (p: Platform): boolean => (n.platformEvidence?.[p] ?? []).length > 0;
    const listed = new Set(n.platforms ?? []);
    const platforms = PLATFORMS.filter((p) =>
      p === 'web' ? buckets.length > 0 || evidenced('web') : listed.has(p) && evidenced(p),
    );
    const prod = domains.find((d) => d.environment === 'prod');
    out.set(n.id, {
      platforms,
      servingBuckets: buckets,
      domains,
      ...(prod !== undefined ? { prodDomain: prod.label } : {}),
    });
  }
  return out;
}
