import type { ArchitectureIr } from '../../../src/architecture/index.js';
import { base, doc, user } from './common.js';

/** 코드 밖 업무 흐름. 환불 승인 절차를 문서와 담당자 말로만 그린다. 레포는 root 없는 문서 묶음이다 */
export function refundApprovalIr(): ArchitectureIr {
  const d = (n: number) => [doc(`wiki:refund-policy#${n}`)];
  return {
    ...base(['generic']),
    repos: [{ id: 'wiki', name: 'ops-wiki' }],
    nodes: [],
    edges: [],
    flows: [
      {
        id: 'refund',
        title: '환불 승인',
        stateLabels: {
          REQUESTED: '요청됨',
          REVIEWED: '검토됨',
          APPROVED: '승인',
          REJECTED: '반려',
        },
        actors: [
          { id: 'customer', label: '손님', kind: 'person' },
          { id: 'agent', label: '상담원', kind: 'person' },
          { id: 'lead', label: '팀장', kind: 'person' },
        ],
        steps: [
          { id: 'req', actor: 'customer', label: '환불 요청', state: 'REQUESTED', evidence: d(1) },
          { id: 'review', actor: 'agent', label: '주문 확인', state: 'REVIEWED', evidence: d(2) },
          {
            id: 'approve',
            actor: 'lead',
            label: '승인',
            state: 'APPROVED',
            terminal: true,
            evidence: d(3),
          },
          {
            id: 'reject',
            actor: 'lead',
            label: '반려',
            state: 'REJECTED',
            terminal: true,
            evidence: [user('담당 팀장 확인')],
          },
        ],
        transitions: [
          {
            id: 't1',
            from: 'req',
            to: 'review',
            path: 'main',
            evidence: d(2),
            lineStyle: 'dashed',
          },
          {
            id: 't2',
            from: 'review',
            to: 'approve',
            path: 'main',
            label: '30만 원 이하',
            evidence: d(3),
            lineStyle: 'dashed',
          },
          {
            id: 't3',
            from: 'review',
            to: 'reject',
            path: 'side',
            label: '규정 밖',
            evidence: [user('담당 팀장 확인')],
            lineStyle: 'dashed',
          },
        ],
      },
    ],
  };
}
