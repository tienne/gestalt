import { COLOR_RESOLVER_JS } from './color-resolver-js.js';
import { COLOR_CATALOG, type ThemeSelection } from './color.js';
import { MOTION_CSS_VARS } from './css.js';
import { themeRuntimeJs } from './runtime.js';

/**
 * Presentation 템플릿 10종을 컬러 시스템에 잇는 표와 주입 블록.
 * presentation-designer는 Bash 없이 템플릿을 복사해 장표를 만들므로 해석기와 기본 색을 템플릿 안에 정적으로 싣는다.
 * `pnpm presentation:themes`가 이 표대로 템플릿의 :root 토큰 값과 표시 블록을 다시 쓰고 테스트가 결과가 최신인지 검사한다.
 */

const M = (role: string) => `var(--gestalt-color-${role})`;
/** 반대 밝기 배경에 같은 강조색을 해석한 역할. 어두운 장표 속 밝은 장(.light)처럼 바탕이 뒤집히는 자리에 쓴다 */
const ALT = (role: string) => `var(--gestalt-alt-${role})`;
const SERIES = (n: number) => M(`series-${n}`);
const ON_SERIES = (n: number) => `var(--gestalt-on-series-${n})`;
const fade = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

export interface PresentationTemplateTheme {
  id: string;
  /** 이 템플릿의 기본 배경과 강조색. 원래 템플릿 성격에 가까운 쌍으로 골랐다 */
  defaults: Required<ThemeSelection>;
  /** :root 토큰 → 역할 */
  tokens: Record<string, string>;
  /** 바탕이 바뀌는 자리에서 토큰을 다시 잇는다. 글자 토큰을 그 바탕의 짝 역할로 돌려 대비를 지킨다 */
  scoped?: Record<string, Record<string, string>>;
}

/** 장식 색 카드 안의 글자 토큰을 그 채움색의 짝 글자색으로 돌린다. 인라인 style로 칠한 카드도 잡으려고 속성 선택자를 같이 쓴다 */
function fillScope(
  token: string,
  on: string,
  textTokens: string[],
  classes: string[] = [],
): Record<string, Record<string, string>> {
  const sel = [
    `[style*="background:var(${token})"]`,
    `[style*="background: var(${token})"]`,
    ...classes,
  ].join(', ');
  // 글자색은 상속될 때 이미 계산된 값으로 내려오므로 토큰만 바꾸면 자식 글자가 안 바뀐다. color도 다시 건다
  return { [sel]: { ...Object.fromEntries(textTokens.map((t) => [t, on])), color: on } };
}

