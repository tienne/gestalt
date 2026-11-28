import { renderTokenCss } from '../../../src/architecture/html-theme.js';
import {
  ACCENT_PRESETS,
  BACKGROUND_PRESETS,
  resolveColorTheme,
} from '../../../src/visual-system/color.js';

export type Rgba = [number, number, number, number];

export interface ResolvedTokens {
  id: string;
  tone: 'light' | 'dark';
  get(name: string): Rgba;
  raw(name: string): string | undefined;
}

export function parseColor(raw: string): Rgba {
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
export function mix(a: Rgba, p: number, b: Rgba): Rgba {
  const q = 1 - p;
  const alpha = a[3] * p + b[3] * q;
  if (alpha === 0) return [0, 0, 0, 0];
  const ch = (i: number) => (a[i]! * a[3] * p + b[i]! * b[3] * q) / alpha;
  return [ch(0), ch(1), ch(2), alpha];
}

export function over(top: Rgba, bottom: Rgba): Rgba {
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

export function contrast(fg: Rgba, bg: Rgba): number {
  const solidBg = bg[3] < 1 ? over(bg, [255, 255, 255, 1]) : bg;
  const solidFg = fg[3] < 1 ? over(fg, solidBg) : fg;
  const [hi, lo] = [luminance(solidFg), luminance(solidBg)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** 채널 최댓값과 최솟값의 차. 0이면 무채색이다 */
export function chroma(c: Rgba): number {
  return Math.round(Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]));
}

// 토큰 CSS의 첫 :root 블록 둘(공용 테마와 구조도 토큰)을 순서대로 합친다. 뒤에 온 선언이 이긴다
function rootDeclarations(): Map<string, string> {
  const css = renderTokenCss();
  const out = new Map<string, string>();
  for (const m of css.matchAll(/(?:^|\})\s*:root\s*\{([^}]*)\}/g))
    for (const d of m[1]!.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out.set(d[1]!, d[2]!.trim());
  return out;
}

const DECLS = rootDeclarations();

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** 배경과 강조색 한 쌍에서 구조도 토큰을 브라우저처럼 풀어 준다 */
export function resolveTokens(background: string, accent: string): ResolvedTokens {
  const theme = resolveColorTheme({ background, accent });
  const vars = new Map(DECLS);
  for (const [role, value] of Object.entries(theme.colors))
    vars.set(`--gestalt-color-${role}`, value);
  const cache = new Map<string, Rgba>();
  const evaluate = (expr: string): Rgba => {
    const v = expr.trim();
    const ref = /^var\((--[a-z0-9-]+)\)$/.exec(v);
    if (ref) return get(ref[1]!);
    const cm = /^color-mix\(in srgb,\s*(.*)\)$/s.exec(v);
    if (cm) {
      const [a, b] = splitArgs(cm[1]!) as [string, string];
      const pa = /^(.*) (\d+(?:\.\d+)?)%$/.exec(a);
      const pb = /^(.*) (\d+(?:\.\d+)?)%$/.exec(b);
      const p = pa ? Number(pa[2]) / 100 : pb ? 1 - Number(pb[2]) / 100 : 0.5;
      return mix(evaluate(pa ? pa[1]! : a), p, evaluate(pb ? pb[1]! : b));
    }
    return parseColor(v);
  };
  const get = (name: string): Rgba => {
    const hit = cache.get(name);
    if (hit) return hit;
    const raw = vars.get(name);
    if (raw === undefined) throw new Error(`토큰 없음: ${name}`);
    const c = evaluate(raw);
    cache.set(name, c);
    return c;
  };
  return { id: `${background}/${accent}`, tone: theme.tone, get, raw: (n) => DECLS.get(n) };
}

/** 문서 사이트와 같은 204개 테마 */
export const ALL_THEMES: ResolvedTokens[] = BACKGROUND_PRESETS.flatMap((b) =>
  ACCENT_PRESETS.map((a) => resolveTokens(b.id, a.id)),
);

export const BACKGROUND_IDS = BACKGROUND_PRESETS.map((b) => b.id);
