import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCss, renderTokenCss } from '../../../src/architecture/html-theme.js';
import { BUILTIN_PACKS, vocabularyOf } from '../../../src/architecture/packs/index.js';

const SRC = join(__dirname, '../../../src/architecture');
const TOKEN_CSS = renderTokenCss();
const LAYOUT = renderCss(vocabularyOf(BUILTIN_PACKS.map((p) => p.id)));

function tokenBlock(selector: string): Map<string, string> {
  const start = TOKEN_CSS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`토큰 블록 없음: ${selector}`);
  const body = TOKEN_CSS.slice(start, TOKEN_CSS.indexOf('}', start));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

const THEMES = {
  light: tokenBlock(':root'),
  dark: tokenBlock(':root[data-theme="dark"]'),
} as const;

function rgb(theme: keyof typeof THEMES, name: string): [number, number, number] {
  const v = THEMES[theme].get(name);
  const m = v === undefined ? null : /^#([0-9a-f]{6})$/i.exec(v);
  if (!m) throw new Error(`${theme} ${name}는 6자리 hex여야 한다: ${v}`);
  const h = m[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** 채널 최댓값과 최솟값의 차. 0이면 무채색이다 */
function chroma(c: [number, number, number]): number {
  return Math.max(...c) - Math.min(...c);
}

function ruleBody(selector: string): string {
  const at = LAYOUT.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`규칙 없음: ${selector}`);
  return LAYOUT.slice(at, LAYOUT.indexOf('}', at));
}

/** 소스 파일에서 var(token)을 쓰는 규칙의 선택자를 모은다 */
function selectorsUsing(src: string, token: string): string[] {
  const out: string[] = [];
  const needle = `var(${token})`;
  for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) {
    const open = src.lastIndexOf('{', i);
    const from = Math.max(src.lastIndexOf('}', open), src.lastIndexOf('`', open));
    out.push(src.slice(from + 1, open).trim());
  }
  return out;
}

const CSS_SOURCES = ['html-theme.ts', 'delta-renderer.ts', 'live-client.ts'].map((f) =>
  readFileSync(join(SRC, f), 'utf8'),
);

describe('무채색 바탕', () => {
  const SURFACE_TOKENS = [
    '--bg',
    '--surface',
    '--surface-2',
    '--card',
    '--border',
    '--border-strong',
  ];

  it.each(SURFACE_TOKENS)('어두운 테마 %s는 R=G=B 회색이다', (name) => {
    expect(chroma(rgb('dark', name))).toBe(0);
  });

  it('어두운 테마 바탕과 면은 #0f0f0f와 #191919 근처다', () => {
    expect(rgb('dark', '--bg')[0]).toBeLessThanOrEqual(0x14);
    expect(Math.abs(rgb('dark', '--surface')[0] - 0x19)).toBeLessThanOrEqual(4);
  });

  it('밝은 테마는 따뜻한 회색 바탕과 흰 면이다', () => {
    const [r, g, b] = rgb('light', '--bg');
    expect(r).toBeGreaterThanOrEqual(g);
    expect(g).toBeGreaterThanOrEqual(b);
    expect(r - b).toBeLessThanOrEqual(4);
    expect(Math.abs(r - 0xf3)).toBeLessThanOrEqual(4);
    expect(THEMES.light.get('--surface')).toBe('#ffffff');
    expect(THEMES.light.get('--card')).toBe('#ffffff');
  });
});

describe('글자 4단계', () => {
  const LEVELS = ['--text', '--text-2', '--text-3', '--text-4'];

  it.each(['light', 'dark'] as const)(
    '%s 테마에 네 단계가 무채색으로 있고 바탕에서 멀수록 앞 단계다',
    (theme) => {
      const bg = rgb(theme, '--bg')[0];
      const dist = LEVELS.map((n) => {
        expect(chroma(rgb(theme, n))).toBe(0);
        return Math.abs(rgb(theme, n)[0] - bg);
      });
      expect([...dist].sort((a, b) => b - a)).toEqual(dist);
    },
  );

  it('--muted 토큰은 없어졌고 아무 규칙도 읽지 않는다', () => {
    expect(THEMES.light.has('--muted')).toBe(false);
    expect(THEMES.dark.has('--muted')).toBe(false);
    for (const src of CSS_SOURCES) expect(src).not.toContain('var(--muted)');
  });

  it('--text-4는 비활성 질문과 출처 표기, 장식 화살표 세 자리에만 쓴다', () => {
    const used = CSS_SOURCES.flatMap((src) => selectorsUsing(src, '--text-4'));
    expect(used.sort()).toEqual(['.infra-credit', '.q:disabled .q-subj', '.sp-arrow']);
  });
});