export const PRESENTATION_THEMES: readonly PresentationTemplateTheme[] = [
  {
    id: 'signal',
    defaults: { background: 'charcoal', accent: 'gold' },
    tokens: {
      '--c-bg': M('background'),
      '--c-bg-alt': M('surface'),
      '--c-bg-light': ALT('background'),
      '--c-bg-light-alt': ALT('surface'),
      '--c-fg': M('text'),
      '--c-fg-2': M('text-muted'),
      '--c-fg-3': M('text-muted'),
      '--c-fg-light': ALT('text'),
      '--c-fg-light-2': ALT('text-muted'),
      '--c-fg-light-3': ALT('text-muted'),
      '--c-accent': M('accent-text'),
      '--c-border': M('border'),
      '--c-border-light': ALT('border'),
    },
    scoped: {
      '.reveal .slides section.light': {
        '--c-accent': ALT('accent-text'),
        '--c-border': ALT('border'),
        '--c-fg-3': ALT('text-muted'),
        '--c-bg-alt': ALT('surface'),
      },
    },
  },
  {
    id: 'studio',
    defaults: { background: 'charcoal', accent: 'lemon-yellow' },
    tokens: {
      '--c-bg': M('background'),
      '--c-bg-alt': M('surface'),
      '--c-bg-light': M('accent-fill'),
      '--c-bg-light-alt': M('accent-fill'),
      '--c-fg': M('accent-text'),
      '--c-fg-2': M('text'),
      '--c-fg-3': M('text-muted'),
      '--c-fg-light': M('on-accent'),
      '--c-fg-light-2': M('on-accent'),
      '--c-fg-light-3': M('on-accent'),
      '--c-accent': M('accent-text'),
      '--c-border': M('border'),
      '--c-border-light': fade(M('on-accent'), 18),
    },
    scoped: {
      '.reveal .slides section.light': {
        '--c-accent': M('on-accent'),
        '--c-fg-3': M('on-accent'),
        '--c-bg-alt': fade(M('on-accent'), 12),
      },
    },
  },
  {
    id: 'broadside',
    defaults: { background: 'ink', accent: 'tangerine' },
    tokens: {
      '--c-bg': M('background'),
      '--c-bg-alt': M('surface'),
      '--c-bg-orange': M('accent-fill'),
      '--c-fg': M('text'),
      '--c-fg-2': M('text-muted'),
      '--c-fg-3': M('text-muted'),
      '--c-accent': M('accent-text'),
      '--c-border': M('border'),
    },
    scoped: {
      // 주황 장은 강조색 바탕이라 글자를 강조색의 짝 글자색으로 쓴다
      '.reveal .slides section.orange': {
        '--c-bg': M('on-accent'),
        '--c-accent': M('on-accent'),
        '--c-fg-3': M('on-accent'),
        '--c-bg-alt': fade(M('on-accent'), 12),
      },
    },
  },
  {
    id: 'editorial-forest',
    defaults: { background: 'paper', accent: 'leaf-green' },
    tokens: {
      // 초록은 크림 바탕 위 글자로도 쓰여서 기본은 accent-text에 잇고 초록이 바탕인 자리만 아래에서 accent-fill로 돌린다
      '--green': M('accent-text'),
      '--green-deep': M('accent-text'),
      '--green-lite': M('accent-text'),
      '--pink': SERIES(4),
      '--pink-deep': SERIES(4),
      '--cream': M('background'),
      '--cream-2': M('surface'),
      '--ink': M('text'),
    },
    scoped: {
      [[
        '.reveal .slides section.cover',
        '.reveal .slides section.data-slide',
        '.topic.t-green',
        '.topic.t-greenLite',
        '.step.fill',
      ].join(', ')]: {
        '--green': M('accent-fill'),
        '--green-lite': M('accent-fill'),
        '--pink': M('on-accent'),
        '--cream': M('on-accent'),
        color: 'var(--pink)',
      },
      ['.reveal .slides section.statement-slide, .topic.t-pink, .step.pinkfill']: {
        '--green-deep': ON_SERIES(4),
        '--green': ON_SERIES(4),
        color: 'var(--green-deep)',
      },
      // 막대 두 계열이 같은 글자색으로 합쳐지지 않게 둘째 계열만 옅게 둔다
      '.reveal .slides section.data-slide .bar.b': { opacity: '0.45' },
    },
  },
  {
    id: 'emerald-editorial',
    defaults: { background: 'charcoal', accent: 'mint' },
    tokens: {
      '--bg': M('accent-fill'),
      '--bg-2': M('accent-fill'),
      '--ink': M('on-accent'),
      '--ink-2': M('on-accent'),
      '--paper': M('background'),
      '--rule': fade(M('on-accent'), 22),
      '--rule-strong': fade(M('on-accent'), 85),
    },
    scoped: {
      '.panel-paper, .kpi.alt, .step.alt': {
        '--ink': M('text'),
        color: 'var(--ink)',
        '--bg': M('accent-text'),
        '--rule': M('border'),
      },
      // 원본 템플릿에서 짙은 KPI 카드의 숫자가 카드와 같은 색이라 보이지 않았다
      '.kpi:not(.alt) .t-num': { color: 'var(--bg)' },
    },
  },
  {
    id: 'neo-grid',
    defaults: { background: 'soft-gray', accent: 'lemon-yellow' },
    tokens: {
      '--bg': M('background'),
      '--ink': M('text'),
      '--paper': M('surface'),
      '--accent': M('accent-fill'),
      '--line': M('text'),
    },
    scoped: {
      '.card.ink, .pagenum.invert': { '--accent': ALT('accent-text') },
      '.card.lemon, .pagenum.lemon': { '--ink': M('on-accent'), color: 'var(--ink)' },
      // 짙은 카드 안의 mark도 강조색 채움 위에 짝 글자색으로 쓴다
      mark: { '--accent': M('accent-fill'), '--ink': M('on-accent'), color: 'var(--ink)' },
    },
  },
  {
    id: 'pin-and-paper',
    defaults: { background: 'charcoal', accent: 'lemon-yellow' },
    tokens: {
      '--paper': M('accent-fill'),
      '--paper-2': M('surface'),
      '--paper-3': M('accent-fill'),
      '--cream': M('background'),
      '--kraft': SERIES(5),
      '--ink': M('on-accent'),
      '--ink-soft': M('on-accent'),
      '--black': M('on-accent'),
      '--red': SERIES(4),
      '--olive': SERIES(3),
      '--orange': SERIES(5),
    },
    scoped: {
      '.note-card, .stat-card.yel': { '--ink': M('text'), color: 'var(--ink)' },
      '.reveal .slides section.s-sec, .stat-card.ink': { '--paper-2': M('accent-fill') },
      '.stamp': { '--red': M('on-accent') },
      ...fillScope('--red', ON_SERIES(4), ['--cream', '--paper', '--ink'], ['.stat-card.red']),
    },
  },
  {
    id: 'pink-script',
    defaults: { background: 'ink', accent: 'rose' },
    tokens: {
      '--ink': M('background'),
      '--ink-2': M('surface'),
      '--paper': M('text'),
      '--pink': M('accent-text'),
      '--pink-2': M('accent-text'),
      '--pink-deep': M('accent-fill'),
      '--line': fade(M('accent-text'), 32),
      '--mute': M('text-muted'),
      '--hair': fade(M('text'), 14),
    },
    scoped: {
      '.pill.solid': { '--pink': M('accent-fill'), '--ink': M('on-accent'), color: 'var(--ink)' },
    },
  },
  {
    id: 'sakura-chroma',
    defaults: { background: 'paper', accent: 'signal-red' },
    tokens: {
      '--paper': M('background'),
      '--paper-dk': M('surface'),
      '--ink': M('text'),
      '--line': M('text'),
      '--red': M('accent-fill'),
      '--pink': SERIES(4),
      '--orange': SERIES(5),
      '--green': SERIES(3),
      '--blue': SERIES(2),
      '--yellow': SERIES(6),
    },
    scoped: {
      ...fillScope('--red', M('on-accent'), ['--paper', '--ink'], ['.c-red', '.stamp']),
      ...fillScope('--pink', ON_SERIES(4), ['--paper', '--ink'], ['.c-pink']),
      ...fillScope('--orange', ON_SERIES(5), ['--paper', '--ink'], ['.c-orange']),
      ...fillScope('--green', ON_SERIES(3), ['--paper', '--ink'], ['.c-green']),
      ...fillScope('--blue', ON_SERIES(2), ['--paper', '--ink'], ['.c-blue']),
      ...fillScope('--yellow', ON_SERIES(6), ['--paper', '--ink'], ['.c-yellow']),
    },
  },
  {
    id: 'stencil-tablet',
    defaults: { background: 'paper', accent: 'tangerine' },
    tokens: {
      '--bone': M('background'),
      '--paper': M('surface'),
      '--ink': M('text'),
      '--black': M('text'),
      '--orange': M('accent-fill'),
      '--teal': SERIES(3),
      '--blue': SERIES(2),
      '--magenta': SERIES(4),
      '--mustard': SERIES(5),
      '--sienna': SERIES(6),
      '--olive': SERIES(3),
    },
    scoped: {
      ...fillScope('--orange', M('on-accent'), ['--bone', '--ink']),
      ...fillScope('--teal', ON_SERIES(3), ['--bone', '--ink'], ['.pill.teal']),
      ...fillScope('--olive', ON_SERIES(3), ['--bone', '--ink']),
      ...fillScope('--blue', ON_SERIES(2), ['--bone', '--ink']),
      ...fillScope('--magenta', ON_SERIES(4), ['--bone', '--ink'], ['.pill.magenta']),
      ...fillScope('--mustard', ON_SERIES(5), ['--bone', '--ink'], ['.pill.mustard']),
      ...fillScope('--sienna', ON_SERIES(6), ['--bone', '--ink']),
    },
  },
];

