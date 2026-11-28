import { describe, expect, it } from 'vitest';
import { generateEvolutionHtml } from '../../../src/graph-viz/evolution-html-generator.js';
import { generateVisualizationHtml } from '../../../src/graph-viz/html-generator.js';
import { GRAPH_THEME_HEAD, GRAPH_THEME_JS } from '../../../src/graph-viz/theme.js';
import type { ExecuteSession } from '../../../src/core/types.js';

function session(history: number[], terminationReason?: string): ExecuteSession {
  return {
    sessionId: 'sess-theme',
    currentGeneration: history.length,
    lateralTriedPersonas: [],
    terminationReason,
    evolutionHistory: history.map((s, i) => ({
      generation: i + 1,
      evaluationScore: s,
      goalAlignment: s,
      spec: {},
      delta: { fieldsChanged: [], similarity: 1, generation: i + 1 },
    })),
  } as unknown as ExecuteSession;
}

const pages = {
  'code graph': generateVisualizationHtml([], []),
  evolution: generateEvolutionHtml(session([0.4, 0.8], 'success')),
  'evolution 빈 상태': generateEvolutionHtml(session([])),
};

// 공용 테마 블록은 해석기와 프리셋 값을 들고 있어서 원색이 들어 있다. 그 밖의 화면 코드만 본다
function screenOnly(html: string): string {
  return html.split(GRAPH_THEME_HEAD).join('').split(GRAPH_THEME_JS).join('');
}

describe('그래프 화면의 공용 테마', () => {
  for (const [name, html] of Object.entries(pages)) {
    it(`${name}: 공용 테마와 선택기를 싣는다`, () => {
      expect(html).toContain(GRAPH_THEME_HEAD);
      expect(html).toContain(GRAPH_THEME_JS);
      expect(html).toContain('id="theme-bg"');
      expect(html).toContain('id="theme-accent"');
    });

    it(`${name}: 화면 코드에 원색을 직접 쓰지 않는다`, () => {
      expect(screenOnly(html).match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? []).toEqual([]);
    });
  }

  it('evolution 상태 배지는 바탕을 채우지 않고 상태 글자색과 테두리로 구분한다', () => {
    const html = pages.evolution;
    expect(html).toContain('box-shadow: inset 0 0 0 1px currentColor;');
    expect(html).toContain('.badge-success     { color: var(--gestalt-color-success-text); }');
    expect(html).toContain('.badge-termination { color: var(--gestalt-color-warning-text); }');
  });

  it('evolution 차트는 테마가 바뀌면 다시 칠한다', () => {
    expect(pages.evolution).toContain("document.addEventListener('gestalt-theme'");
  });
});
