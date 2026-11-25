import type { Widget, WidgetValue } from './lens-widget-schema.js';
import { cellNumber, type LensSource } from './lens-source.js';
import { metricWords, numbersIn, sourceNumbersIn } from './lint-lens.js';
import type { CellRef } from './lens-schema.js';
import { lintSteps, type Step } from './lens-steps.js';
import type { DigestIssue } from './lint.js';
import type { Cite } from './schema-base.js';

/** 인터랙티브 그림 lint. 스키마와 A, B, C, D 구분은 lens-widget-schema.ts에 있다 */

const ALLOWED_KINDS: Record<Widget['class'], readonly Widget['kind'][]> = {
  A: ['toggleBars', 'heatmap', 'beforeAfter'],
  B: [
    'stepSlider',
    'beforeAfter',
    'laneGraph',
    'stepper',
    'analogyMap',
    'stateMachine',
    'sequence',
    'swimlane',
  ],
  C: [
    'stepSlider',
    'toggleBars',
    'heatmap',
    'beforeAfter',
    'laneGraph',
    'calendar',
    'stepper',
    'stateMachine',
    'sequence',
    'swimlane',
  ],
  // calendar는 값 칸이 없어 A로 대조할 숫자가 없다. 원문 표에서 온 일정은 D로 쓰고 기간마다 표 칸 출처를 단다
  D: [
    'stepSlider',
    'beforeAfter',
    'laneGraph',
    'calendar',
    'stepper',
    'stateMachine',
    'sequence',
    'swimlane',
  ],
};

