import type { ArchitectureIr } from '../../../src/architecture/index.js';
import { base, doc, edge, node } from './common.js';

type Projection = NonNullable<ArchitectureIr['projections']>[number];
type Message = Projection['messages'][number];

function msg(
  id: string,
  from: string,
  to: string,
  label: string,
  extra: Partial<Message> = {},
): Message {
  return { id, from, to, label, evidence: [], lineStyle: 'solid', ...extra };
}

/**
 * 주문 데이터가 옮겨 가는 길. 앞으로 가는 선, 되돌아가는 선, 같은 쌍의 선 둘,
 * 자기 자신으로 가는 선, 문서 근거만 있는 선, 근거 없는 선을 한 번씩 담는다
 */
export function orderDataflowIr(): ArchitectureIr {
  return {
    ...base(['generic']),
    nodes: [
      node('app', 'component', { displayKind: '앱', renderClass: 'client' }),
      node('api', 'component', { displayKind: '주문 API', renderClass: 'service' }),
      node('db', 'component', { displayKind: '주문 DB', renderClass: 'store' }),
      node('etl', 'component', { displayKind: '집계 배치', renderClass: 'service' }),
      node('dw', 'component', { displayKind: '분석 저장소', renderClass: 'store' }),
    ],
    edges: [
      edge('e-app-api', 'app', 'api', 'connects'),
      edge('e-api-db', 'api', 'db', 'sends'),
      edge('e-db-etl', 'db', 'etl', 'sends'),
      edge('e-etl-dw', 'etl', 'dw', 'sends'),
      edge('e-dw-api', 'dw', 'api', 'sends'),
    ],
    projections: [
      {
        id: 'order-data',
        shape: 'dataflow',
        title: '주문 데이터 흐름',
        question: '주문 한 건의 데이터는 어디서 어디로 옮겨 가나요?',
        messages: [
          msg('d1', 'app', 'api', '주문서', { edge: 'e-app-api' }),
          msg('d2', 'api', 'db', '주문 행', { edge: 'e-api-db' }),
          msg('d3', 'api', 'db', '결제 상태', { edge: 'e-api-db' }),
          msg('d4', 'db', 'etl', '변경분', { edge: 'e-db-etl' }),
          msg('d5', 'etl', 'dw', '일별 집계', { edge: 'e-etl-dw' }),
          msg('d6', 'dw', 'api', '추천 점수', { edge: 'e-dw-api' }),
          msg('d7', 'etl', 'etl', '재시도 큐', {
            evidence: [doc('wiki:etl#1')],
            lineStyle: 'dashed',
          }),
          msg('d8', 'dw', 'app', '리포트', { lineStyle: 'dashed' }),
        ],
      },
    ],
  };
}

/** 두 결제 경로 견주기. 둘 다 쓰는 것, 한쪽에만 있는 것, 지도에 없는 노드를 담는다 */
export function paymentCompareIr(): ArchitectureIr {
  return {
    ...base(['generic']),
    nodes: [
      node('app', 'component', { displayKind: '앱', renderClass: 'client' }),
      node('api', 'component', { displayKind: '주문 API', renderClass: 'service' }),
      node('pg', 'component', { displayKind: '카드 결제 대행', renderClass: 'external' }),
      node('wallet', 'component', { displayKind: '간편결제', renderClass: 'external' }),
      node('ledger', 'component', { displayKind: '원장', renderClass: 'store' }),
    ],
    edges: [
      edge('e-app-api', 'app', 'api', 'connects'),
      edge('e-api-pg', 'api', 'pg', 'connects'),
      edge('e-api-wallet', 'api', 'wallet', 'connects'),
      edge('e-api-ledger', 'api', 'ledger', 'sends'),
    ],
    projections: [
      {
        id: 'card-vs-wallet',
        shape: 'compare',
        title: '카드와 간편결제',
        question: '카드 결제와 간편결제는 무엇을 같이 쓰고 무엇이 다른가요?',
        messages: [],
        sides: [
          { id: 'card', label: '카드', nodes: ['app', 'api', 'pg', 'ledger'] },
          { id: 'wallet', label: '간편결제', nodes: ['app', 'api', 'wallet'] },
        ],
      },
    ],
  };
}
