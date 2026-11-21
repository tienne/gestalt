import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DRILL_CSS,
  renderCss,
  renderTokenCss,
  PRODUCT_PALETTE,
} from '../../../src/architecture/html-theme.js';
import { BUILTIN_PACKS, vocabularyOf } from '../../../src/architecture/packs/index.js';

/**
 * 카드 위 글자 대비를 CSS 그대로 계산한다. color-mix(in srgb)는 감마 인코딩된 sRGB 값을 섞고
 * transparent와 섞으면 알파만 줄어든다. 반투명 배경은 카드 면 위에 합성한 뒤 대비를 잰다
 */
type Rgba = [number, number, number, number];

function parseColor(raw: string): Rgba {
  const v = raw.trim();
  if (v === 'transparent') return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join('') : hex[1]!;
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
      1,
    ];
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(v);
  if (fn) {
    const parts = fn[1]!.split(',').map((p) => Number(p.trim()));
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
  }
  throw new Error(`알 수 없는 색: ${raw}`);
}

/** color-mix(in srgb, a p%, b) — 알파는 premultiplied로 섞는다 */
function mix(a: Rgba, p: number, b: Rgba): Rgba {
  const q = 1 - p;
  const alpha = a[3] * p + b[3] * q;
  if (alpha === 0) return [0, 0, 0, 0];
  const ch = (i: number) => (a[i]! * a[3] * p + b[i]! * b[3] * q) / alpha;
  return [ch(0), ch(1), ch(2), alpha];
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i]! * a + bottom[i]! * (1 - a)).concat(1) as Rgba;
}