/** 한국어 리포트가 영어 원문의 지표를 옮겨 쓴 경우를 받으려고 짝을 둔다. 어느 쪽이든 원문에 있으면 원문 지표다 */
const METRIC_ALIASES: Record<string, string[]> = {
  점수: ['score'],
  정확도: ['accuracy'],
  정답률: ['accuracy'],
  일치도: ['agreement', 'match'],
  성능: ['performance'],
  정밀도: ['precision'],
  재현율: ['recall'],
  오차: ['error', 'mse'],
  손실: ['loss'],
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 영숫자 경계로 감싸 대조한다(knowledge.ts의 노트 검색과 같은 꼴). \b는 한글 앞뒤를 경계로 못 잡는다.
 * 영어 지표는 복수형(scores)까지 같은 말로 본다
 */
function metricInSource(word: string, allText: string): boolean {
  const names = [word, ...(METRIC_ALIASES[word] ?? [])];
  return names.some((n) => {
    const plural = /^[A-Za-z]+$/.test(n) ? '(?:e?s)?' : '';
    return new RegExp(`(?<![A-Za-z0-9])${escapeRe(n)}${plural}(?![A-Za-z0-9])`, 'i').test(allText);
  });
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

/**
 * 그림 안 글자. 윤문과 지표 검사가 같은 목록을 본다.
 * step은 그 글자가 속한 단계 번호, cite는 그 글자가 속한 요소의 원문 출처다. D 검사가 숫자를 대조할 범위로 쓴다.
 * illustrative는 원문에 없는 예시 요소의 글자, role은 비유 표에서 비유 쪽 칸(analog)과 안 맞는 지점(break)이다
 */
export interface WidgetLabel {
  text: string;
  path: string;
  step?: number;
  illustrative?: boolean;
  cite?: Cite | CellRef;
  role?: 'analog' | 'break';
}

/** 모델이 적은 공통 단계. stepSlider는 단계마다 노드를 통째로 적는 옛 꼴이라 빠진다 */
export function commonSteps(w: Widget): Step[] | undefined {
  return w.kind === 'stepSlider' ||
    w.kind === 'toggleBars' ||
    w.kind === 'heatmap' ||
    w.kind === 'beforeAfter' ||
    w.kind === 'analogyMap'
    ? undefined
    : w.steps;
}

/**
 * sequence가 화면에 보일 단계. 모델이 단계를 안 적었으면 메시지 하나를 한 단계로 만든다.
 * 메시지를 하나씩 드러낼 뿐 새 내용을 지어내지 않아서 D 단계 출처와 C 장면 수 검사는 모델이 적은 단계만 받는다
 */
export function sequenceSteps(w: Extract<Widget, { kind: 'sequence' }>): Step[] | undefined {
  if (w.steps) return w.steps;
  if (w.messages.length < 2) return undefined;
  return w.messages.map((m, k) => ({
    label: m.label,
    ...(m.cite ? { cite: m.cite } : {}),
    ...(k > 0 ? { show: [m.id] } : {}),
    focus: [m.id],
  }));
}

/** 공통 단계가 가리킬 수 있는 요소 id */
export function stepElementIds(w: Widget): string[] {
  if (w.kind === 'laneGraph') return w.nodes.map((n) => n.id);
  if (w.kind === 'calendar') return w.spans.flatMap((sp) => (sp.id ? [sp.id] : []));
  if (w.kind === 'stepper') return w.items.map((it) => it.id);
  if (w.kind === 'stateMachine') {
    return [...w.states.map((s) => s.id), ...w.transitions.map((t) => t.id)];
  }
  if (w.kind === 'sequence') {
    return [...w.actors.map((a) => a.id), ...w.messages.map((m) => m.id)];
  }
  if (w.kind === 'swimlane') {
    return [
      ...w.activities.map((a) => a.id),
      ...(w.arrows ?? []).flatMap((ar) => (ar.id ? [ar.id] : [])),
    ];
  }
  return [];
}

const mark = (illustrative?: boolean) => (illustrative ? { illustrative: true } : {});

export function widgetLabels(w: Widget, wp: string): WidgetLabel[] {
  const out: WidgetLabel[] = [];
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
      out.push({ text: s.label, path: `${wp}.steps.${k}.label`, step: k });
      if (s.note) out.push({ text: s.note, path: `${wp}.steps.${k}.note`, step: k });
      s.nodes.forEach((n, j) =>
        out.push({
          text: n.label,
          path: `${wp}.steps.${k}.nodes.${j}.label`,
          step: k,
          ...mark(n.illustrative),
        }),
      );
    });
  } else if (w.kind === 'beforeAfter') {
    for (const side of ['before', 'after'] as const) {
      out.push({ text: w[side].title, path: `${wp}.${side}.title` });
      w[side].items.forEach((it, k) =>
        out.push({
          text: it.label,
          path: `${wp}.${side}.items.${k}.label`,
          ...mark(it.illustrative),
        }),
      );
    }
  } else if (w.kind === 'laneGraph') {
    w.lanes.forEach((l, k) => out.push({ text: l.label, path: `${wp}.lanes.${k}.label` }));
    w.nodes.forEach((n, k) =>
      out.push({
        text: n.label,
        path: `${wp}.nodes.${k}.label`,
        ...(n.cite ? { cite: n.cite } : {}),
        ...mark(n.illustrative),
      }),
    );
  } else if (w.kind === 'calendar') {
    w.columns.forEach((c, k) => out.push({ text: c, path: `${wp}.columns.${k}` }));
    w.tracks.forEach((t, k) => out.push({ text: t.label, path: `${wp}.tracks.${k}.label` }));
    w.spans.forEach((sp, k) =>
      out.push({
        text: sp.label,
        path: `${wp}.spans.${k}.label`,
        ...(sp.cite ? { cite: sp.cite } : {}),
        ...mark(sp.illustrative),
      }),
    );
    if (w.note) out.push({ text: w.note, path: `${wp}.note` });
  } else if (w.kind === 'stepper') {
    w.items.forEach((it, k) => {
      const own = { ...(it.cite ? { cite: it.cite } : {}), ...mark(it.illustrative) };
      out.push({ text: it.label, path: `${wp}.items.${k}.label`, ...own });
      if (it.detail) out.push({ text: it.detail, path: `${wp}.items.${k}.detail`, ...own });
    });
    w.loops?.forEach((l, k) => {
      if (l.label) out.push({ text: l.label, path: `${wp}.loops.${k}.label` });
    });
  } else if (w.kind === 'stateMachine') {
    w.states.forEach((st, k) =>
      out.push({
        text: st.label,
        path: `${wp}.states.${k}.label`,
        ...(st.cite ? { cite: st.cite } : {}),
        ...mark(st.illustrative),
      }),
    );
    w.transitions.forEach((t, k) => {
      if (!t.label) return;
      out.push({
        text: t.label,
        path: `${wp}.transitions.${k}.label`,
        ...(t.cite ? { cite: t.cite } : {}),
        ...mark(t.illustrative),
      });
    });
  } else if (w.kind === 'sequence') {
    w.actors.forEach((a, k) =>
      out.push({ text: a.label, path: `${wp}.actors.${k}.label`, ...mark(a.illustrative) }),
    );
    w.messages.forEach((m, k) =>
      out.push({
        text: m.label,
        path: `${wp}.messages.${k}.label`,
        ...(m.cite ? { cite: m.cite } : {}),
        ...mark(m.illustrative),
      }),
    );
  } else if (w.kind === 'swimlane') {
    w.lanes.forEach((l, k) => out.push({ text: l.label, path: `${wp}.lanes.${k}.label` }));
    w.activities.forEach((a, k) =>
      out.push({
        text: a.label,
        path: `${wp}.activities.${k}.label`,
        ...(a.cite ? { cite: a.cite } : {}),
        ...mark(a.illustrative),
      }),
    );
    w.arrows?.forEach((ar, k) => {
      if (ar.label) out.push({ text: ar.label, path: `${wp}.arrows.${k}.label` });
    });
  } else {
    out.push({ text: w.domain, path: `${wp}.domain`, role: 'analog' });
    w.rows.forEach((r, k) => {
      out.push({ text: r.term, path: `${wp}.rows.${k}.term`, cite: r.termCite });
      out.push({ text: r.analog, path: `${wp}.rows.${k}.analog`, role: 'analog' });
    });
    w.breaks.forEach((b, k) => out.push({ text: b, path: `${wp}.breaks.${k}`, role: 'break' }));
  }
  // 상태 칸 키는 단계끼리 맞춰야 해서 윤문에 넘기지 않는다. 값만 넘긴다
  commonSteps(w)?.forEach((s, k) => {
    out.push({ text: s.label, path: `${wp}.steps.${k}.label`, step: k });
    if (s.note) out.push({ text: s.note, path: `${wp}.steps.${k}.note`, step: k });
    s.state?.forEach((kv, j) =>
      out.push({ text: kv.value, path: `${wp}.steps.${k}.state.${j}.value`, step: k }),
    );
  });
  return out;
}

