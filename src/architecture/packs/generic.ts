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
  matchers: [],
  nodeKinds: {
    component: {
      ...RENDER_CLASS_LOOKS.service,
      short: '구성 요소',
      text: '구성 요소',
      lane: 'component',
      rank: 2,
    },
  },
  displayKinds: Object.fromEntries(
    RENDER_CLASSES.map((rc) => [`cx_${rc}`, RENDER_CLASS_LOOKS[rc]]),
  ) as Record<`cx_${RenderClass}`, KindLook>,
  lanes: {
    component: { title: '구성 요소' },
    // tree 드릴다운의 그룹 레벨에서 그 묶음 밖에 있는 상대 카드가 선다. 보내는 쪽은 왼쪽, 받는 쪽은 오른쪽이다
    outside_from: { title: '밖에서 들어옴' },
    outside_to: { title: '밖으로 나감' },
  },
  edgeKinds: {
    connects: { text: '연결' },
    sends: { text: '보냄' },
    depends_on: { text: '의존' },
  },
} as const satisfies VocabularyPack;
