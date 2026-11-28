import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCENT_PRESETS, BACKGROUND_PRESETS } from '../../../src/visual-system/color.js';
import {
  PRESENTATION_EXTRA_JS,
  PRESENTATION_THEMES,
  THEME_BLOCK_END,
  THEME_BLOCK_START,
  presentationColorVars,
  presentationContrast,
  presentationThemeBlock,
  syncPresentationTemplate,
} from '../../../src/visual-system/presentation.js';

const dir = resolve('plugin/role-agents/presentation-designer/templates');
const read = (id: string) => readFileSync(resolve(dir, `${id}.html`), 'utf8');

function outsideBlock(html: string): string {
  const s = html.indexOf(THEME_BLOCK_START);
  const e = html.indexOf(THEME_BLOCK_END);
  return html.slice(0, s) + html.slice(e + THEME_BLOCK_END.length);
}

describe('장표 템플릿 테마', () => {
  it('대표 템플릿 10종이 동기화 결과와 같다', () => {
    expect(PRESENTATION_THEMES).toHaveLength(10);
    for (const t of PRESENTATION_THEMES) {
      const html = read(t.id);
      expect(syncPresentationTemplate(html, t), t.id).toBe(html);
    }
  });

  it('테마 블록 밖에 고정색이 없다', () => {
    for (const t of PRESENTATION_THEMES) {
      // 폰트 주소와 SVG 데이터 주소의 # 문자는 색이 아니라서 따옴표 안 주소를 먼저 지운다
      const css = outsideBlock(read(t.id))
        .replace(/https?:\/\/[^"')\s]+/g, '')
        .replace(/&#\d+;/g, '');
      expect(css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? [], t.id).toEqual([]);
    }
  });

  it('순차 공개 항목과 PDF 한 장 출력 설정이 있다', () => {
    for (const t of PRESENTATION_THEMES) {
      const html = read(t.id);
      expect(html, t.id).toMatch(/class="[^"]*\bfragment\b/);
      expect(html, t.id).toMatch(/Reveal\.initialize\(\{\s*pdfSeparateFragments: false,/);
      expect(html, t.id).toContain(`data-gestalt-background="${t.defaults.background}"`);
      expect(html, t.id).toContain(`data-gestalt-accent="${t.defaults.accent}"`);
    }
  });

  it('여러 번 돌려도 결과가 같다', () => {
    const t = PRESENTATION_THEMES[0]!;
    const once = syncPresentationTemplate(read(t.id), t);
    expect(syncPresentationTemplate(once, t)).toBe(once);
  });

  it('204개 테마에서 계열색 위 글자와 반대 바탕 글자가 기준을 넘는다', () => {
    const fails: string[] = [];
    for (const b of BACKGROUND_PRESETS) {
      for (const a of ACCENT_PRESETS) {
        const v = presentationColorVars({ background: b.id, accent: a.id });
        for (let n = 1; n <= 6; n++) {
          const r = presentationContrast(
            v[`--gestalt-on-series-${n}`]!,
            v[`--gestalt-color-series-${n}`]!,
          );
          if (r < 4.5) fails.push(`${b.id}/${a.id} series-${n} ${r.toFixed(2)}`);
        }
        const alt = presentationContrast(v['--gestalt-alt-text']!, v['--gestalt-alt-background']!);
        if (alt < 4.5) fails.push(`${b.id}/${a.id} alt ${alt.toFixed(2)}`);
      }
    }
    expect(fails).toEqual([]);
  });

  it('테마 블록 스크립트는 ES5 스크립트로 해석된다', () => {
    expect(() => new Function(PRESENTATION_EXTRA_JS)).not.toThrow();
    const block = presentationThemeBlock(PRESENTATION_THEMES[0]!);
    const js = block.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
    expect(js.length).toBeGreaterThan(0);
    expect(() => new Function(js)).not.toThrow();
  });
});