export const PRESENTATION_STORAGE_KEY = 'gestalt-presentation-color';

/**
 * 반대 밝기 테마와 계열색 위 글자색을 계산하는 ES5 함수. 브라우저 런타임과 Node(정적 기본값)가 같은 문자열을 실행한다.
 * 계열색에는 짝 글자색이 없어서 배경색과 본문색 중 대비가 큰 쪽을 고른다.
 * 밝은 배경의 중간 밝기 계열색은 둘 다 4.5에 못 미쳐서 그때만 검정이나 흰색으로 내린다.
 */
export const PRESENTATION_EXTRA_JS = `function gestaltPresentationVars(sys, t){
  var out = {};
  var alt = sys.resolve({ background: t.tone === 'light' ? 'charcoal' : 'paper', accent: t.accent });
  for (var r in alt.colors) { if (Object.prototype.hasOwnProperty.call(alt.colors, r)) out['--gestalt-alt-' + r] = alt.colors[r]; }
  for (var n = 1; n <= 6; n++) {
    var s = t.colors['series-' + n];
    var on = sys.contrast(s, t.colors.background) >= sys.contrast(s, t.colors.text) ? t.colors.background : t.colors.text;
    if (sys.contrast(s, on) < 4.5) on = sys.contrast(s, '#000000') >= sys.contrast(s, '#FFFFFF') ? '#000000' : '#FFFFFF';
    out['--gestalt-on-series-' + n] = on;
  }
  return out;
}`;