describe('잉크 강조', () => {
  it.each(['light', 'dark'] as const)('%s 테마 --accent는 파랑이 아니라 글자색 잉크다', (theme) => {
    expect(chroma(rgb(theme, '--accent'))).toBe(0);
    expect(Math.abs(rgb(theme, '--accent')[0] - rgb(theme, '--text')[0])).toBeLessThanOrEqual(8);
  });

  it('카드 테두리 묶음과 이 단계 카드 테두리도 무채색이다', () => {
    for (const theme of ['light', 'dark'] as const)
      expect(chroma(rgb(theme, '--frame-line'))).toBe(0);
    expect(ruleBody('.node.is-focus')).toContain('border-color: var(--accent)');
  });

  it('의미 색은 남는다', () => {
    for (const theme of ['light', 'dark'] as const)
      for (const name of ['--x-account', '--loads', '--warn'])
        expect(chroma(rgb(theme, name))).toBeGreaterThan(60);
  });

  it('본문 안 링크는 색 대신 밑줄로 구분한다', () => {
    expect(ruleBody('a.loc')).toContain('text-decoration: underline');
  });
});

describe('회색 선, 고른 선만 강조', () => {
  it.each(['light', 'dark'] as const)(
    '%s 테마 기본 선은 무채색에 불투명도 .5 안팎이다',
    (theme) => {
      expect(chroma(rgb(theme, '--edge'))).toBe(0);
      const alpha = Number(THEMES[theme].get('--edge-alpha'));
      expect(alpha).toBeGreaterThanOrEqual(0.4);
      expect(alpha).toBeLessThanOrEqual(0.6);
    },
  );

  it('기본 선 규칙은 --edge와 --edge-alpha를 읽는다', () => {
    const body = ruleBody('.link .edge');
    expect(body).toContain('stroke: var(--edge)');
    expect(body).toContain('stroke-opacity: var(--edge-alpha)');
  });

  it('로드 선은 기본에 회색으로 물리고 점 패턴은 남긴다', () => {
    const body = ruleBody('.link.e-loads .edge');
    expect(body).toContain('stroke: var(--edge)');
    expect(Number(/stroke-opacity: ([\d.]+)/.exec(body)?.[1])).toBeLessThanOrEqual(0.5);
    expect(LAYOUT).toContain(
      '.link.e-loads .edge:not([stroke-dasharray]) { stroke-dasharray: 1 6;',
    );
  });

  it('고르거나 올린 로드 선과 계정 넘는 선은 의미 색으로 뜨고 일반 강조보다 뒤에 온다', () => {
    const generic = LAYOUT.indexOf('\n.link.lit .edge, .link:hover .edge {');
    const loads = LAYOUT.indexOf(
      '\n.link.e-loads.lit .edge, .link.e-loads:hover .edge { stroke: var(--loads);',
    );
    const cross = LAYOUT.indexOf(
      '\n.link.x-account.lit .edge, .link.x-account:hover .edge { stroke: var(--x-account);',
    );
    expect(generic).toBeGreaterThan(0);
    expect(loads).toBeGreaterThan(generic);
    expect(cross).toBeGreaterThan(generic);
  });
});

describe('점 격자', () => {
  it('캔버스에 24px 간격 점 격자를 토큰 색으로 깐다', () => {
    expect(LAYOUT).toMatch(
      /\n\.stage \{ background-image: radial-gradient\(circle, var\(--grid-dot\) [^)]+\); background-size: 24px 24px; \}/,
    );
    for (const theme of ['light', 'dark'] as const)
      expect(chroma(rgb(theme, '--grid-dot'))).toBeLessThanOrEqual(5);
  });

  it('인쇄에서는 격자를 끈다', () => {
    expect(LAYOUT).toContain('@media print { .stage { background-image: none; } }');
  });
});

describe('원 안 숫자', () => {
  it('덩어리 순서 숫자는 flex 가운데 정렬을 기본으로 두고 text-box를 아는 브라우저에서만 대문자 높이로 자른다', () => {
    const src = CSS_SOURCES[0]!;
    const at = src.indexOf('\n.ch-head .ord {');
    expect(at).toBeGreaterThan(0);
    const base = src.slice(at, src.indexOf('}', at));
    expect(base).toContain('display: inline-flex');
    expect(base).toContain('align-items: center');
    expect(base).not.toContain('text-box');
    const sup = src.indexOf('@supports (text-box: trim-both cap alphabetic) {', at);
    expect(sup).toBeGreaterThan(at);
    const trim = src.slice(sup, src.indexOf('}', sup));
    expect(trim).toContain('.ch-head .ord');
    expect(trim).toContain('text-box: trim-both cap alphabetic');
    expect(trim).toContain('padding: calc((22px - 1cap) / 2) 6px');
  });
});

describe('색 값은 html-theme.ts에만', () => {
  const others = readdirSync(SRC, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts') && d.name !== 'html-theme.ts')
    .map((d) => d.name);

  it.each(others)('%s에 hex나 rgb 색 값이 없다', (name) => {
    const src = readFileSync(join(SRC, name), 'utf8');
    expect(src).not.toMatch(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|\brgba?\(|\bhsla?\(/i);
  });
});
