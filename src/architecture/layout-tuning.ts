// 드릴다운 뷰어 배치에서 눈으로 보며 정한 문턱과 간격. 값을 바꿀 땐 여기만 고친다.
// 서버 배치(drilldown.ts, layout.ts)와 렌더러가 읽고 클라이언트 스크립트는 렌더러가 박아 준 값을 쓴다

/** 루트 카드가 이 장수보다 많아야 레인 덩어리로 접는다. 적으면 그대로 펼쳐도 한눈에 들어온다 */
export const ROOT_COLLAPSE_MIN_CARDS = 12;
/** 덩어리가 이 개수보다 적으면 접지 않는다. 덩어리 하나로 접으면 누르는 단계만 하나 늘어난다 */
export const ROOT_COLLAPSE_MIN_CHUNKS = 2;

/** 루트 덩어리 카드 크기. 이름, 설명 두 줄, 항목 수 줄이 들어간다 */
export const CHUNK_CARD_W = 260;
export const CHUNK_CARD_H = 112;
/** 접힌 root의 덩어리 사이 간격. 덩어리 사이엔 묶음 선 하나와 개수 알약만 지나가서 일반 레벨보다 좁힌다 */
export const CHUNK_LAYER_GAP = 72;
/** 접힌 root를 처음 맞출 때 허용하는 가장 낮은 배율. 덩어리 글자가 커서 일반 레벨(0.75)보다 낮춰도 읽힌다 */
export const CHUNK_FIT_MIN_K = 0.6;
/** 덩어리 설명을 자르는 글자 폭 단위(한글 2칸) */
export const CHUNK_DESC_MAX_UNITS = 64;

/** 레인과 안쪽 단계에서 한쪽(부르는 쪽, 부르는 대상)에 세우는 바깥 알약 최대 장수. 넘치면 +N으로 접는다 */
export const OUTSIDE_PER_SIDE = 4;
/** 바깥 알약 카드 높이. 폭은 글자 폭으로 재되 큰 카드 최소 폭을 넘지 않는다 */
export const PILL_H = 36;
export const PILL_MIN_W = 120;
export const PILL_MAX_W = 220;

/** 드릴다운 큰 카드 폭 범위 */
export const CARD_MIN_W = 200;
export const CARD_MAX_W = 300;
/** 카드 안 글자 왼쪽, 오른쪽 여백. 오른쪽은 › 자리까지 둔다 */
export const CARD_TEXT_LEFT = 14;
export const CARD_TEXT_RIGHT = 22;
/** 카드 위아래 안쪽 여백 */
export const CARD_PAD_Y = 10;
/** 제목 줄(15px/22px)과 둘째 줄(도메인 같은 12px 줄) 높이 */
export const CARD_TITLE_ROW = 22;
export const CARD_SECOND_ROW = 18;
/** 설명 한 줄 높이(13px/19px)와 최대 줄 수 */
export const CARD_DESC_LINE = 19;
export const CARD_DESC_MAX_LINES = 3;
/** 설명 칸 최대 안쪽 폭. 이보다 길면 줄을 바꾼다 */
export const CARD_DESC_MAX_INNER = 240;
/** 제목 한 칸(한글 2칸 기준 반쪽)과 설명 한 칸의 글자 폭 */
export const CARD_TITLE_CHAR_W = 8.5;
export const CARD_DESC_CHAR_W = 6.5;
/** 아래 칩 줄(항목 수, 추정, 흐름) 높이 */
export const CARD_CHIP_ROW = 24;
/** 카드 최소 높이 */
export const CARD_MIN_H = 52;

/** 드릴다운 레벨 elk 간격. 평면 그림은 layout.ts 기본값을 그대로 쓴다 */
export const DRILL_LAYER_GAP = 120;
export const DRILL_NODE_GAP = 32;

/** 개요 옆 칸 폭과 이 폭 아래에서 아래 시트로 바꾸는 화면 폭 */
export const SIDE_PANEL_W = 300;
export const SIDE_PANEL_SHEET_MAX = 560;
