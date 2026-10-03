import type { LaneId } from './layout.js';
import type { NodeKind, Platform } from './types.js';

/**
 * 카드 칩에 쓰는 짧은 종류 이름. 색을 못 가리는 사람도 종류를 읽을 수 있게 색 띠와 함께 싣는다.
 * service는 웹과 앱을 함께 담으므로 "서비스"로 쓰고 어느 쪽인지는 플랫폼 칩이 따로 알린다
 */
export const NODE_KIND_SHORT: Record<NodeKind, string> = {
  service: '서비스',
  feature: '기능 영역',
  screen: '화면',
  gateway: '게이트웨이',
  endpoint: 'API',
  app_module: '서버',
  external_service: '클라이언트',
  db_table: 'DB',
  datastore: '저장소',
  workflow: '트리거',
  build: '빌드',
  artifact: '산출물',
  deploy_target: '배포 대상',
  domain: '도메인',
  cdn: 'CDN',
  bucket: '버킷',
  cloud_account: '계정',
};

/** 레인 제목은 그 칸의 레이어 이름이다. 칩 이름과 맞춰야 카드와 레인이 같은 말로 읽힌다 */
export const LANE_TITLES: Record<LaneId, string> = {
  service: '서비스',
  unit: '기능 영역',
  screen: '화면',
  gateway: '게이트웨이',
  endpoint: 'API',
  app_module: '서버',
  external_service: '클라이언트',
  external: '외부 서비스',
  db_table: 'DB',
  workflow: '트리거',
  build: '빌드',
  artifact: '산출물',
  deploy_target: '배포 대상',
  domain: '도메인',
  cdn: 'CDN',
  bucket: '버킷',
  cloud_account: '클라우드 계정',
};

/** 카드 첫 줄 플랫폼 칩 글자. 브랜드 로고 대신 중립 아이콘과 이 글자를 함께 쓴다 */
export const PLATFORM_CHIP_TEXT: Record<Platform, string> = {
  web: '웹',
  android: 'AOS',
  ios: 'iOS',
};

/** 칩의 aria-label과 툴팁, 상세 패널에 쓰는 이름 */
export const PLATFORM_NAME: Record<Platform, string> = {
  web: '웹',
  android: 'Android 앱',
  ios: 'iOS 앱',
};
