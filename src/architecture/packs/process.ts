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
    biz_org: { title: '사람', about: '조직과 역할이 서는 칸이에요.' },
    biz_sys: { title: '시스템', about: '업무 시스템이 서는 칸이에요.' },
    biz_doc: { title: '양식', about: '업무에 쓰는 양식이 서는 칸이에요.' },
  },
  edgeKinds: {
    hands_over: {
      text: '넘김',
      about: '한 조직이나 역할이 다음 쪽으로 일을 넘기는 연결이에요.',
      ends: { from: ['org_unit', 'role'], to: ['org_unit', 'role'] },
    },
    approves: {
      text: '승인',
      about: '조직이나 역할이 양식을 승인하는 연결이에요.',
      ends: { from: ['org_unit', 'role'], to: ['form'] },
    },
    records: {
      text: '기록',
      about: '사람이나 시스템이 양식이나 시스템에 기록을 남기는 연결이에요.',
      ends: { from: ['org_unit', 'role', 'system'], to: ['form', 'system'] },
    },
  },
} as const satisfies VocabularyPack;
