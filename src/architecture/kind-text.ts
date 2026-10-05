import type { LaneId } from './layout.js';
import { ALL_PACKS_VOCABULARY } from './packs/index.js';
import type { DisplayKind, Platform, WebHosting } from './types.js';

/** 카드 칩에 쓰는 짧은 종류 이름. 색을 못 가리는 사람도 종류를 읽을 수 있게 색 띠와 함께 싣는다 */
export const NODE_KIND_SHORT = Object.fromEntries(
  Object.entries(ALL_PACKS_VOCABULARY.looks).map(([k, d]) => [k, d.short]),
) as Record<DisplayKind, string>;

/** 흐름이 달린 서비스 카드의 첫 줄 배지 글자. 하나면 수를 안 붙인다 */
export function flowBadgeText(count: number): string {
  return count === 1 ? '흐름' : `흐름 ${count}`;
}

/** 들어오는 loads가 없는 micro_app 칩 글자. NODE_KIND_SHORT.micro_app과 글자 수가 같다 */
export const MICRO_HOST_SHORT = '호스트';

/** 레인 제목은 그 칸의 레이어 이름이다. 칩 이름과 맞춰야 카드와 레인이 같은 말로 읽힌다 */
export const LANE_TITLES = Object.fromEntries(
  Object.entries(ALL_PACKS_VOCABULARY.lanes).map(([k, d]) => [k, d.title]),
) as Record<LaneId, string>;

/** 명사구 끝에 해요체 서술격 조사를 붙인다. 받침이 있으면 "이에요", 없거나 한글이 아니면 "예요"다 */
export function withCopula(noun: string): string {
  const code = noun.codePointAt(noun.length - 1) ?? 0;
  const final = code >= 0xac00 && code <= 0xd7a3 ? (code - 0xac00) % 28 : 0;
  return `${noun}${final === 0 ? '예요' : '이에요'}.`;
}

/** 서랍의 "이 종류는" 문장. 팩 kind 대부분은 text가 이미 설명이라 그걸 문장으로 맺는다 */
export const NODE_KIND_ABOUT = Object.fromEntries(
  Object.entries(ALL_PACKS_VOCABULARY.looks).map(([k, d]) => [k, d.about ?? withCopula(d.text)]),
) as Record<DisplayKind, string>;

/** parent로 정한 포함 관계는 IR 엣지가 아니라 팩 표에 없다 */
export const CONTAINS_ABOUT = '바깥 카드가 안쪽 카드를 품는 포함 관계예요.';

export const EDGE_KIND_ABOUT: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(ALL_PACKS_VOCABULARY.edgeKinds).map(([k, d]) => [k, d.about]),
  ),
  contains: CONTAINS_ABOUT,
};

export const LANE_ABOUT = Object.fromEntries(
  Object.entries(ALL_PACKS_VOCABULARY.lanes).map(([k, d]) => [k, d.about]),
) as Record<LaneId, string>;

/** 구간 레인(stage:<n>)은 이름을 세션이 정해서 칸 설명도 하나로 쓴다 */
export const STAGE_LANE_ABOUT =
  '이 그림을 그린 세션이 정한 구간이에요. 왼쪽 구간부터 차례로 읽어요.';

/** 카드 첫 줄 플랫폼 칩 글자. 브랜드 로고 대신 중립 아이콘과 이 글자를 함께 쓴다 */
export const PLATFORM_CHIP_TEXT: Record<Platform, string> = {
  web: '웹',
  android: 'AOS',
  ios: 'iOS',
};

/** 웹 칩 글자. 서빙 방식을 알면 웹 대신 이 글자를 쓴다 */
export const WEB_HOSTING_CHIP_TEXT: Record<WebHosting, string> = {
  static: '웹',
  ssr: '웹(SSR)',
};

/** 서빙 방식을 아는 웹 칩의 aria-label과 툴팁, 상세 패널 이름 */
export const WEB_HOSTING_NAME: Record<WebHosting, string> = {
  static: '웹',
  ssr: 'SSR 웹 (서버 렌더)',
};

export function platformChipText(p: Platform, hosting?: WebHosting): string {
  return p === 'web' && hosting !== undefined
    ? WEB_HOSTING_CHIP_TEXT[hosting]
    : PLATFORM_CHIP_TEXT[p];
}

export function platformName(p: Platform, hosting?: WebHosting): string {
  return p === 'web' && hosting !== undefined ? WEB_HOSTING_NAME[hosting] : PLATFORM_NAME[p];
}

/** 칩의 aria-label과 툴팁, 상세 패널에 쓰는 이름 */
export const PLATFORM_NAME: Record<Platform, string> = {
  web: '웹',
  android: 'Android 앱',
  ios: 'iOS 앱',
};
