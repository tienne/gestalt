import { describe, expect, it } from 'vitest';
import {
  ACCENT_PRESETS,
  BACKGROUND_PRESETS,
  DEFAULT_THEME,
  resolveColorTheme,
  updateSelection,
} from '../../../src/visual-system/color.js';
import { checkAllThemes } from '../../../src/visual-system/contrast.js';
import { buildDocsSite } from '../../../src/visual-system/docs-site.js';
import { diagramMotionCss } from '../../../src/digest/diagram-css.js';
import { examples } from '../../../src/visual-system/examples.js';
import {
  VISUAL_STEP_JS,
  WIDGET_RUNTIME_JS,
  themeRuntimeJs,
} from '../../../src/visual-system/runtime.js';
import { SCREENS, type ScreenEntry } from '../../../src/visual-system/inventory.js';
import { screenProgressProblems, verifyVisualSystem } from '../../../src/visual-system/verify.js';

describe('컬러 시스템', () => {
  it('배경 6개와 강조색 34개를 따로 고른다', () => {
    expect(BACKGROUND_PRESETS).toHaveLength(6);
    expect(ACCENT_PRESETS).toHaveLength(34);
    const other = ACCENT_PRESETS.find((a) => a.id !== 'orange-red')!.id;
    expect(
      updateSelection({ background: 'paper', accent: 'orange-red' }, { accent: other }),
    ).toEqual({ background: 'paper', accent: other });
    expect(
      updateSelection({ background: 'paper', accent: other }, { background: 'white' }),
    ).toEqual({ background: 'white', accent: other });
    expect(updateSelection({ background: 'paper', accent: other }, { background: 'nope' })).toEqual(
      { background: 'paper', accent: other },
    );
  });

  it('기본값은 차콜 배경과 시안 강조색이다', () => {
    const t = resolveColorTheme();
    expect(DEFAULT_THEME).toEqual({ background: 'charcoal', accent: 'cyan' });
    expect(t.colors.background).toBe('#171717');
    expect(t.colors['accent-fill']).toBe('#62D3EA');
  });

  it('204개 테마 전부 역할별 대비 기준을 넘는다', () => {
    const s = checkAllThemes();
    expect(s.themes).toBe(204);
    expect(s.failures).toEqual([]);
  });
});

describe('시각화 시스템', () => {
  it('전수 검사에서 문제가 없다', () => {
    const r = verifyVisualSystem();
    expect(r.problems).toEqual([]);
    expect(r.catalog).toBe(71);
  });

  it('단계 있는 예제는 마지막 단계를 기본으로 그린다', () => {
    for (const e of examples()) {
      for (const m of e.html.matchAll(/data-vs-steps="(\d+)" data-vs-current="(\d+)"/g)) {
        expect(m[2], e.catalogId).toBe(m[1]);
      }
      // 정지본에서 흐리게 처리된 요소가 있으면 스크립트 없이 최종 값이 안 보인다
      expect(e.html, e.catalogId).not.toMatch(/class="[^"]*\bvs-off\b/);
    }
  });

  it('런타임 문자열은 ES5 스크립트로 해석된다', () => {
    for (const src of [VISUAL_STEP_JS, WIDGET_RUNTIME_JS, themeRuntimeJs()]) {
      expect(() => new Function(src)).not.toThrow();
    }
  });

  it('문서 사이트는 외부 스크립트와 스타일 없이 파일 하나로 열린다', () => {
    const { html } = buildDocsSite();
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
    const hosts = new Set([...html.matchAll(/href="https?:\/\/([^/"]+)/g)].map((m) => m[1]));
    expect([...hosts]).toEqual([]);
  });

  it('예제마다 모션 재생 버튼이 있고 제품 도식은 요약 뷰어와 같은 진입 모션을 쓴다', () => {
    const { html } = buildDocsSite();
    const exs = html.match(/<article class="ex">/g) ?? [];
    const btns = html.match(/data-ex-replay hidden>모션 재생<\/button>/g) ?? [];
    expect(exs.length).toBeGreaterThan(0);
    expect(btns).toHaveLength(exs.length);
    expect(html).toContain(diagramMotionCss('.vs-product '));
    expect(diagramMotionCss('.vs-product ')).not.toMatch(/(^|[^ ])\.armed/m);
    expect(
      () =>
        new Function(html.match(/<script>(\(function\(\)\{\n {2}var root[\s\S]*?)<\/script>/)![1]!),
    ).not.toThrow();
  });
});

describe('화면 이행 순서', () => {
  const at = (id: string, phase: 1 | 2 | 3, status: ScreenEntry['status'], evidence = ['근거']) =>
    ({ ...SCREENS[0]!, id, phase, status, evidence, motions: [] }) as ScreenEntry;

  it('2차 화면이 전부 검증돼야 3차를 연다', () => {
    expect(screenProgressProblems([at('a', 2, 'applied'), at('b', 3, 'in-progress')])).toEqual([
      'b: 3차를 열었는데 앞 단계에 검증 안 된 화면 있음 (a)',
    ]);
    expect(screenProgressProblems([at('a', 2, 'verified'), at('b', 3, 'in-progress')])).toEqual([]);
  });

  it('제외한 앞 단계 화면은 막지 않고 계획만 잡힌 다음 단계도 막지 않는다', () => {
    expect(
      screenProgressProblems([
        at('a', 2, 'out-of-scope'),
        at('b', 2, 'applied'),
        at('c', 3, 'planned'),
      ]),
    ).toEqual([]);
  });

  it('근거 없는 verified와 규칙에 없는 모션을 잡는다', () => {
    expect(
      screenProgressProblems([
        at('a', 1, 'verified', []),
        { ...at('b', 1, 'planned'), motions: ['motion-spin'] },
      ]),
    ).toEqual(['a: 검증 근거 없이 verified', 'b: 모션 motion-spin 정의 없음']);
  });

  it('제약을 비워 둔 verified를 잡는다', () => {
    expect(screenProgressProblems([{ ...at('a', 1, 'verified'), constraints: [] }])).toEqual([
      'a: 호스트 제약 기록 없이 verified',
    ]);
  });

  it('지금 이행표가 이행 순서 검사를 통과하고 2차는 전부 검증됐다', () => {
    expect(screenProgressProblems(SCREENS)).toEqual([]);
    expect(SCREENS.filter((s) => s.phase === 2).every((s) => s.status === 'verified')).toBe(true);
  });
});

describe('렌더러 링크 스킴', () => {
  it('출처와 인용 링크는 허용한 스킴만 남기고 나머지는 #으로 바꾼다', async () => {
    const { quoteCard, sourceCite } = await import('../../../src/visual-system/render.js');
    const quote = quoteCard({ quote: 'q', source: { label: 's', href: 'javascript:alert(1)' } });
    const cite = sourceCite({
      text: 't',
      cites: [
        { label: 'a', href: 'JavaScript:alert(1)' },
        { label: 'b', href: 'https://example.com/x' },
      ],
    });
    expect(quote).toContain('href="#"');
    expect(quote + cite).not.toMatch(/javascript:/i);
    expect(cite).toContain('href="https://example.com/x"');
  });
});
