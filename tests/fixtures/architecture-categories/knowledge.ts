import type {
  ArchitectureIr,
  ArchitectureNode,
  DocInfo,
  Evidence,
} from '../../../src/architecture/index.js';
import { base, edge } from './common.js';

// 가짜 지식 레포 acme-kb와 디자인 레포 acme-design. 문서 근거는 private이라 공유본에서 출처가 가려진다

const said = (location: string): Evidence => ({ type: 'doc', location, visibility: 'private' });

function group(id: string, title: string, path: string, parent?: string): ArchitectureNode {
  return {
    id,
    kind: 'doc_group',
    label: path,
    displayName: title,
    repo: path.startsWith('design/') ? 'design' : 'kb',
    ...(parent !== undefined ? { parent } : {}),
    evidence: [said(`${path}#1`)],
    doc: { path },
  };
}

function document(
  id: string,
  title: string,
  parent: string,
  doc: DocInfo,
  kind: 'document' | 'design_screen' = 'document',
): ArchitectureNode {
  return {
    id,
    kind,
    label: doc.path,
    displayName: title,
    repo: doc.path.startsWith('design/') ? 'design' : 'kb',
    parent,
    evidence: [said(`${doc.path}#1`)],
    doc,
  };
}

/** 분류 → 도메인 → 문서와 디자인 영역 → 화면 묶음 → 화면 문서 */
export function knowledgeIr(): ArchitectureIr {
  return {
    ...base(['knowledge']),
    view: 'knowledge',
    repos: [
      { id: 'kb', name: 'acme-kb' },
      { id: 'design', name: 'acme-design' },
    ],
    nodes: [
      group('g-domain', '도메인', 'kb/domains'),
      group('g-orders', '주문', 'kb/domains/orders', 'g-domain'),
      document('d-orders-index', '주문 안내', 'g-orders', {
        path: 'kb/domains/orders/INDEX.md',
        updatedAt: '2026-03-01',
        routes: [
          {
            keywords: ['주문 상태', '상태 값'],
            targetPath: 'kb/domains/orders/status.md',
            target: 'd-status',
          },
          { keywords: ['환불'], targetPath: 'kb/domains/orders/refund.md', target: 'd-refund' },
          { keywords: ['정산'], targetPath: 'kb/domains/orders/settle.md' },
        ],
      }),
      document('d-status', '주문 상태', 'g-orders', {
        path: 'kb/domains/orders/status.md',
        updatedAt: '2025-11-02',
        sections: ['상태 값', '바뀌는 조건'],
        gaps: [{ kind: 'gap', text: '취소 사유 코드 목록이 비었다', owner: 'kim', line: 12 }],
        evidenceMix: { code: 4, wiki: 1 },
        links: { total: 5, broken: 1, branchOnly: 3, pinned: 1, unchecked: 0 },
      }),
      document('d-refund', '환불', 'g-orders', {
        path: 'kb/domains/orders/refund.md',
        updatedAt: '2026-02-10',
        gaps: [{ kind: 'unverified', text: '부분 환불 한도' }],
        evidenceMix: { code: 2, ticket: 1 },
      }),
      group('g-design', '디자인', 'design/products'),
      group('g-store', '상점', 'design/products/store', 'g-design'),
      document(
        's-cart',
        '장바구니',
        'g-store',
        {
          path: 'design/products/store/screens.md#cart',
          screen: {
            route: '/cart',
            screenType: '화면',
            frame: 'Cart / Default',
            symbolized: true,
            hasSpec: true,
          },
        },
        'design_screen',
      ),
      document(
        's-pay',
        '결제',
        'g-store',
        {
          path: 'design/products/store/screens.md#pay',
          screen: { route: '/pay/:id', screenType: '바텀시트', symbolized: false, hasSpec: false },
        },
        'design_screen',
      ),
    ],
    edges: [
      edge('i-status', 'd-orders-index', 'd-status', 'indexes', [
        said('kb/domains/orders/INDEX.md#4'),
      ]),
      edge('i-refund', 'd-orders-index', 'd-refund', 'indexes', [
        said('kb/domains/orders/INDEX.md#5'),
      ]),
    ],
  };
}
