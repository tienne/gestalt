/**
 * 코드 그래프 훅을 켜고 끄는 환경변수. config.ts와 훅 프로세스가 함께 쓴다.
 * 훅은 기동 비용 때문에 zod와 dotenv를 못 불러오므로 이 모듈은 아무것도 import하지 않는다.
 */

/** 켜고 끄는 환경변수. gestalt.json보다 우선한다 */
export const HOOKS_ENV = 'GESTALT_CODE_GRAPH_HOOKS';

/** 1/true면 true, 0/false면 false, 그 밖엔 판정을 gestalt.json에 넘긴다는 뜻으로 undefined */
export function parseHooksEnv(raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return undefined;
}