/**
 * B가 빌리면 안 되는 원문 표 이름. 머리줄은 Model이나 모델 같은 일반어가 많아 라벨 전체와 같을 때만 잡는다.
 * 본문 칸은 4자 이상이면 라벨 안에 들어 있어도 잡는다
 */
type SourceNames = { exact: Set<string>; contained: RegExp | null };

// 위젯마다 원문 표 전체를 다시 훑지 않게 원문 하나에 한 번만 만든다
const sourceNamesCache = new WeakMap<LensSource, SourceNames>();

function sourceNames(source: LensSource | null): SourceNames {
  const cached = source && sourceNamesCache.get(source);
  if (cached) return cached;
  const exact = new Set<string>();
  const contained: string[] = [];
  for (const t of source?.tables ?? []) {
    t.rows.forEach((row, r) => {
      for (const cell of row) {
        const c = cell.trim().toLowerCase();
        if (c.length < 3 || cellNumber(cell) !== null) continue;
        exact.add(c);
        if (r > 0 && c.length >= 4) contained.push(escapeRe(c));
      }
    });
  }
  const names: SourceNames = {
    exact,
    contained: contained.length
      ? new RegExp(`(?<![A-Za-z0-9])(?:${contained.join('|')})(?![A-Za-z0-9])`, 'i')
      : null,
  };
  if (source) sourceNamesCache.set(source, names);
  return names;
}

type Err = (path: string, code: string, message: string) => void;

/** B 그림과 D의 예시 요소 글자가 받는 검사. 원문 값이나 결과처럼 읽히는 글자를 막는다 */
function illustrativeChecks(l: WidgetLabel, err: Err): void {
  // "1단계"처럼 순서를 적은 숫자도 원문 값처럼 읽혀서 처음, 다음, 끝으로 쓴다
  if (numbersIn(l.text).length > 0) {
    err(
      l.path,
      'B_HAS_NUMBER',
      `"${l.text}"에 숫자가 있다. 설명용 그림이나 예시 요소는 값처럼 읽히는 숫자를 쓰지 않는다. 순서는 처음, 다음, 끝으로 쓴다`,
    );
  }
  if (metricWords(l.text).length > 0 || l.text.includes('%')) {
    err(
      l.path,
      'B_METRIC_LABEL',
      `"${l.text}"는 결과 지표로 읽힌다. 설명용 그림이나 예시 요소에는 점수나 정확도, %를 쓰지 않는다`,
    );
  }
}

