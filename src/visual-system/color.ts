import { COLOR_RESOLVER_JS } from './color-resolver-js.js';

/**
 * Gestalt 컬러 시스템. 배경 프리셋 6개와 강조색 프리셋 34개를 독립으로 고르고 둘을 테마 하나로 해석한다.
 * 카탈로그 값은 기존 컬러 자산(color-system/index.mjs 0.1.0)을 그대로 옮겼다. 저장되는 값은 영문 ID라
 * 표시 이름이나 순서를 바꿔도 사용자가 고른 테마가 유지된다.
 */

export const COLOR_SYSTEM_VERSION = '0.2.0';

export interface AccentPreset {
  id: string;
  name: string;
  /** 어두운 배경에서 쓸 원색 */
  dark: string;
  /** 밝은 배경에서 쓸 글자용 원색. 없으면 dark를 대비 기준까지 보정한다 */
  light: string | null;
  /** 밝은 배경에서 도형 채움에만 따로 쓸 원색 */
  lightFill?: string;
}

export interface BackgroundPreset {
  id: string;
  name: string;
  color: string;
  panel: string;
  ink: string;
  muted: string;
  line: string;
  light: boolean;
}

const A = (
  id: string,
  name: string,
  dark: string,
  light: string | null,
  lightFill?: string,
): AccentPreset => (lightFill ? { id, name, dark, light, lightFill } : { id, name, dark, light });

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  A('sage', '세이지', '#B3C8A1', '#3D5A2D'),
  A('indigo', '인디고', '#9C9DFF', '#4941A8'),
  A('lemon-yellow', '레몬 옐로', '#F1E879', '#655D00'),
  A('tangerine', '탠저린', '#FFAD65', '#8A4007'),
  A('signal-red', '시그널 레드', '#FF7882', '#A62738'),
  A('orchid', '오키드', '#E796F2', '#83228E'),
  A('cobalt-blue', '코발트 블루', '#82A8FF', '#294DA7'),
  A('cyan', '시안', '#62D3EA', '#006479'),
  A('mint', '민트', '#74D9B2', '#13684F'),
  A('amber', '앰버', '#F5C25E', '#805100'),
  A('coral', '코럴', '#FF957F', '#A2382B'),
  A('rose', '로즈', '#F895BB', '#962759'),
  A('lilac', '라일락', '#BEA5FA', '#6036A2'),
  A('powder-blue', '파우더 블루', '#B9DBFF', null),
  A('royal-blue', '로열 블루', '#5A8FFF', null),
  A('steel-blue', '스틸 블루', '#A1B6CF', null),
  A('electric-aqua', '일렉트릭 아쿠아', '#22DDF6', null),
  A('teal', '청록', '#37BAAF', null),
  A('celadon', '셀라돈', '#CAE0C2', null),
  A('leaf-green', '리프 그린', '#8ACF75', null),
  A('olive', '올리브', '#CBD384', '#4F6600', '#789600'),
  A('mauve', '모브', '#C5ADC7', null),
  A('iris', '아이리스', '#BA79E9', null),
  A('buttercream', '버터 크림', '#FCE9B2', null),
  A('gold', '골드', '#E4B13F', null),
  A('copper', '카퍼', '#CE986D', null),
  A('peach', '피치', '#FFD2BB', null),
  A('terracotta', '테라코타', '#DE8B6C', null),
  A('vermilion', '버밀리언', '#FA6950', null),
  A('cherry', '체리', '#EF689C', null),
  A('dusty-rose', '더스티 로즈', '#C994A5', null),
  A('taupe', '토프', '#C4B2A3', null),
  A('silver', '실버', '#C4C4C4', null),
  A('orange-red', '오렌지레드', '#FF3D00', '#C93303'),
];

export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  {
    id: 'ink',
    name: '잉크',
    color: '#101010',
    panel: '#1B1B1B',
    ink: '#F1F1F1',
    muted: '#ADADAD',
    line: '#373737',
    light: false,
  },
  {
    id: 'charcoal',
    name: '차콜',
    color: '#171717',
    panel: '#232323',
    ink: '#F1F1F1',
    muted: '#ADADAD',
    line: '#404040',
    light: false,
  },
  {
    id: 'graphite',
    name: '그래파이트',
    color: '#303030',
    panel: '#3B3B3B',
    ink: '#F3F3F3',
    muted: '#C8C8C8',
    line: '#565656',
    light: false,
  },
  {
    id: 'soft-gray',
    name: '소프트 그레이',
    color: '#E6E6E6',
    panel: '#DCDCDC',
    ink: '#1F1F1F',
    muted: '#555555',
    line: '#B6B6B6',
    light: true,
  },
  {
    id: 'paper',
    name: '페이퍼',
    color: '#F3F3F3',
    panel: '#E9E9E9',
    ink: '#202020',
    muted: '#585858',
    line: '#C4C4C4',
    light: true,
  },
  {
    id: 'white',
    name: '화이트',
    color: '#FFFFFF',
    panel: '#F1F1F1',
    ink: '#202020',
    muted: '#5A5A5A',
    line: '#D0D0D0',
    light: true,
  },
];

export const DEFAULT_THEME = Object.freeze({ background: 'charcoal', accent: 'cyan' });

