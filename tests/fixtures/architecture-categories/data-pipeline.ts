import type { ArchitectureIr } from '../../../src/architecture/index.js';
import { base, doc, edge, node } from './common.js';

/** 주문 원천에서 토픽과 파이프라인 작업 둘을 지나 웨어하우스 데이터셋에 쌓이고 리포트로 나가는 길 */
export function dataPipelineIr(): ArchitectureIr {
  return {
    ...base(['data']),
    nodes: [
      node('orders-db', 'source', { displayName: '주문 DB' }),
      node('orders-topic', 'topic'),
      node('etl', 'pipeline', { displayName: '주문 집계' }),
      node('clean', 'job', { parent: 'etl' }),
      node('aggregate', 'job', { parent: 'etl' }),
      node('dw', 'warehouse', { displayName: '분석 저장소' }),
      node('orders-daily', 'dataset', { parent: 'dw' }),
      node('users', 'dataset', { parent: 'dw' }),
      node('sales-dash', 'report', { displayName: '매출 대시보드' }),
    ],
    edges: [
      edge('e-src-topic', 'orders-db', 'orders-topic', 'publishes'),
      edge('e-topic-clean', 'orders-topic', 'clean', 'feeds'),
      edge('e-clean-agg', 'clean', 'aggregate', 'feeds'),
      edge('e-agg-daily', 'aggregate', 'orders-daily', 'feeds'),
      edge('e-users-agg', 'users', 'aggregate', 'feeds'),
      edge('e-daily-dash', 'orders-daily', 'sales-dash', 'feeds', [doc('wiki:dash#1')]),
    ],
  };
}