/**
 * D 그림에서 원문과 대조할 이름. 영문자가 든 토큰이고 release/20260728이나 force-push처럼 /, -, _, .로 이어진 건 통째로 본다.
 * 한국어 설명 말은 대조하지 않는다
 */
function nameTokens(text: string): string[] {
  return [...text.matchAll(/[A-Za-z0-9]+(?:[-/_.][A-Za-z0-9]+)*/g)]
    .map((m) => m[0])
    .filter((t) => t.length >= 2 && /[A-Za-z]/.test(t));
}

function nameInSource(name: string, allText: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(name)}(?![A-Za-z0-9])`, 'i').test(allText);
}

/** 요소 출처의 원문 글자. 표 칸이면 표 번호와 머리줄, 그 칸이 든 줄이다(근거 숫자를 고를 때와 같은 범위) */
function refText(ref: Cite | CellRef, ctx: WidgetLintContext): string {
  if (!('table' in ref)) return ctx.unitText(ref);
  const t = ctx.source?.tables.find((x) => x.id === ref.table);
  if (!t) return '';
  return [t.number, ...(t.rows[0] ?? []), ...(t.rows[ref.row] ?? [])].join(' ');
}

/**
 * 원문에서 온 글자의 이름과 숫자를 본다. 이름은 원문 어디에든 있으면 된다. 한 번 정의한 이름을 여러 문단에서 가리키기 때문이다.
 * 숫자는 그림 출처 문단과 그 글자가 속한 단계, 요소의 출처 안에 있어야 한다
 */
function describedLabelChecks(
  labels: WidgetLabel[],
  widgetCite: Cite,
  stepCites: Array<Cite | undefined>,
  ctx: WidgetLintContext,
  err: Err,
): void {
  const widgetNumbers = sourceNumbersIn(ctx.unitText(widgetCite));
  for (const l of labels) {
    for (const name of new Set(nameTokens(l.text))) {
      if (nameInSource(name, ctx.allText)) continue;
      err(
        l.path,
        'D_NAME_UNKNOWN',
        `"${name}"가 원문에 없다. 원문 이름을 글자 그대로 쓴다. 원문에 없는 요소면 illustrative를 단다`,
      );
    }
    const stepCite = l.step === undefined ? undefined : stepCites[l.step];
    const allowed = new Set([
      ...widgetNumbers,
      ...(stepCite ? sourceNumbersIn(ctx.unitText(stepCite)) : []),
      ...(l.cite ? sourceNumbersIn(refText(l.cite, ctx)) : []),
    ]);
    const unknown = [...new Set(numbersIn(l.text))].filter((n) => n !== 0 && !allowed.has(n));
    if (unknown.length > 0) {
      err(
        l.path,
        'D_NUMBER_UNKNOWN',
        `숫자 ${unknown.join(', ')}이 그 단계나 요소, 그림의 출처에 없다. 원문 숫자만 그대로 쓴다`,
      );
    }
  }
}

/** D 그림 검사. 원문 그림이 있으면 C로 보내고 단계마다 출처를 받는다 */
function lintDescribed(
  w: Widget,
  wp: string,
  labels: WidgetLabel[],
  ctx: WidgetLintContext,
  err: Err,
): void {
  if (w.figure) {
    err(`${wp}.figure`, 'D_FIGURE_REF', '원문 그림을 다시 그리는 자리면 C로 만든다');
  }
  const steps = w.kind === 'stepSlider' ? w.steps : (commonSteps(w) ?? []);
  const stepCites = steps.map((s) => s.cite);
  stepCites.forEach((c, k) => {
    if (!c) {
      err(
        `${wp}.steps.${k}.cite`,
        'D_STEP_NO_CITE',
        'D 그림은 단계마다 그 단계가 옮긴 원문 문단(cite)을 단다',
      );
    }
  });
  // 상태 칸 키는 윤문에 안 넘겨서 labels에 없다. 이름 대조만 따로 한다
  const keyLabels: WidgetLabel[] = (commonSteps(w)?.[0]?.state ?? []).map((kv, j) => ({
    text: kv.key,
    path: `${wp}.steps.0.state.${j}.key`,
    step: 0,
  }));
  const plain = [...labels, ...keyLabels].filter((l) => !l.illustrative);
  labels.filter((l) => l.illustrative).forEach((l) => illustrativeChecks(l, err));
  describedLabelChecks(plain, w.cite, stepCites, ctx, err);
}

/**
 * 비유 표 검사. 원문 말 칸은 D 규칙, 비유 칸은 B 규칙을 받는다. 비유 칸에는 원문 이름도 못 쓴다.
 * 비유가 어디서 안 맞는지(breaks)를 한 줄 이상 적어야 비유를 믿고 틀리게 이해하는 걸 막는다
 */
function lintAnalogy(
  w: Extract<Widget, { kind: 'analogyMap' }>,
  wp: string,
  labels: WidgetLabel[],
  ctx: WidgetLintContext,
  err: Err,
): void {
  if (w.figure) err(`${wp}.figure`, 'B_FIGURE_REF', '원문 그림을 다시 그리려면 C로 만든다');
  if (!w.breaks.some((b) => b.trim())) {
    err(
      `${wp}.breaks`,
      'ANALOGY_BREAKS_EMPTY',
      '비유가 원문과 안 맞는 지점을 한 줄 이상 적는다. 모르면 비유를 믿고 틀리게 이해한다',
    );
  }
  for (const l of labels.filter((x) => x.role === 'analog')) {
    illustrativeChecks(l, err);
    const borrowed = nameTokens(l.text).find((n) => nameInSource(n, ctx.allText));
    if (borrowed) {
      err(
        l.path,
        'B_BORROWS_NAME',
        `"${borrowed}"는 원문에 있는 이름이다. 비유 칸에는 원문 이름을 쓰지 않는다`,
      );
    }
  }
  const sourceSide = labels.filter((x) => x.role === undefined);
  describedLabelChecks(sourceSide, w.cite, [], ctx, err);
  metricChecks(sourceSide, ctx, err);
}

/** 원문에서 온 글자의 지표 말은 원문에 나온 것만 쓴다 */
function metricChecks(labels: WidgetLabel[], ctx: WidgetLintContext, err: Err): void {
  for (const l of labels) {
    for (const word of new Set(metricWords(l.text))) {
      if (metricInSource(word, ctx.allText)) continue;
      err(
        l.path,
        'WIDGET_METRIC_UNKNOWN',
        `"${word}"는 원문에 없는 지표다. 원문에 나온 지표 이름만 쓴다`,
      );
    }
  }
}

/** 새 종류의 모양 검사. 구분과 상관없이 본다 */
function lintShape(w: Widget, wp: string, ctx: WidgetLintContext, err: Err, issues: DigestIssue[]) {
  // 단계가 요소를 id 하나로 가리켜서 상태와 전이처럼 다른 목록끼리도 id가 겹치면 안 된다
  const dupes = (ids: string[], path: string, more: Array<[string[], string]> = []) => {
    const seen = new Set<string>();
    for (const [list, at] of [[ids, path] as [string[], string], ...more]) {
      list.forEach((id, k) => {
        if (!id) return;
        if (seen.has(id)) err(`${at}.${k}.id`, 'WIDGET_ID_DUPLICATE', `id ${id}가 두 번 나온다`);
        seen.add(id);
      });
    }
  };
  if (w.kind === 'laneGraph') {
    dupes(
      w.lanes.map((l) => l.id),
      `${wp}.lanes`,
    );
    dupes(
      w.nodes.map((n) => n.id),
      `${wp}.nodes`,
    );
    const lanes = new Set(w.lanes.map((l) => l.id));
    const order = new Map(w.nodes.map((n, k) => [n.id, k]));
    w.nodes.forEach((n, k) => {
      if (!lanes.has(n.lane)) {
        err(`${wp}.nodes.${k}.lane`, 'LANE_UNKNOWN', `줄 ${n.lane}가 lanes에 없다`);
      }
      const refs = [...(n.parents ?? []), ...(n.copyOf ? [n.copyOf] : [])];
      for (const ref of refs) {
        const at = order.get(ref);
        if (at === undefined) {
          err(
            `${wp}.nodes.${k}`,
            'LANE_PARENT_UNKNOWN',
            `${n.id}가 가리키는 ${ref}가 nodes에 없다`,
          );
        } else if (at >= k) {
          err(
            `${wp}.nodes.${k}`,
            'LANE_PARENT_ORDER',
            `${n.id}가 가리키는 ${ref}가 자기보다 뒤에 있다. 가로 순서는 nodes 배열 순서다`,
          );
        }
      }
    });
  } else if (w.kind === 'calendar') {
    dupes(
      w.tracks.map((t) => t.id),
      `${wp}.tracks`,
    );
    dupes(stepElementIds(w), `${wp}.spans`);
    const tracks = new Set(w.tracks.map((t) => t.id));
    const last = w.columns.length - 1;
    w.spans.forEach((sp, k) => {
      const at = `${wp}.spans.${k}`;
      if (!tracks.has(sp.track)) {
        err(`${at}.track`, 'CALENDAR_TRACK_UNKNOWN', `트랙 ${sp.track}가 tracks에 없다`);
      }
      const ranged = sp.from !== undefined && sp.to !== undefined;
      if (ranged === (sp.at !== undefined)) {
        err(at, 'CALENDAR_SPAN_SHAPE', '기간은 from과 to, 한 칸짜리 사건은 at 하나만 쓴다');
      } else if (ranged ? sp.from! > sp.to! || sp.to! > last : sp.at! > last) {
        err(
          at,
          'CALENDAR_SPAN_OUT_OF_RANGE',
          `칸 번호가 columns(0~${last}) 밖이거나 from이 to보다 크다`,
        );
      }
      if (sp.cite && 'table' in sp.cite) {
        const ref = sp.cite;
        const table = ctx.source?.tables.find((t) => t.id === ref.table);
        if (!table) {
          err(`${at}.cite`, 'TABLE_REF_UNKNOWN', `표 ${ref.table}가 source.json에 없다`);
        } else if (table.rows[ref.row]?.[ref.col] === undefined) {
          err(
            `${at}.cite`,
            'CELL_REF_OUT_OF_RANGE',
            `${ref.table}에 ${ref.row}행 ${ref.col}열이 없다`,
          );
        }
      }
    });
  } else if (w.kind === 'stepper') {
    dupes(stepElementIds(w), `${wp}.items`);
    const ids = new Set(stepElementIds(w));
    w.loops?.forEach((l, k) => {
      if (!ids.has(l.from) || !ids.has(l.to)) {
        err(
          `${wp}.loops.${k}`,
          'STEPPER_LOOP_UNKNOWN',
          `되돌아가는 화살표 ${l.from}→${l.to}의 카드가 items에 없다`,
        );
      }
    });
  } else if (w.kind === 'stateMachine') {
    dupes(
      w.states.map((st) => st.id),
      `${wp}.states`,
      [[w.transitions.map((t) => t.id), `${wp}.transitions`]],
    );
    const states = new Set(w.states.map((st) => st.id));
    w.transitions.forEach((t, k) => {
      if (!states.has(t.from) || !states.has(t.to)) {
        err(
          `${wp}.transitions.${k}`,
          'STATE_TRANSITION_UNKNOWN',
          `전이 ${t.from}→${t.to}의 상태가 states에 없다`,
        );
      }
    });
    if (w.states.filter((st) => st.initial).length > 1) {
      err(`${wp}.states`, 'STATE_INITIAL_MANY', '시작 상태(initial)는 하나만 둔다');
    }
    const taken = new Map<string, string>();
    w.states.forEach((st, k) => {
      if (!st.pos) return;
      const key = `${st.pos.row}:${st.pos.col}`;
      const other = taken.get(key);
      if (other) {
        err(
          `${wp}.states.${k}.pos`,
          'STATE_POS_OVERLAP',
          `${st.id}와 ${other}가 같은 자리(${st.pos.row}행 ${st.pos.col}열)에 있다`,
        );
      }
      taken.set(key, st.id);
    });
  } else if (w.kind === 'sequence') {
    dupes(
      w.actors.map((a) => a.id),
      `${wp}.actors`,
      [[w.messages.map((m) => m.id), `${wp}.messages`]],
    );
    const actors = new Set(w.actors.map((a) => a.id));
    w.messages.forEach((m, k) => {
      if (!actors.has(m.from) || !actors.has(m.to)) {
        err(
          `${wp}.messages.${k}`,
          'SEQUENCE_ACTOR_UNKNOWN',
          `메시지 ${m.from}→${m.to}의 참여자가 actors에 없다`,
        );
      }
    });
  } else if (w.kind === 'swimlane') {
    dupes(
      w.lanes.map((l) => l.id),
      `${wp}.lanes`,
    );
    dupes(
      w.activities.map((a) => a.id),
      `${wp}.activities`,
      [[(w.arrows ?? []).map((ar) => ar.id ?? ''), `${wp}.arrows`]],
    );
    const lanes = new Set(w.lanes.map((l) => l.id));
    const acts = new Set(w.activities.map((a) => a.id));
    const taken = new Map<string, string>();
    w.activities.forEach((a, k) => {
      if (!lanes.has(a.lane)) {
        err(`${wp}.activities.${k}.lane`, 'SWIMLANE_LANE_UNKNOWN', `줄 ${a.lane}가 lanes에 없다`);
      }
      const key = `${a.lane}:${a.col}`;
      const other = taken.get(key);
      if (other) {
        err(
          `${wp}.activities.${k}.col`,
          'SWIMLANE_CELL_TAKEN',
          `${a.id}와 ${other}가 같은 줄 같은 칸(${a.col})에 있다`,
        );
      }
      taken.set(key, a.id);
    });
    w.arrows?.forEach((ar, k) => {
      if (!acts.has(ar.from) || !acts.has(ar.to)) {
        err(
          `${wp}.arrows.${k}`,
          'SWIMLANE_ARROW_UNKNOWN',
          `화살표 ${ar.from}→${ar.to}의 활동이 activities에 없다`,
        );
      }
    });
  }
  const steps = commonSteps(w);
  if (steps) lintSteps(steps, stepElementIds(w), `${wp}.steps`, issues);
}

export interface WidgetLintContext {
  source: LensSource | null;
  /** 원문 문단 글자. 문단 출처 값과 지표 말을 대조한다 */
  unitText: (c: Cite) => string;
  allText: string;
}

/**
 * 위젯 하나를 본다. 렌더러가 붙이는 배지는 스키마에 칸이 없어서 모델이 끄거나 글을 바꿀 수 없다.
 * class를 바꿔 다른 배지를 달면 그 구분의 검사를 받는다
 */
export function lintWidget(
  w: Widget,
  wp: string,
  ctx: WidgetLintContext,
  issues: DigestIssue[],
): void {
  const err: Err = (path, code, message) => issues.push({ path, severity: 'error', code, message });
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
  lintShape(w, wp, ctx, err, issues);
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
  const labels: WidgetLabel[] = [{ text: w.title, path: `${wp}.title` }, ...widgetLabels(w, wp)];
  if (w.caption) labels.push({ text: w.caption, path: `${wp}.caption` });

  if (w.kind === 'analogyMap') {
    lintAnalogy(w, wp, labels, ctx, err);
    return;
  }

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
      illustrativeChecks(l, err);
      const t = l.text.trim().toLowerCase();
      if (names.exact.has(t) || names.contained?.test(t)) {
        err(
          l.path,
          'B_BORROWS_NAME',
          `"${l.text}"는 원문 표에 있는 이름이다. B 그림은 원문 이름을 빌리지 않는다`,
        );
      }
    }
    return;
  }

  // 값이 하나도 없으면 원문과 맞춰 볼 게 없는데도 원문 데이터 배지가 붙는다
  if (w.class === 'A' && values.length === 0) {
    err(
      wp,
      'A_NO_VALUES',
      'A 그림은 원문 표 칸이나 문단에서 온 값을 하나 이상 단다. 값 없는 설명 그림은 B로 만든다',
    );
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
    } else if (!sourceNumbersIn(ctx.unitText(src.cite)).includes(Math.abs(v.value))) {
      err(path, 'WIDGET_VALUE_MISMATCH', `값 ${v.value}가 출처 문단에 없다`);
    }
  }
  if (w.class === 'D') lintDescribed(w, wp, labels, ctx, err);
  // heatmap 축 라벨도 widgetLabels에 들어 있어 같이 본다. D의 예시 요소는 위에서 B 규칙으로 봤다
  metricChecks(
    labels.filter((l) => !l.illustrative),
    ctx,
    err,
  );

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
    const stepCount = w.kind === 'stepSlider' ? w.steps.length : commonSteps(w)?.length;
    if (fig && stepCount !== undefined) {
      if (fig.panels === undefined) {
        err(
          `${wp}.figure`,
          'C_PANELS_UNKNOWN',
          `원문 그림 ${fig.id}의 장면 수를 모른다. 원문에서 잘라낸 그림을 보고 gestalt lens panels로 먼저 적는다`,
        );
      } else if (stepCount > fig.panels) {
        err(
          `${wp}.steps`,
          'C_STEPS_EXCEED_PANELS',
          `원문 그림은 ${fig.panels}장면인데 단계가 ${stepCount}칸이다. 원문에 없는 중간 단계를 만들지 않는다`,
        );
      }
    }
  }
}
