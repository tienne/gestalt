import { classLook } from './render-classes.js';
import type { VocabularyPack } from './types.js';

/**
 * 지식 문서 지도. 분류와 도메인 같은 묶음 안에 문서가, 디자인 영역 안에 화면 문서가 들어간다.
 * 문서 노드는 파일 하나다. label이 레포 기준 경로라 병합 키가 경로를 따른다
 */
export const KNOWLEDGE_PACK = {
  id: 'knowledge',
  title: '지식 문서',
  description: '문서 묶음, 문서, 디자인 화면 문서와 그 문서가 설명하는 기술 노드',
  requires: ['generic'],
  drilldown: 'tree',
  matchers: ['doc-path', 'screen-route'],
  nodeKinds: {
    doc_group: {
      ...classLook('infra', '문서 묶음', '분류나 도메인처럼 문서를 모은 곳'),
      lane: 'kn_group',
      rank: 0,
      parents: ['doc_group'],
    },
    document: {
      ...classLook('document', '문서', '파일 하나로 된 지식 문서'),
      lane: 'kn_doc',
      rank: 1,
      parents: ['doc_group'],
    },
    design_screen: {
      ...classLook('client', '화면 문서', '디자인 화면 색인의 한 화면'),
      lane: 'kn_screen',
      rank: 2,
      parents: ['doc_group'],
    },
  },
  lanes: {
    kn_group: { title: '묶음' },
    kn_doc: { title: '문서' },
    kn_screen: { title: '화면 문서' },
  },
  edgeKinds: {
    // 문서가 말한 것이지 코드가 증명한 게 아니라서 늘 점선이다. 가리킨 파일이 있는지는 docLink에 적는다.
    // 받는 쪽은 어느 kind든 되므로 ends 대신 검증기가 보내는 쪽만 따로 본다
    describes: { text: '설명' },
    indexes: {
      text: '안내',
      ends: { from: ['document'], to: ['document', 'design_screen', 'doc_group'] },
    },
  },
} as const satisfies VocabularyPack;

/** 문서 정보(doc)를 가질 수 있는 kind */
export const KNOWLEDGE_DOC_KINDS: readonly string[] = Object.keys(KNOWLEDGE_PACK.nodeKinds);