interface PresentationApi {
  resolve(sel: ThemeSelection): { tone: string; accent: string; colors: Record<string, string> };
  contrast(a: string, b: string): number;
  cssText(t: unknown): string;
}

const nodeApi = new Function(
  'catalog',
  `${COLOR_RESOLVER_JS}\n${PRESENTATION_EXTRA_JS}\nvar sys = gestaltColorSystem(catalog);\nreturn { sys: sys, extra: function(t){ return gestaltPresentationVars(sys, t); } };`,
)(COLOR_CATALOG) as {
  sys: PresentationApi;
  extra: (t: unknown) => Record<string, string>;
};

/** 배경과 강조색 쌍의 장표 색 변수 전부(주 테마, 반대 테마, 계열색 위 글자색) */
export function presentationColorVars(sel: ThemeSelection): Record<string, string> {
  const t = nodeApi.sys.resolve(sel);
  const main: Record<string, string> = {};
  for (const [r, v] of Object.entries(t.colors)) main[`--gestalt-color-${r}`] = v;
  return { ...main, ...nodeApi.extra(t) };
}

export function presentationContrast(a: string, b: string): number {
  return nodeApi.sys.contrast(a, b);
}

const MOTION_TARGETS = [
  '.reveal .slides section',
  '.reveal .slides section .fragment',
  '.reveal .backgrounds .slide-background',
  '.reveal .progress span',
  '[data-anim]',
];
const STILL = 'opacity:1!important;transform:none!important;clip-path:none!important';

function motionCss(): string {
  const reduceRoot = ':root[data-gestalt-motion="reduce"]';
  const sysRoot = ':root:not([data-gestalt-motion="full"])';
  const off = (root: string) =>
    `${MOTION_TARGETS.map((s) => `${root} ${s}`).join(',')}{transition:none!important;animation:none!important}` +
    `${root} [data-anim]{${STILL}}`;
  // 인쇄와 PDF에서는 등장 효과가 시작되지 않으므로 등장 전 상태(투명)가 그대로 찍히지 않게 최종 상태로 고정한다
  const printRoots = ['html.print-pdf', 'html.reveal-print'];
  return [
    off(reduceRoot),
    `@media (prefers-reduced-motion: reduce){${off(sysRoot)}}`,
    `${printRoots.map((r) => `${r} [data-anim]`).join(',')}{${STILL};animation:none!important}`,
    `@media print{[data-anim]{${STILL};animation:none!important}}`,
  ].join('\n');
}

