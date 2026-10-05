import { RENDER_CLASS_LOOKS } from './render-classes.js';
import { RENDER_CLASSES, type KindLook, type RenderClass, type VocabularyPack } from './types.js';

/**
 * 맞는 팩이 없을 때 쓰는 범용 어휘. component 하나로 무엇이든 그린다.
 * 읽는 사람이 보는 종류 이름은 노드의 displayKind에, 색과 아이콘은 renderClass에 둔다
 */
export const GENERIC_PACK = {
  id: 'generic',
  title: '범용',
  description: '맞는 팩이 없는 구성 요소를 렌더 분류만으로 그린다',
  drilldown: 'none',
  matchers: ['name-ref'],
  nodeKinds: {
    component: {
      ...RENDER_CLASS_LOOKS.service,
      short: '구성 요소',
      text: '구성 요소',
      about: '맞는 종류가 없어 범용으로 그린 구성 요소예요.',
      lane: 'component',
      rank: 2,
    },
  },
  displayKinds: Object.fromEntries(
    RENDER_CLASSES.map((rc) => [`cx_${rc}`, RENDER_CLASS_LOOKS[rc]]),
  ) as Record<`cx_${RenderClass}`, KindLook>,
  lanes: {
    component: { title: '구성 요소', about: '구성 요소가 서는 칸이에요.' },
    // tree 드릴다운의 그룹 레벨에서 그 묶음 밖에 있는 상대 카드가 선다. 보내는 쪽은 왼쪽, 받는 쪽은 오른쪽이다
    outside_from: {
      title: '밖에서 들어옴',
      about: '이 묶음 밖에서 안으로 연결을 보내는 카드가 서는 칸이에요.',
    },
    outside_to: {
      title: '밖으로 나감',
      about: '이 묶음 안에서 나간 연결을 받는 바깥 카드가 서는 칸이에요.',
    },
  },
  edgeKinds: {
    connects: { text: '연결', about: '두 구성 요소가 서로 이어진 연결이에요.' },
    sends: { text: '보냄', about: '앞쪽이 뒤쪽으로 데이터나 메시지를 보내는 연결이에요.' },
    depends_on: { text: '의존', about: '앞쪽이 뒤쪽 없이는 돌지 않는 의존 연결이에요.' },
  },
} as const satisfies VocabularyPack;
