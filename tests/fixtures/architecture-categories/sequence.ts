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

/**
 * 주문 접수 순서. 맨 위 손님이 아직 안 만난 대상을 부를 때마다 자동 구간이 새로 열린다.
 * 자동으로 자르면 [s1-s6] 게이트웨이, [s7-s10] 주문 서버, [s11] 인증이 나온다.
 * 응답, 자기 호출, 이미 만난 대상 호출, 반복 묶음 한가운데의 새 대상 호출, 메시지가 안 가리키는 엣지를 한 번씩 담는다
 */
export function orderIntakeSequenceIr(): ArchitectureIr {
  return {
    ...base(['generic']),
    nodes: [
      node('user', 'component', { displayKind: '손님 앱', renderClass: 'client' }),
      node('gw', 'component', { displayKind: '게이트웨이', renderClass: 'service' }),
      node('auth', 'component', { displayKind: '인증', renderClass: 'service' }),
      node('order', 'component', {
        displayKind: '주문',
        displayName: '주문 서버',
        renderClass: 'service',
      }),
      node('db', 'component', { displayKind: '주문 DB', renderClass: 'store' }),
      node('pay', 'component', { displayKind: '결제', renderClass: 'external' }),
    ],
    edges: [
      edge('e-user-gw', 'user', 'gw', 'connects'),
      edge('e-gw-auth', 'gw', 'auth', 'connects'),
      edge('e-user-order', 'user', 'order', 'connects'),
      edge('e-order-db', 'order', 'db', 'sends'),
      edge('e-user-pay', 'user', 'pay', 'connects'),
      edge('e-gw-order', 'gw', 'order', 'connects'),
    ],
    projections: [
      {
        id: 'intake',
        shape: 'sequence',
        title: '주문 접수 순서',
        question: '손님이 주문을 넣으면 누가 무엇을 어떤 순서로 주고받나요?',
        participants: ['user', 'gw', 'auth', 'order', 'db', 'pay'],
        blocks: [{ id: 'b-retry', kind: 'loop', label: '재시도' }],
        messages: [
          seqMsg('s1', 'user', 'gw', '로그인', { edge: 'e-user-gw' }),
          seqMsg('s2', 'gw', 'auth', '토큰 확인', { edge: 'e-gw-auth' }),
          seqMsg('s3', 'auth', 'gw', '확인됨', { edge: 'e-gw-auth', reply: true }),
          seqMsg('s4', 'gw', 'user', '세션', { edge: 'e-user-gw', reply: true }),
          {
            id: 's5',
            from: 'user',
            to: 'user',
            label: '장바구니 정리',
            evidence: [doc('wiki:order#1')],
            lineStyle: 'dashed',
          },
          seqMsg('s6', 'user', 'gw', '메뉴 조회', { edge: 'e-user-gw' }),
          seqMsg('s7', 'user', 'order', '주문 넣기', { edge: 'e-user-order', block: 'b-retry' }),
          seqMsg('s8', 'order', 'db', '주문 저장', { edge: 'e-order-db', block: 'b-retry' }),
          seqMsg('s9', 'user', 'pay', '결제 요청', { edge: 'e-user-pay', block: 'b-retry' }),
          seqMsg('s10', 'user', 'pay', '결제 확인', { edge: 'e-user-pay' }),
          {
            id: 's11',
            from: 'user',
            to: 'auth',
            label: '로그아웃',
            evidence: [doc('wiki:order#2')],
            lineStyle: 'dashed',
          },
        ],
      },
    ],
  };
}

function seqMsg(
  id: string,
  from: string,
  to: string,
  label: string,
  extra: { edge: string; reply?: boolean; block?: string },
): NonNullable<ArchitectureIr['projections']>[number]['messages'][number] {
  return { id, from, to, label, evidence: [], lineStyle: 'solid', ...extra };
}
