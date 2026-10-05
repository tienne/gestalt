import { classLook } from './render-classes.js';
import type { VocabularyPack } from './types.js';

/**
 * 데이터 파이프라인. 원천에서 토픽과 처리 작업을 지나 데이터셋에 쌓이고 리포트로 나간다.
 * 파이프라인 안에 작업이, 웨어하우스 안에 데이터셋이 들어가서 parent 나무로 내려가 본다
 */
export const DATA_PACK = {
  id: 'data',
  title: '데이터 파이프라인',
  description: '원천, 토픽, 처리 작업, 데이터셋, 리포트',
  requires: ['generic'],
  drilldown: 'tree',
  matchers: ['dataset-io'],
  nodeKinds: {
    source: {
      ...classLook('external', '원천', '데이터가 처음 생기는 곳'),
      lane: 'data_src',
      rank: 0,
    },
    topic: {
      ...classLook('queue', '토픽', '데이터를 흘려보내는 통로'),
      lane: 'data_move',
      rank: 1,
    },
    pipeline: {
      ...classLook('infra', '파이프라인', '처리 작업 묶음'),
      lane: 'data_proc',
      rank: 2,
    },
    job: {
      ...classLook('service', '처리 작업', '데이터를 읽어 바꾸고 쓰는 작업'),
      lane: 'data_proc',
      rank: 2,
      parents: ['pipeline'],
    },
    warehouse: {
      ...classLook('store', '웨어하우스', '데이터셋을 모아두는 저장소'),
      lane: 'data_store',
      rank: 3,
    },
    dataset: {
      ...classLook('store', '데이터셋', '쌓인 데이터 한 묶음'),
      lane: 'data_store',
      rank: 3,
      parents: ['warehouse'],
    },
    report: {
      ...classLook('client', '리포트', '사람이 보는 표나 대시보드'),
      lane: 'data_out',
      rank: 4,
    },
  },
  lanes: {
    data_src: { title: '원천', about: '데이터가 처음 생기는 원천이 서는 칸이에요.' },
    data_move: { title: '통로', about: '데이터를 흘려보내는 토픽이 서는 칸이에요.' },
    data_proc: { title: '처리', about: '파이프라인과 처리 작업이 서는 칸이에요.' },
    data_store: { title: '저장', about: '웨어하우스와 데이터셋이 서는 칸이에요.' },
    data_out: { title: '활용', about: '사람이 보는 리포트가 서는 칸이에요.' },
  },
  edgeKinds: {
    feeds: { text: '데이터 공급', about: '앞쪽 데이터가 뒤쪽으로 흘러 들어가는 연결이에요.' },
    publishes: {
      text: '발행',
      about: '원천이나 처리 작업이 토픽에 데이터를 올리는 연결이에요.',
      ends: { from: ['source', 'job'], to: ['topic'] },
    },
  },
} as const satisfies VocabularyPack;
