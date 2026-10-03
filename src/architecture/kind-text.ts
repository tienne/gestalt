import type { LaneId } from './layout.js';
import type { NodeKind } from './types.js';

/**
 * 카드 칩에 쓰는 짧은 종류 이름. 색을 못 가리는 사람도 종류를 읽을 수 있게 색 띠와 함께 싣는다.
 * service는 웹과 앱을 IR에서 가릴 수 없어 사람들이 흔히 부르는 "앱"으로 쓴다
 */
export const NODE_KIND_SHORT: Record<NodeKind, string> = {
  service: '앱',
  feature: '기능 영역',
  screen: '화면',
  gateway: '게이트웨이',
  endpoint: 'API',
  app_module: '서버',
  external_service: '클라이언트',
  db_table: 'DB',
  workflow: '트리거',
  build: '빌드',
  artifact: '산출물',
  deploy_target: '배포 대상',
};

/** 레인 제목은 그 칸의 레이어 이름이다. 칩 이름과 맞춰야 카드와 레인이 같은 말로 읽힌다 */
export const LANE_TITLES: Record<LaneId, string> = {
  service: '앱',
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
};