/**
 * 원본 템플릿은 글자에 투명도를 줘서 위계를 냈다. 바탕이 테마마다 바뀌면 이 글자들이 대비 기준(4.5:1)을 못 넘어서
 * 글자 요소만 투명도를 1로 고정한다. 위계는 크기와 굵기, 글꼴로 남는다. 도형과 사진 자리의 투명도는 그대로 둔다.
 */
const TEXT_TAGS = [
  'p',
  'span',
  'li',
  'small',
  'em',
  'strong',
  'h1',
  'h2',
  'h3',
  'h4',
  '[class^="t-"]',
  '[class*=" t-"]',
  '.label',
  '.caption',
  '.kicker',
  '.micro',
  '.mono',
  '.foot',
  '.muted',
  // 글자 줄을 통째로 흐리게 한 머리말과 꼬리말
  '.topbar',
  '.meta',
  '.footer',
  '.runner',
  '.masthead',
  '.footline',
  '.slide-chrome',
  '.slide-foot',
  '.bar-label',
];
// 순차 공개(.fragment)와 등장 효과([data-anim])는 투명도로 상태를 나타내므로 건드리지 않는다
const READABLE_CSS = `.reveal .slides section :is(${TEXT_TAGS.join(',')}):not(.fragment):not([data-anim]){opacity:1!important}`;

function scopedCss(theme: PresentationTemplateTheme): string {
  return Object.entries(theme.scoped ?? {})
    .map(
      ([sel, decls]) =>
        `${sel}{${Object.entries(decls)
          .map(([k, v]) => `${k}:${v}`)
          .join(';')}}`,
    )
    .join('\n');
}

/**
 * 장표 조작 스크립트. 클릭으로 다음 항목이나 장으로 넘기고 주소의 background, accent, motion 값을 읽는다.
 * Reveal이 아직 없을 수 있어 클릭 시점에 확인한다.
 */
const DECK_JS = `(function(){
  var root = document.documentElement;
  var sys = window.gestaltTheme.system;
  function extra(t){ var v = gestaltPresentationVars(sys, t); for (var k in v) { if (Object.prototype.hasOwnProperty.call(v, k)) root.style.setProperty(k, v[k]); } }
  extra(sys.resolve({ background: root.getAttribute('data-gestalt-background'), accent: root.getAttribute('data-gestalt-accent') }));
  document.addEventListener('gestalt-theme', function(e){ extra(e.detail); });
  function dec(s){ try { return decodeURIComponent(s); } catch (e) { return ''; } }
  var q = {};
  location.search.replace(/^\\?/, '').split('&').forEach(function(p){ var kv = p.split('='); var k = dec(kv[0]); if (k) q[k] = dec(kv[1] || ''); });
  // 주소 값은 누구나 붙여 보낼 수 있다. 카탈로그에 있는 id만 받아야 저장소에 잘못된 값이 남지 않는다
  var pick = {};
  if (q.background && sys.has('background', q.background)) pick.background = q.background;
  if (q.accent && sys.has('accent', q.accent)) pick.accent = q.accent;
  if (pick.background || pick.accent) { try { window.gestaltTheme.set(pick); } catch (e) {} }
  if (q.motion === 'reduce' || q.motion === 'full') root.setAttribute('data-gestalt-motion', q.motion);
  function reduced(){
    var m = root.getAttribute('data-gestalt-motion');
    if (m === 'reduce') return true;
    if (m === 'full') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  // 모션을 줄이면 순차 공개도 끈다. Reveal은 fragments를 끄면 모든 fragment에 visible을 붙여 클릭 없이 다 보인다
  function calm(){ var R = window.Reveal; if (R && R.configure && reduced()) R.configure({ fragments: false }); }
  document.addEventListener('DOMContentLoaded', function(){
    var R = window.Reveal;
    if (!R) return;
    if (R.isReady && R.isReady()) calm(); else if (R.on) R.on('ready', calm);
  });
  document.addEventListener('click', function(ev){
    var R = window.Reveal;
    if (!R || !R.isReady || !R.isReady() || (R.isOverview && R.isOverview())) return;
    var t = ev.target;
    if (!t || !t.closest || !t.closest('.reveal .slides')) return;
    if (t.closest('a,button,input,select,textarea,label,summary,[contenteditable],[data-no-advance]')) return;
    if (window.getSelection && String(window.getSelection())) return;
    R.next();
  });
})();`;

