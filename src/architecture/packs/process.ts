import { classLook } from './render-classes.js';
import type { VocabularyPack } from './types.js';

/**
 * 업무 조직도. 누가 어느 조직에 있고 어떤 시스템과 양식으로 일을 넘기는지 그린다.
 * 순서가 중요한 업무는 flows로 그린다. 이 팩은 그 흐름에 나오는 사람과 시스템이 어디 속하는지 잡는다
 */
export const PROCESS_PACK = {
  id: 'process',
  title: '업무 흐름',
  description: '조직, 역할, 업무 시스템, 문서 양식',
  requires: ['generic'],
  drilldown: 'tree',
  matchers: ['state-value'],
  nodeKinds: {
    org_unit: {
      ...classLook('actor', '조직', '팀이나 부서'),
      lane: 'biz_org',
      rank: 0,
      parents: ['org_unit'],
    },
    role: {
      ...classLook('actor', '역할', '업무를 맡는 사람의 자리'),
      lane: 'biz_org',
      rank: 0,
      parents: ['org_unit'],
    },
    // 시스템이 양식 앞에 선다. records는 사람과 시스템에서 양식으로 가서 이 순서여야 선이 뒤로 안 돈다
    system: {
      ...classLook('service', '업무 시스템', '업무를 기록하고 처리하는 시스템'),
      lane: 'biz_sys',
      rank: 1,
    },
    form: {
      ...classLook('document', '양식', '업무에 쓰는 문서 양식'),
      lane: 'biz_doc',
      rank: 2,
    },
  },
  lanes: {
    biz_org: { title: '사람' },
    biz_sys: { title: '시스템' },
    biz_doc: { title: '양식' },
  },
  edgeKinds: {
    hands_over: { text: '넘김', ends: { from: ['org_unit', 'role'], to: ['org_unit', 'role'] } },
    approves: { text: '승인', ends: { from: ['org_unit', 'role'], to: ['form'] } },
    records: {
      text: '기록',
      ends: { from: ['org_unit', 'role', 'system'], to: ['form', 'system'] },
    },
  },
} as const satisfies VocabularyPack;
