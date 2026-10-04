import { compareEnvironment } from './layout.js';
import {
  PLATFORMS,
  type ArchitectureEdge,
  type ArchitectureNode,
  type Platform,
  type WebHosting,
} from './types.js';

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
  /** 이 서비스를 서빙하는 배포 대상(SSR 서버) id */
  servingTargets: string[];
  /** prod 서빙 노드로 정한 서빙 방식. 서빙 노드가 없으면 비운다 */
  webHosting?: WebHosting;
  /** 서빙 노드에서 CDN, 도메인을 거슬러 닿은 도메인. 환경 순서로 정렬한다 */
  domains: ServiceDomain[];
  /** environment가 prod인 첫 도메인 */
  prodDomain?: string;
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 그릴 노드와 엣지만 받아 서비스마다 플랫폼과 도메인을 낸다.
 * 웹은 버킷이나 배포 대상이 serves로 서빙하거나 platformEvidence.web이 있을 때, android와 ios는 platforms에 있고 근거가 있을 때만 든다.
 * 서빙 방식은 prod(또는 환경 없는) 서빙 노드로 정하고 그런 노드가 없을 때만 다른 환경을 본다.
 * 배포 대상이 하나라도 서빙하면 SSR이다. SSR 앱도 정적 에셋은 버킷에 올리는 경우가 흔해서다
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
    const targets = [...new Set(incoming('serves', n.id, 'deploy_target'))].sort(compareStr);
    const servers = [...buckets, ...targets];
    const cdns = new Set(servers.flatMap((s) => incoming('origin', s, 'cdn')));
    // SSR 서버는 CDN 없이 로드 밸런서로 도메인을 바로 받는 경우가 있다
    const domainIds = new Set(
      [...cdns, ...targets].flatMap((c) => incoming('resolves_to', c, 'domain')),
    );
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
      p === 'web' ? servers.length > 0 || evidenced('web') : listed.has(p) && evidenced(p),
    );
    const prod = domains.find((d) => d.environment === 'prod');
    const hosting = webHostingOf(buckets, targets, byId);
    out.set(n.id, {
      platforms,
      servingBuckets: buckets,
      servingTargets: targets,
      ...(hosting !== undefined ? { webHosting: hosting } : {}),
      domains,
      ...(prod !== undefined ? { prodDomain: prod.label } : {}),
    });
  }
  return out;
}

function webHostingOf(
  buckets: readonly string[],
  targets: readonly string[],
  byId: ReadonlyMap<string, ArchitectureNode>,
): WebHosting | undefined {
  const prodish = (id: string): boolean => {
    const env = byId.get(id)?.environment;
    return env === undefined || env === 'prod';
  };
  const prodBuckets = buckets.filter(prodish);
  const prodTargets = targets.filter(prodish);
  const [b, t] =
    prodBuckets.length + prodTargets.length > 0 ? [prodBuckets, prodTargets] : [buckets, targets];
  if (t.length > 0) return 'ssr';
  if (b.length > 0) return 'static';
  return undefined;
}
