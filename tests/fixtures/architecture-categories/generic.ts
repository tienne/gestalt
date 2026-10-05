import type { ArchitectureIr } from '../../../src/architecture/index.js';
import { base, edge, node } from './common.js';

/** 맞는 팩이 없는 구성 요소. 배치 잡이 큐에서 꺼내 저장소에 쓴다 */
export function genericIr(): ArchitectureIr {
  return {
    ...base(['generic']),
    nodes: [
      node('job-sync', 'component', { displayKind: '배치 잡', renderClass: 'service' }),
      node('q-orders', 'component', { displayKind: '주문 큐', renderClass: 'queue' }),
      node('db-ledger', 'component', { displayKind: '원장', renderClass: 'store' }),
    ],
    edges: [
      edge('e-pull', 'job-sync', 'q-orders', 'depends_on'),
      edge('e-write', 'job-sync', 'db-ledger', 'sends'),
    ],
  };
}
