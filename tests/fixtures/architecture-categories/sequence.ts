import type { ArchitectureIr } from '../../../src/architecture/index.js';
import { base, doc, edge, node } from './common.js';

/**
 * 결제 승인 주고받기. 지도는 구성 요소 넷과 엣지 셋이고 투영 하나가 그 위에 순서를 붙인다.
 * 응답, 자기 호출, 분기 묶음, 문서 근거만 있는 메시지, 근거 없는 메시지를 한 번씩 담는다
 */
export function checkoutSequenceIr(): ArchitectureIr {
  return {
    ...base(['generic']),
    nodes: [
      node('app', 'component', { displayKind: '앱', renderClass: 'client' }),
      node('api', 'component', { displayKind: '주문 API', renderClass: 'service' }),
      node('pg', 'component', { displayKind: '결제 대행', renderClass: 'external' }),
      node('ledger', 'component', { displayKind: '원장', renderClass: 'store' }),
    ],
    edges: [
      edge('e-app-api', 'app', 'api', 'connects'),
      edge('e-api-pg', 'api', 'pg', 'connects'),
      edge('e-api-ledger', 'api', 'ledger', 'sends'),
    ],
    projections: [
      {
        id: 'checkout',
        shape: 'sequence',
        title: '결제 승인 순서',
        question: '앱에서 결제를 누르면 누가 무엇을 어떤 순서로 주고받나요?',
        participants: ['app', 'api', 'pg', 'ledger'],
        blocks: [{ id: 'b-result', kind: 'alt', label: '승인 결과' }],
        messages: [
          {
            id: 'm1',
            from: 'app',
            to: 'api',
            label: 'POST /orders/pay',
            edge: 'e-app-api',
            evidence: [],
            lineStyle: 'solid',
          },
          {
            id: 'm2',
            from: 'api',
            to: 'api',
            label: '금액 검증',
            evidence: [doc('wiki:pay#2')],
            lineStyle: 'dashed',
          },
          {
            id: 'm3',
            from: 'api',
            to: 'pg',
            label: '승인 요청',
            edge: 'e-api-pg',
            evidence: [],
            lineStyle: 'solid',
          },
          {
            id: 'm4',
            from: 'pg',
            to: 'api',
            label: '승인됨',
            edge: 'e-api-pg',
            evidence: [],
            lineStyle: 'solid',
            reply: true,
            block: 'b-result',
            branch: '승인',
          },
          {
            id: 'm5',
            from: 'api',
            to: 'ledger',
            label: '결제 기록',
            edge: 'e-api-ledger',
            evidence: [],
            lineStyle: 'solid',
            block: 'b-result',
            branch: '승인',
          },
          {
            id: 'm6',
            from: 'pg',
            to: 'api',
            label: '거절됨',
            evidence: [doc('wiki:pay#4')],
            lineStyle: 'dashed',
            reply: true,
            block: 'b-result',
            branch: '거절',
          },
          {
            id: 'm7',
            from: 'api',
            to: 'app',
            label: '결과 화면 주소',
            evidence: [],
            lineStyle: 'dashed',
            reply: true,
          },
        ],
      },
    ],
  };
}
