import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DRILL_CSS, renderCss, PRODUCT_PALETTE } from '../../../src/architecture/html-theme.js';
import { BUILTIN_PACKS, vocabularyOf } from '../../../src/architecture/packs/index.js';
import {
  ALL_THEMES,
  contrast,
  mix,
  over,
  parseColor,
  type ResolvedTokens,
  type Rgba,
} from './role-tokens.js';

/**
 * 카드 위 글자 대비를 CSS 그대로 계산한다. 토큰은 Gestalt 색 역할을 읽으므로 문서 사이트와 같은 204개 테마로 풀어 보고
 * 글자 자리마다 가장 낮은 값을 기준과 비교한다. 반투명 배경은 그 아래 면 위에 합성한 뒤 대비를 잰다
 */
/** CSS 규칙 본문에서 color-mix 비율을 읽는다. 숫자를 테스트에 따로 적으면 CSS만 바뀌었을 때 못 잡는다 */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`규칙 없음: ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}

const LAYOUT = renderCss(vocabularyOf(BUILTIN_PACKS.map((p) => p.id)));
const KC = ruleBody(LAYOUT, '.kc');
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

type Theme = ResolvedTokens;
const tok = (t: Theme, name: string): Rgba => t.get(name);

function cardRows(t: Theme): Row[] {
  const theme = t.id;
  const card = tok(t, '--card');
  const text = tok(t, '--text');
  const meta = tok(t, '--text-3');
  const rows: Row[] = [
    { theme, text: '.nm 이름', ratio: contrast(text, card) },
    { theme, text: '.tc 둘째 줄', ratio: contrast(meta, card) },
    { theme, text: '.ds 설명', ratio: contrast(tok(t, '--text-2'), card) },
    { theme, text: '.go 들어가기', ratio: contrast(meta, card) },
    { theme, text: '.pf 출처 배지', ratio: contrast(meta, card) },
    { theme, text: '.guess 추정 배지', ratio: contrast(tok(t, '--warn'), card) },
    {
      theme,
      text: '.flow-badge 흐름 배지',
      ratio: contrast(tok(t, '--on-accent'), tok(t, '--accent-fill')),
    },
    {
      theme,
      text: '.flow-step .st 단계',
      ratio: contrast(meta, over(tok(t, '--lane'), card)),
    },
    { theme, text: '.flow-step .qb 질문', ratio: contrast(tok(t, '--warn'), card) },
    { theme, text: '.flow-step .end 끝', ratio: contrast(tok(t, '--surface'), text) },
  ];
  for (const [key, color] of KIND_COLORS) {
    const kind = parseColor(color[t.tone]);
    const fg = text;
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
function laneRows(t: Theme): Row[] {
  const theme = t.id;
  const bg = tok(t, '--bg');
  const meta = tok(t, '--text-3');
  return [
    { theme, text: '.lane-title 레인 제목', ratio: contrast(meta, bg) },
    { theme, text: '.lane-title .n 개수', ratio: contrast(meta, tok(t, '--surface')) },
    { theme, text: '.lane-title .more +N', ratio: contrast(meta, bg) },
  ];
}

/** 드릴다운 큰 카드 칩 줄, 바깥 알약, 덩어리 카드, 단계 머리 */
function drillRows(t: Theme): Row[] {
  const theme = t.id;
  const bg = tok(t, '--bg');
  const card = tok(t, '--card');
  const text = tok(t, '--text');
  const text2 = tok(t, '--text-2');
  const meta = tok(t, '--text-3');
  return [
    { theme, text: '.cr-n 항목 수 칩', ratio: contrast(text2, tok(t, '--surface-2')) },
    { theme, text: '.out-pill .ext 바깥 표시', ratio: contrast(meta, card) },
    { theme, text: '.chunk .t 덩어리 이름', ratio: contrast(text, card) },
    { theme, text: '.chunk .ds 대표 이름 줄', ratio: contrast(text2, card) },
    {
      theme,
      text: '.ch-head .ord 레인 순서',
      ratio: contrast(tok(t, '--on-accent'), tok(t, '--accent-fill')),
    },
    { theme, text: '.lh-kind 단계 종류', ratio: contrast(meta, bg) },
    { theme, text: '.lh-title 단계 제목', ratio: contrast(text, bg) },
    { theme, text: '.lh-sum 단계 요약', ratio: contrast(text2, bg) },
  ];
}

/** 개요 패널은 --surface 위에 놓인다 */
function overviewRows(t: Theme): Row[] {
  const theme = t.id;
  const surface = tok(t, '--surface');
  return [
    {
      theme,
      text: '.overview 제목과 .ov-sum 요약',
      ratio: contrast(tok(t, '--text'), surface),
    },
    {
      theme,
      text: '.ov-note 일러두기와 .ov-stats dt',
      ratio: contrast(tok(t, '--text-2'), surface),
    },
    { theme, text: '.ov-h 소제목', ratio: contrast(tok(t, '--text-3'), surface) },
    { theme, text: '.ov-tile b 숫자', ratio: contrast(tok(t, '--text'), surface) },
    { theme, text: '.ov-tile span 이름', ratio: contrast(tok(t, '--text-3'), surface) },
    {
      theme,
      text: '.ov-lanes a 레인 목록(눌렀을 때)',
      ratio: contrast(tok(t, '--text'), tok(t, '--surface-2')),
    },
    { theme, text: '.ov-lanes a 레인 목록', ratio: contrast(tok(t, '--text-2'), surface) },
  ];
}

const TEXT_LEVELS = ['--text', '--text-2', '--text-3'] as const;
const SURFACES = ['--bg', '--surface', '--surface-2', '--card'] as const;

/** 본문, 설명, 메타 세 단계는 어느 면에 놓여도 읽혀야 한다. 강조 글자는 역할이 보장하는 바탕과 면 위에서만 잰다 */
function levelRows(t: Theme): Row[] {
  const theme = t.id;
  const rows: Row[] = [];
  for (const level of TEXT_LEVELS)
    for (const surface of SURFACES)
      rows.push({
        theme,
        text: `${level} on ${surface}`,
        ratio: contrast(tok(t, level), tok(t, surface)),
      });
  for (const surface of ['--bg', '--surface', '--card'] as const)
    rows.push({
      theme,
      text: `--accent on ${surface}`,
      ratio: contrast(tok(t, '--accent'), tok(t, surface)),
    });
  rows.push(
    {
      theme,
      text: '.btn[aria-pressed] 눌린 단추',
      ratio: contrast(tok(t, '--accent'), tok(t, '--surface')),
    },
    {
      theme,
      text: '.search-list .lv 고른 줄의 위치',
      ratio: contrast(tok(t, '--text-3'), over(tok(t, '--accent-soft'), tok(t, '--surface'))),
    },
    {
      theme,
      text: '.live-ask button 강조 단추',
      ratio: contrast(tok(t, '--on-accent'), tok(t, '--accent-fill')),
    },
  );
  return rows;
}

describe('카드 위 글자 대비', () => {
  // 글자 자리마다 204개 테마 중 가장 낮은 값만 남긴다
  const worst = new Map<string, Row>();
  for (const t of ALL_THEMES)
    for (const r of [
      ...cardRows(t),
      ...laneRows(t),
      ...drillRows(t),
      ...overviewRows(t),
      ...levelRows(t),
    ]) {
      const prev = worst.get(r.text);
      if (!prev || r.ratio < prev.ratio) worst.set(r.text, r);
    }
  const rows = [...worst.values()];

  it('kc 칩은 본문 글자색에 kind 색을 옅게 깐다', () => {
    expect(KC).toContain('color: var(--text)');
    expect(KC_BG).toBeGreaterThan(0);
  });

  it('모든 팩의 kind 색이 대상에 들어 있다', () => {
    expect(KIND_COLORS.size).toBeGreaterThan(30);
  });

  it.each(rows.map((r) => [r.text, r] as const))('%s 204개 테마 모두 4.5:1 이상', (_name, row) => {
    expect(row.ratio, row.theme).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
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
