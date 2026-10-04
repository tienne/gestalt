import type { ArchitectureIr } from '../../../src/architecture/index.js';
import { base, doc, edge, node } from './common.js';

/**
 * 네트워크 둘이 피어링으로 이어진 인프라. 한쪽 네트워크 안에 서브넷 둘과 방화벽이 있고
 * 사설 서브넷 안 클러스터에서 워크로드 둘이 돈다. 한 워크로드는 옆 네트워크의 DB와 밖의 SaaS를 부른다
 */
export function infraIr(): ArchitectureIr {
  return {
    ...base(['infra']),
    nodes: [
      node('vpc-main', 'network', { displayName: '메인 네트워크' }),
      node('vpc-data', 'network', { displayName: '데이터 네트워크' }),
      node('fw-edge', 'firewall', { parent: 'vpc-main' }),
      node('sn-public', 'subnet', { parent: 'vpc-main' }),
      node('sn-private', 'subnet', { parent: 'vpc-main' }),
      node('k8s', 'cluster', { parent: 'sn-private' }),
      node('api', 'workload', { parent: 'k8s' }),
      node('worker', 'workload', { parent: 'k8s' }),
      node('lb', 'workload', { parent: 'sn-public' }),
      node('db', 'workload', { parent: 'vpc-data' }),
      node('saas', 'component', { displayKind: '메일 발송', renderClass: 'external' }),
    ],
    edges: [
      edge('e-peer', 'vpc-main', 'vpc-data', 'peers'),
      edge('e-fw-public', 'fw-edge', 'sn-public', 'allows'),
      edge('e-lb-api', 'lb', 'api', 'connects'),
      edge('e-api-worker', 'api', 'worker', 'sends'),
      edge('e-worker-db', 'worker', 'db', 'connects'),
      edge('e-api-db', 'api', 'db', 'connects'),
      edge('e-worker-saas', 'worker', 'saas', 'connects', [doc('wiki:mail#1')]),
    ],
  };
}