function luminance(c: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

function contrast(fg: Rgba, bg: Rgba): number {
  const solidBg = bg[3] < 1 ? over(bg, [255, 255, 255, 1]) : bg;
  const solidFg = fg[3] < 1 ? over(fg, solidBg) : fg;
  const [hi, lo] = [luminance(solidFg), luminance(solidBg)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

function tokenBlock(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`토큰 블록 없음: ${selector}`);
  const body = css.slice(start, css.indexOf('}', start));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

const TOKEN_CSS = renderTokenCss();
const THEMES = {
  light: tokenBlock(TOKEN_CSS, ':root'),
  dark: tokenBlock(TOKEN_CSS, ':root[data-theme="dark"]'),
} as const;

function tok(theme: keyof typeof THEMES, name: string): Rgba {
  const v = THEMES[theme].get(name);
  if (v === undefined) throw new Error(`${theme} 토큰 없음: ${name}`);
  return parseColor(v);
}

/** CSS 규칙 본문에서 color-mix 비율을 읽는다. 숫자를 테스트에 따로 적으면 CSS만 바뀌었을 때 못 잡는다 */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`규칙 없음: ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}

const LAYOUT = renderCss(vocabularyOf(BUILTIN_PACKS.map((p) => p.id)));
const KC = ruleBody(LAYOUT, '.kc');
const KC_FG =
  Number(/color: color-mix\(in srgb, var\(--kind\) (\d+)%, var\(--text\)\)/.exec(KC)?.[1]) / 100;
const KC_BG =
  Number(/background: color-mix\(in srgb, var\(--kind\) (\d+)%, transparent\)/.exec(KC)?.[1]) / 100;

const KIND_COLORS = new Map<string, { light: string; dark: string }>();
for (const pack of BUILTIN_PACKS) {
  const vocab = vocabularyOf([pack.id]);
  for (const [kind, look] of Object.entries(vocab.looks))
    KIND_COLORS.set(`${pack.id}/${kind}`, look.color);
}

const MIN_TEXT_CONTRAST = 4.5;

interface Row {
  theme: string;
  text: string;
  ratio: number;
}

function cardRows(theme: 'light' | 'dark'): Row[] {
  const card = tok(theme, '--card');
  const text = tok(theme, '--text');
  const meta = tok(theme, '--text-3');
  const rows: Row[] = [
    { theme, text: '.nm 이름', ratio: contrast(text, card) },
    { theme, text: '.tc 둘째 줄', ratio: contrast(meta, card) },
    { theme, text: '.ds 설명', ratio: contrast(tok(theme, '--text-2'), card) },
    { theme, text: '.go 들어가기', ratio: contrast(meta, card) },
    { theme, text: '.pf 출처 배지', ratio: contrast(meta, card) },
    {
      theme,
      text: '.guess 추정 배지',
      ratio: contrast(tok(theme, '--warn'), over(tok(theme, '--warn-soft'), card)),
    },
    {
      theme,
      text: '.flow-badge 흐름 배지',
      ratio: contrast(tok(theme, '--on-accent'), tok(theme, '--accent')),
    },
    {
      theme,
      text: '.flow-step .st 단계',
      ratio: contrast(meta, over(tok(theme, '--lane'), card)),
    },
    { theme, text: '.flow-step .qb 질문', ratio: contrast(tok(theme, '--warn'), card) },
    { theme, text: '.flow-step .end 끝', ratio: contrast(tok(theme, '--surface'), text) },
  ];
  for (const [key, color] of KIND_COLORS) {
    const kind = parseColor(color[theme]);
    const fg = mix(kind, KC_FG, text);
    const bg = over(mix(kind, KC_BG, [0, 0, 0, 0]), card);
    rows.push({ theme, text: `.kc 칩 ${key}`, ratio: contrast(fg, bg) });
  }
  for (const [i, p] of PRODUCT_PALETTE.entries()) {
    rows.push({
      theme,
      text: `.pb 제품 브릭 p-${i}`,
      ratio: contrast([255, 255, 255, 1], parseColor(p)),
    });
  }
  return rows;
}

/** 레인은 면이 없어 제목이 캔버스 배경 위에 바로 놓인다. 바깥 맥락 레인도 같다 */
function laneRows(theme: 'light' | 'dark'): Row[] {
  const bg = tok(theme, '--bg');
  const meta = tok(theme, '--text-3');
  return [
    { theme, text: '.lane-title 레인 제목', ratio: contrast(meta, bg) },
    { theme, text: '.lane-title .n 개수', ratio: contrast(meta, tok(theme, '--surface')) },
    { theme, text: '.lane-title .more +N', ratio: contrast(meta, bg) },
  ];
}

/** 드릴다운 큰 카드 칩 줄, 바깥 알약, 덩어리 카드, 단계 머리 */
function drillRows(theme: 'light' | 'dark'): Row[] {
  const bg = tok(theme, '--bg');
  const card = tok(theme, '--card');
  const text = tok(theme, '--text');
  const text2 = tok(theme, '--text-2');
  const meta = tok(theme, '--text-3');
  return [
    { theme, text: '.cr-n 항목 수 칩', ratio: contrast(text2, tok(theme, '--surface-2')) },
    { theme, text: '.out-pill .ext 바깥 표시', ratio: contrast(meta, card) },
    { theme, text: '.chunk .t 덩어리 이름', ratio: contrast(text, card) },
    { theme, text: '.chunk .ds 대표 이름 줄', ratio: contrast(text2, card) },
    {
      theme,
      text: '.ch-head .ord 레인 순서',
      ratio: contrast(tok(theme, '--on-accent'), tok(theme, '--accent')),
    },
    { theme, text: '.lh-kind 단계 종류', ratio: contrast(meta, bg) },
    { theme, text: '.lh-title 단계 제목', ratio: contrast(text, bg) },
    { theme, text: '.lh-sum 단계 요약', ratio: contrast(text2, bg) },
  ];
}

/** 개요 패널은 --surface 위에 놓인다 */
function overviewRows(theme: 'light' | 'dark'): Row[] {
  const surface = tok(theme, '--surface');
  return [
    {
      theme,
      text: '.overview 제목과 .ov-sum 요약',
      ratio: contrast(tok(theme, '--text'), surface),
    },
    {
      theme,
      text: '.ov-note 일러두기와 .ov-stats dt',
      ratio: contrast(tok(theme, '--text-2'), surface),
    },
    { theme, text: '.ov-h 소제목', ratio: contrast(tok(theme, '--text-3'), surface) },
    { theme, text: '.ov-tile b 숫자', ratio: contrast(tok(theme, '--text'), surface) },
    { theme, text: '.ov-tile span 이름', ratio: contrast(tok(theme, '--text-3'), surface) },
    {
      theme,
      text: '.ov-lanes a 레인 목록(눌렀을 때)',
      ratio: contrast(tok(theme, '--text'), tok(theme, '--surface-2')),
    },
    { theme, text: '.ov-lanes a 레인 목록', ratio: contrast(tok(theme, '--text-2'), surface) },
  ];
}

const TEXT_LEVELS = ['--text', '--text-2', '--text-3'] as const;
const SURFACES = ['--bg', '--surface', '--surface-2', '--card'] as const;

/** 본문, 설명, 메타 세 단계는 어느 면에 놓여도 읽혀야 한다. 잉크 강조는 글자로도 쓰여 같은 기준을 건다 */
function levelRows(theme: 'light' | 'dark'): Row[] {
  const rows: Row[] = [];
  for (const level of [...TEXT_LEVELS, '--accent'] as const)
    for (const surface of SURFACES)
      rows.push({
        theme,
        text: `${level} on ${surface}`,
        ratio: contrast(tok(theme, level), tok(theme, surface)),
      });
  rows.push(
    {
      theme,
      text: '.btn[aria-pressed] 눌린 단추',
      ratio: contrast(
        tok(theme, '--accent'),
        over(tok(theme, '--accent-soft'), tok(theme, '--surface')),
      ),
    },
    {
      theme,
      text: '.search-list .lv 고른 줄의 위치',
      ratio: contrast(
        tok(theme, '--text-3'),
        over(tok(theme, '--accent-soft'), tok(theme, '--surface')),
      ),
    },
    {
      theme,
      text: '.live-ask button 잉크 단추',
      ratio: contrast(tok(theme, '--on-accent'), tok(theme, '--accent')),
    },
  );
  return rows;
}

describe('카드 위 글자 대비', () => {
  const rows = [
    ...cardRows('light'),
    ...cardRows('dark'),
    ...laneRows('light'),
    ...laneRows('dark'),
    ...drillRows('light'),
    ...drillRows('dark'),
    ...overviewRows('light'),
    ...overviewRows('dark'),
    ...levelRows('light'),
    ...levelRows('dark'),
  ];

  it('kc 칩 비율을 CSS에서 읽는다', () => {
    expect(KC_FG).toBeGreaterThan(0);
    expect(KC_BG).toBeGreaterThan(0);
  });

  it('모든 팩의 kind 색이 대상에 들어 있다', () => {
    expect(KIND_COLORS.size).toBeGreaterThan(30);
  });

  it.each(rows.map((r) => [`${r.theme} ${r.text}`, r] as const))('%s 4.5:1 이상', (_name, row) => {
    expect(row.ratio).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  // 보고서에 숫자를 옮길 때만 켠다
  it.runIf(process.env.CONTRAST_REPORT)('대비 표를 파일로 남긴다', () => {
    const lines = rows.map((r) => `${r.theme}\t${r.text}\t${r.ratio.toFixed(2)}`);
    writeFileSync(process.env.CONTRAST_REPORT!, lines.join('\n') + '\n');
  });

  it('카드 설명 대비가 예전 어두운 서버 카드(2.48:1)보다 높다', () => {
    const ds = rows.filter((r) => r.text === '.ds 설명').map((r) => r.ratio);
    expect(Math.min(...ds)).toBeGreaterThan(2.48);
  });
});

describe('카드 설명 줄', () => {
  const DS = ruleBody(LAYOUT, '.ds');

  it('12px 글꼴의 17px 줄이고 --text-2 색이다', () => {
    expect(DS).toContain('font: 12px/17px var(--font)');
    expect(DS).toContain('color: var(--text-2)');
  });

  it('평면 그림 카드는 한 줄 말줄임이고 여러 줄로 접지 않는다', () => {
    expect(DS).toContain('white-space: nowrap');
    expect(DS).toContain('text-overflow: ellipsis');
    expect(DS).not.toMatch(/line-clamp/);
    expect(LAYOUT).not.toMatch(/\.ds[^{]*\{[^}]*line-clamp/);
  });

  it('드릴다운 큰 카드는 13px 글꼴의 19px 줄로 세 줄까지 접는다', () => {
    const LG = ruleBody(`\n${DRILL_CSS}`, '.node.lg .ds');
    expect(LG).toContain('font: 13px/19px var(--font)');
    expect(LG).toContain('-webkit-line-clamp: 3');
    expect(LG).toContain('white-space: normal');
  });
});
