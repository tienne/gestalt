import type { ArchitectureIr } from '../../../src/architecture/index.js';
import { base, doc, edge, node, user } from './common.js';

/** 매장 직원이 환불을 받아 점장이 승인하고 본사 정산 담당에게 넘기는 조직도. 근거는 문서와 사용자 확인뿐이다 */
export function orgProcessIr(): ArchitectureIr {
  const said = [user('interview:store-ops')];
  return {
    ...base(['process']),
    repos: [{ id: 'wiki', name: 'acme-wiki' }],
    nodes: [
      node('store', 'org_unit', { displayName: '매장 운영', repo: 'wiki', evidence: said }),
      node('hq', 'org_unit', { displayName: '본사', repo: 'wiki', evidence: said }),
      node('staff', 'role', { displayName: '직원', parent: 'store', repo: 'wiki', evidence: said }),
      node('lead', 'role', {
        displayName: '점장',
        parent: 'store',
        repo: 'wiki',
        evidence: said,
      }),
      node('finance', 'role', {
        displayName: '정산 담당',
        parent: 'hq',
        repo: 'wiki',
        evidence: said,
      }),
      node('refund-form', 'form', {
        displayName: '환불 요청서',
        repo: 'wiki',
        evidence: [doc('wiki:refund#1')],
      }),
      node('pos', 'system', { displayName: '매장 단말', repo: 'wiki', evidence: said }),
    ],
    edges: [
      edge('e-staff-pos', 'staff', 'pos', 'records', said),
      edge('e-staff-form', 'staff', 'refund-form', 'records', [doc('wiki:refund#2')]),
      edge('e-lead-form', 'lead', 'refund-form', 'approves', [doc('wiki:refund#3')]),
      edge('e-staff-lead', 'staff', 'lead', 'hands_over', said),
      edge('e-lead-finance', 'lead', 'finance', 'hands_over', [doc('wiki:refund#4')]),
    ],
  };
}
