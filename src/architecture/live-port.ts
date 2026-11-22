// 라이브 서버 주소는 CSP(렌더 시점)와 서버(서빙 시점)가 같이 쓴다.
// csp.ts가 node:http를 끌어오는 서버 모듈에 기대지 않도록 상수만 따로 둔다.

/** 아키텍처 라이브 서버 기본 포트. graph-viz 7891, pr 7892, digest 7893 다음 자리다 */
export const DEFAULT_ARCHITECTURE_LIVE_PORT = 7894;

/** 라이브 서버가 묶이는 호스트. 밖에서 닿지 않게 루프백만 쓴다 */
export const ARCHITECTURE_LIVE_HOST = '127.0.0.1';

/** 라이브 서버의 출처(origin). CSP connect-src와 Origin 검사가 같은 값을 본다 */
export function liveOrigin(port: number = DEFAULT_ARCHITECTURE_LIVE_PORT): string {
  return `http://${ARCHITECTURE_LIVE_HOST}:${port}`;
}

/** 본인용 CSP에 넣는 connect-src 지시문 한 줄 */
export function liveConnectSrc(port: number = DEFAULT_ARCHITECTURE_LIVE_PORT): string {
  return `connect-src ${liveOrigin(port)}`;
}

/** 서버가 페이지에 끼워 넣는 토큰 meta 이름. 라이브 스크립트가 이걸 읽어 요청 헤더에 싣는다 */
export const LIVE_TOKEN_META = 'gestalt-live-token';
/** 라이브 스크립트가 토큰을 싣는 요청 헤더 */
export const LIVE_TOKEN_HEADER = 'x-gestalt-token';
/** 세션 상태를 묻는 경로. 뷰어가 입력창을 띄울지 여기서 정한다 */
export const LIVE_STATUS_PATH = '/__live/status';
/** 질문을 보내는 경로 */
export const LIVE_ASK_PATH = '/__live/ask';