/** 업무 상태 색. 강조색과 독립이라 강조색을 바꿔도 상태 의미가 그대로다 */
export const STATUS_PALETTES = {
  success: { dark: '#79C98F', light: '#21643A' },
  warning: { dark: '#F1C06B', light: '#795100' },
  danger: { dark: '#FF8295', light: '#A52244' },
  info: { dark: '#8DB6F5', light: '#254D96' },
} as const;

export type StatusKind = keyof typeof STATUS_PALETTES;

/** 상태는 색만으로 구분하지 않는다. 화면에는 라벨과 기호를 같이 둔다 */
export const STATUS_CUES: Record<StatusKind, { label: string; symbol: string }> = {
  success: { label: '성공', symbol: '✓' },
  warning: { label: '경고', symbol: '!' },
  danger: { label: '오류', symbol: '×' },
  info: { label: '정보', symbol: 'i' },
};

/** 차트 계열 2번부터의 원색. 1번은 테마 강조 채움이다 */
const SERIES_SEEDS = {
  dark: ['#8DB6F5', '#79C98F', '#E796F2', '#F1C06B', '#BDBDBD'],
  light: ['#254D96', '#21643A', '#83228E', '#795100', '#5A5A5A'],
};

/** 계열은 색 외에 선 모양과 표식으로도 구분한다. 범례와 직접 라벨이 같은 단서를 쓴다 */
export const SERIES_CUES = [
  { dash: '', marker: 'circle', label: '실선·원' },
  { dash: '7 4', marker: 'square', label: '긴 점선·사각' },
  { dash: '2 3', marker: 'triangle', label: '짧은 점선·삼각' },
  { dash: '10 3 2 3', marker: 'diamond', label: '일점쇄선·마름모' },
  { dash: '1 5', marker: 'cross', label: '점선·가위표' },
  { dash: '12 6', marker: 'ring', label: '굵은 점선·빈 원' },
] as const;

/** 변경 비교. 추가, 삭제, 변경을 상태 색에 얹고 기호를 같이 쓴다 */
export const DIFF_KINDS = {
  added: { status: 'success', symbol: '+', label: '추가' },
  removed: { status: 'danger', symbol: '−', label: '삭제' },
  changed: { status: 'warning', symbol: '~', label: '변경' },
} as const;

export type DiffKind = keyof typeof DIFF_KINDS;

export const COLOR_CATALOG = {
  version: COLOR_SYSTEM_VERSION,
  defaults: DEFAULT_THEME,
  backgrounds: BACKGROUND_PRESETS,
  accents: ACCENT_PRESETS,
  status: STATUS_PALETTES,
  series: SERIES_SEEDS,
  diff: DIFF_KINDS,
};

export interface ThemeSelection {
  background?: string;
  accent?: string;
}

export interface RoleAdjustment {
  role: string;
  seed: string;
  value: string;
  min: number;
  before: number;
  after: number;
}

export interface ResolvedTheme {
  id: string;
  version: string;
  tone: 'light' | 'dark';
  background: string;
  accent: string;
  colors: Record<string, string>;
  /** 대비 기준까지 보정한 역할의 원색(before)과 결과(after). 문서의 보정 전후 표가 이 값을 쓴다 */
  adjustments: RoleAdjustment[];
}

interface ResolverApi {
  resolve(sel?: ThemeSelection): ResolvedTheme;
  contrast(a: string, b: string): number;
  mix(color: string, target: string, amount: number): string;
  cssVars(theme: ResolvedTheme): Record<string, string>;
  cssText(theme: ResolvedTheme): string;
}

// 런타임 문자열과 같은 코드를 Node에서도 실행한다. 두 곳이 따로 구현되면 정적 HTML과 서버 렌더의 색이 갈라진다
const api = new Function('catalog', `${COLOR_RESOLVER_JS}\nreturn gestaltColorSystem(catalog);`)(
  COLOR_CATALOG,
) as ResolverApi;

/** 배경 ID와 강조색 ID를 색 역할로 해석한다. 생략한 쪽은 기본값(차콜, 시안)을 쓴다 */
export function resolveColorTheme(selection: ThemeSelection = {}): ResolvedTheme {
  return api.resolve(selection);
}

export const contrastRatio = (a: string, b: string): number => api.contrast(a, b);
export const mixColor = (color: string, target: string, amount: number): string =>
  api.mix(color, target, amount);

/** `--gestalt-color-<역할>` CSS 변수 맵 */
export function toColorCssVariables(theme: ResolvedTheme): Record<string, string> {
  return api.cssVars(theme);
}

/** `:root{...}`처럼 선언 블록 안에 넣을 문자열 */
export function colorCssText(theme: ResolvedTheme): string {
  return api.cssText(theme);
}

export function isBackgroundId(id: string): boolean {
  return BACKGROUND_PRESETS.some((b) => b.id === id);
}

export function isAccentId(id: string): boolean {
  return ACCENT_PRESETS.some((a) => a.id === id);
}

/**
 * 한쪽만 바꾼 새 선택. 다른 쪽은 그대로 둔다(AC0의 독립 선택).
 * 알 수 없는 ID면 바꾸지 않고 이전 선택을 돌려준다.
 */
export function updateSelection(
  current: Required<ThemeSelection>,
  change: ThemeSelection,
): Required<ThemeSelection> {
  return {
    background:
      change.background && isBackgroundId(change.background)
        ? change.background
        : current.background,
    accent: change.accent && isAccentId(change.accent) ? change.accent : current.accent,
  };
}