export const THEME_BLOCK_START = '<!-- gestalt-theme:start -->';
export const THEME_BLOCK_END = '<!-- gestalt-theme:end -->';

/**
 * 템플릿 10종이 같은 스크립트를 한 벌씩 들고 있어서 줄 앞뒤 공백과 //로 시작하는 줄만 걷는다.
 * 줄 이어 쓰기나 템플릿 리터럴처럼 여러 줄에 걸친 문자열은 지원하지 않는다. 걷으면 그 문자열이 바뀐다.
 */
function compactJs(js: string): string {
  return js
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .join('\n');
}

/** 템플릿 </head> 앞에 넣는 블록. 기본 색은 정적 CSS로 깔고 스크립트는 저장된 선택과 주소 값이 있을 때만 덮어쓴다 */
export function presentationThemeBlock(theme: PresentationTemplateTheme): string {
  const vars = presentationColorVars(theme.defaults);
  const rootVars = Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
  return [
    THEME_BLOCK_START,
    '<!-- 생성물: src/visual-system/presentation.ts의 표를 고치고 pnpm presentation:themes로 다시 쓴다 -->',
    '<style id="gestalt-theme">',
    `:root{${rootVars};${MOTION_CSS_VARS}}`,
    scopedCss(theme),
    READABLE_CSS,
    motionCss(),
    '</style>',
    '<script>',
    compactJs(
      [themeRuntimeJs(PRESENTATION_STORAGE_KEY, true), PRESENTATION_EXTRA_JS, DECK_JS].join('\n'),
    ),
    '</script>',
    THEME_BLOCK_END,
  ].join('\n');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 템플릿 HTML을 표에 맞춘다. 여러 번 돌려도 결과가 같다.
 * - <html>에 기본 배경과 강조색 속성
 * - :root 토큰 값을 역할 변수로
 * - </head> 앞 표시 블록
 * - Reveal 설정에 pdfSeparateFragments:false (PDF 한 장에 순차 공개 항목이 모두 찍히게)
 */
export function syncPresentationTemplate(html: string, theme: PresentationTemplateTheme): string {
  let out = html.replace(/<html\b[^>]*>/, (tag) => {
    const clean = tag.replace(/\s+data-gestalt-(background|accent)="[^"]*"/g, '');
    return clean.replace(
      />$/,
      ` data-gestalt-background="${theme.defaults.background}" data-gestalt-accent="${theme.defaults.accent}">`,
    );
  });

  out = out.replace(/:root\s*\{[^}]*\}/, (block) => {
    let b = block;
    for (const [tok, value] of Object.entries(theme.tokens)) {
      const re = new RegExp(`(${escapeRe(tok)}\\s*:\\s*)[^;]+;`);
      if (!re.test(b)) throw new Error(`${theme.id}: :root에 ${tok}가 없다`);
      b = b.replace(re, `$1${value};`);
    }
    return b;
  });

  const block = presentationThemeBlock(theme);
  const existing = new RegExp(
    `${escapeRe(THEME_BLOCK_START)}[\\s\\S]*?${escapeRe(THEME_BLOCK_END)}`,
  );
  out = existing.test(out)
    ? out.replace(existing, () => block)
    : out.replace('</head>', () => `${block}\n</head>`);

  if (!/pdfSeparateFragments\s*:/.test(out)) {
    out = out.replace(/Reveal\.initialize\(\{/, (m) => `${m}\n    pdfSeparateFragments: false,`);
  }
  return out;
}
