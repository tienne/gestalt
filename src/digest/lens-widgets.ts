import type { Widget, WidgetValue } from './lens-widget-schema.js';
import { cellNumber, type LensSource } from './lens-source.js';
import { numbersIn } from './lint-lens.js';
import type { DigestIssue } from './lint.js';
import type { Cite } from './schema-base.js';

/** 인터랙티브 그림 lint. 스키마와 A, B, C 구분은 lens-widget-schema.ts에 있다 */

const ALLOWED_KINDS: Record<Widget['class'], readonly Widget['kind'][]> = {
  A: ['toggleBars', 'heatmap', 'beforeAfter'],
  B: ['stepSlider', 'beforeAfter'],
  C: ['stepSlider', 'toggleBars', 'heatmap', 'beforeAfter'],
};

/** 결과로 읽히는 지표 말. B는 아예 못 쓰고 A와 C는 원문에 나온 말만 쓴다 */
const METRIC =
  /(점수|정확도|일치도|성능|정밀도|재현율|오차|손실|score|accuracy|precision|recall|\bF1\b|\bNMI\b|\bMSE\b|\bBLEU\b|\bAUC\b|loss)/i;
/** 한국어 리포트가 영어 원문의 지표를 옮겨 쓴 경우를 받으려고 짝을 둔다. 어느 쪽이든 원문에 있으면 원문 지표다 */
const METRIC_ALIASES: Record<string, string[]> = {
  점수: ['score'],
  정확도: ['accuracy'],
  일치도: ['agreement', 'match'],
  성능: ['performance'],
  정밀도: ['precision'],
  재현율: ['recall'],
  오차: ['error', 'mse'],
  손실: ['loss'],
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function metricInSource(word: string, allText: string): boolean {
  const names = [word, ...(METRIC_ALIASES[word] ?? [])];
  return names.some((n) => new RegExp(escapeRe(n), 'i').test(allText));
}

const FIGURE_NUMBER = /(figure\s*\d|fig\.?\s*\d|그림\s*\d)/i;

export function widgetValues(w: Widget, wp: string): Array<{ v: WidgetValue; path: string }> {
  const out: Array<{ v: WidgetValue; path: string }> = [];
  if (w.kind === 'toggleBars') {
    w.items.forEach((it, k) => {
      out.push({ v: it.off, path: `${wp}.items.${k}.off` });
      out.push({ v: it.on, path: `${wp}.items.${k}.on` });
    });
  } else if (w.kind === 'heatmap') {
    w.cells.forEach((row, r) =>
      row.forEach((v, c) => out.push({ v, path: `${wp}.cells.${r}.${c}` })),
    );
  } else if (w.kind === 'beforeAfter') {
    for (const side of ['before', 'after'] as const) {
      w[side].items.forEach((it, k) => {
        if (it.value) out.push({ v: it.value, path: `${wp}.${side}.items.${k}.value` });
      });
    }
  }
  return out;
}

/** 그림 안 글자. 윤문과 지표 검사가 같은 목록을 본다 */
export function widgetLabels(w: Widget, wp: string): Array<{ text: string; path: string }> {
  const out: Array<{ text: string; path: string }> = [];
  if (w.kind === 'toggleBars') {
    out.push(
      { text: w.toggle.off, path: `${wp}.toggle.off` },
      { text: w.toggle.on, path: `${wp}.toggle.on` },
    );
    w.items.forEach((it, k) => out.push({ text: it.label, path: `${wp}.items.${k}.label` }));
  } else if (w.kind === 'heatmap') {
    for (const ax of ['x', 'y'] as const) {
      if (w[ax].title) out.push({ text: w[ax].title!, path: `${wp}.${ax}.title` });
      w[ax].labels.forEach((l, k) => out.push({ text: l, path: `${wp}.${ax}.labels.${k}` }));
    }
  } else if (w.kind === 'stepSlider') {
    w.steps.forEach((s, k) => {
      out.push({ text: s.label, path: `${wp}.steps.${k}.label` });
      if (s.note) out.push({ text: s.note, path: `${wp}.steps.${k}.note` });
      s.nodes.forEach((n, j) =>
        out.push({ text: n.label, path: `${wp}.steps.${k}.nodes.${j}.label` }),
      );
    });
  } else {
    for (const side of ['before', 'after'] as const) {
      out.push({ text: w[side].title, path: `${wp}.${side}.title` });
      w[side].items.forEach((it, k) =>
        out.push({ text: it.label, path: `${wp}.${side}.items.${k}.label` }),
      );
    }
  }
  return out;
}

function sourceNames(source: LensSource | null): Set<string> {
  const names = new Set<string>();
  for (const t of source?.tables ?? []) {
    for (const row of t.rows) {
      for (const cell of row) {
        const c = cell.trim().toLowerCase();
        if (c.length >= 3 && cellNumber(cell) === null) names.add(c);
      }
    }
  }
  return names;
}

export interface WidgetLintContext {
  source: LensSource | null;
  /** 원문 문단 글자. 문단 출처 값과 지표 말을 대조한다 */
  unitText: (c: Cite) => string;
  allText: string;
}

/** 위젯 하나를 본다. 렌더러가 붙이는 배지는 스키마에 칸이 없어서 모델이 끌 수 없다 */
export function lintWidget(
  w: Widget,
  wp: string,
  ctx: WidgetLintContext,
  issues: DigestIssue[],
): void {
  const err = (path: string, code: string, message: string) =>
    issues.push({ path, severity: 'error', code, message });
  if (!ALLOWED_KINDS[w.class].includes(w.kind)) {
    err(
      `${wp}.kind`,
      'WIDGET_KIND_CLASS',
      `${w.class} 그림은 ${ALLOWED_KINDS[w.class].join(', ')}만 쓴다`,
    );
  }
  // 모양 검사는 구분과 상관없이 먼저 본다
  if (w.kind === 'stepSlider') {
    w.steps.forEach((s, k) => {
      const ids = new Set(s.nodes.map((n) => n.id));
      s.edges.forEach((e, j) => {
        if (!ids.has(e.from) || !ids.has(e.to)) {
          err(
            `${wp}.steps.${k}.edges.${j}`,
            'WIDGET_EDGE_UNKNOWN',
            `간선 ${e.from}-${e.to}의 노드가 그 단계에 없다`,
          );
        }
      });
    });
  }
  if (w.kind === 'heatmap') {
    const rowsOk = w.cells.length === w.y.labels.length;
    const colsOk = w.cells.every((r) => r.length === w.x.labels.length);
    if (!rowsOk || !colsOk) {
      err(
        `${wp}.cells`,
        'WIDGET_SHAPE',
        `칸이 y ${w.y.labels.length}줄 × x ${w.x.labels.length}칸이어야 한다`,
      );
    }
  }

  const values = widgetValues(w, wp);
  const labels = [{ text: w.title, path: `${wp}.title` }, ...widgetLabels(w, wp)];
  if (w.caption) labels.push({ text: w.caption, path: `${wp}.caption` });

  if (w.class === 'B') {
    if (values.length > 0) {
      err(
        values[0]!.path,
        'B_HAS_DATA',
        'B 그림은 값을 쓰지 않는다. 원문 데이터를 빌리면 원문 결과처럼 읽힌다',
      );
    }
    if (w.figure) err(`${wp}.figure`, 'B_FIGURE_REF', '원문 그림을 다시 그리려면 C로 만든다');
    if (FIGURE_NUMBER.test(w.title)) {
      err(
        `${wp}.title`,
        'B_FIGURE_TITLE',
        'B 그림 제목에 원문 그림 번호를 쓰지 않는다. 원문 그림을 다시 그리려면 C로 만든다',
      );
    }
    const names = sourceNames(ctx.source);
    for (const l of labels) {
      if (METRIC.test(l.text) || l.text.includes('%')) {
        err(
          l.path,
          'B_METRIC_LABEL',
          `"${l.text}"는 결과 지표로 읽힌다. B 그림에는 점수나 정확도, %를 쓰지 않는다`,
        );
      }
      if (names.has(l.text.trim().toLowerCase())) {
        err(
          l.path,
          'B_BORROWS_NAME',
          `"${l.text}"는 원문 표에 있는 이름이다. B 그림은 원문 이름을 빌리지 않는다`,
        );
      }
    }
    return;
  }

  // A와 C는 값마다 원문 출처가 있고 그 숫자와 같아야 한다
  for (const { v, path } of values) {
    if (!v.src) {
      err(path, 'WIDGET_VALUE_NO_SOURCE', '값마다 원문 표 칸이나 문단 출처(src)를 단다');
      continue;
    }
    const src = v.src;
    if ('table' in src) {
      const ref = src;
      const table = ctx.source?.tables.find((t) => t.id === ref.table);
      const cell = table?.rows[ref.row]?.[ref.col];
      if (!table) {
        err(`${path}.src`, 'TABLE_REF_UNKNOWN', `표 ${ref.table}가 source.json에 없다`);
      } else if (cell === undefined) {
        err(
          `${path}.src`,
          'CELL_REF_OUT_OF_RANGE',
          `${ref.table}에 ${ref.row}행 ${ref.col}열이 없다`,
        );
      } else if (cellNumber(cell) !== v.value) {
        err(
          path,
          'WIDGET_VALUE_MISMATCH',
          `값 ${v.value}가 ${ref.table} ${ref.row}행 ${ref.col}열 "${cell}"과 다르다`,
        );
      }
    } else if (!numbersIn(ctx.unitText(src.cite)).includes(Math.abs(v.value))) {
      err(path, 'WIDGET_VALUE_MISMATCH', `값 ${v.value}가 출처 문단에 없다`);
    }
  }
  for (const l of labels) {
    const m = METRIC.exec(l.text);
    if (m && !metricInSource(m[0], ctx.allText)) {
      err(
        l.path,
        'WIDGET_METRIC_UNKNOWN',
        `"${m[0]}"는 원문에 없는 지표다. 원문에 나온 지표 이름만 쓴다`,
      );
    }
  }

  if (w.class === 'C') {
    const fig = w.figure ? ctx.source?.figures.find((f) => f.id === w.figure) : undefined;
    if (!w.figure)
      err(`${wp}.figure`, 'C_FIGURE_MISSING', 'C 그림은 다시 그린 원문 그림 id(figure)를 단다');
    else if (!fig)
      err(`${wp}.figure`, 'FIGURE_REF_UNKNOWN', `그림 ${w.figure}가 source.json에 없다`);
    if (!(w.differences ?? []).some((d) => d.trim())) {
      err(
        `${wp}.differences`,
        'C_DIFFERENCES_EMPTY',
        '원문 그림과 다르게 그린 점을 한 줄 이상 적는다. 무엇을 빼고 무엇을 단순하게 했는지, 원문 결과와 다르게 보이는 자리가 있는지다',
      );
    }
    if (fig && w.kind === 'stepSlider') {
      if (fig.panels === undefined) {
        err(
          `${wp}.figure`,
          'C_PANELS_UNKNOWN',
          `원문 그림 ${fig.id}의 장면 수를 모른다. 크롭을 보고 gestalt lens panels로 먼저 적는다`,
        );
      } else if (w.steps.length > fig.panels) {
        err(
          `${wp}.steps`,
          'C_STEPS_EXCEED_PANELS',
          `원문 그림은 ${fig.panels}장면인데 슬라이더가 ${w.steps.length}칸이다. 원문에 없는 중간 단계를 만들지 않는다`,
        );
      }
    }
  }
}
