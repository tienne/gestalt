import type { LensHtmlContext } from './render-lens.js';
import type { CellRef } from './lens-schema.js';
import { stepFrames, type ElementLook, type Step, type StepFrame } from './lens-steps.js';
import type { Widget } from './lens-widget-schema.js';
import type { Cite } from './schema-base.js';
import { mdCell as cell } from './format.js';

/**
 * 단계형 그림(laneGraph, calendar, stepper)과 비유 표 렌더러. 단계마다 그림을 미리 그려 두고
 * 뷰어는 이전, 다음 버튼으로 보일 단계만 바꾼다. 단계 사이를 보간하지 않는다
 */

type LaneGraph = Extract<Widget, { kind: 'laneGraph' }>;
type Calendar = Extract<Widget, { kind: 'calendar' }>;
type Stepper = Extract<Widget, { kind: 'stepper' }>;
type AnalogyMap = Extract<Widget, { kind: 'analogyMap' }>;

export const ILL_TAG = '예시';

/** 원문에 없는 요소 이름 뒤에 예시 꼬리표를 붙인다 */
export const ill = (label: string, on?: boolean) => (on ? `${label} (${ILL_TAG})` : label);

export const f1 = (n: number) => n.toFixed(1);

/** 요소 출처 칩. 표 칸이면 그 표가 실린 문단을 연다 */
function refChip(ref: Cite | CellRef | undefined, ctx: LensHtmlContext): string {
  if (!ref) return '';
  if (!('table' in ref)) return ctx.cite(ref);
  const table = ctx.source?.tables.find((t) => t.id === ref.table);
  if (!table) return '';
  return ` <button type="button" class="w-cell-ref" data-cell="${ctx.escape(`${ref.table}:${ref.row}:${ref.col}`)}" data-unit="${table.unit}">표 ${ctx.escape(table.number)} ${ref.row + 1}행 ${ref.col + 1}열</button>`;
}

export const lookClass = (look: ElementLook | undefined) =>
  look === 'gone' ? ' w-gone' : look === 'focus' ? ' w-focus' : look === 'hidden' ? ' w-hide' : '';

function stateHtml(frame: StepFrame, ctx: LensHtmlContext): string {
  if (frame.state.length === 0) return '';
  return `<dl class="w-state">${frame.state
    .map((kv) => `<div><dt>${ctx.escape(kv.key)}</dt><dd>${ctx.escape(kv.value)}</dd></div>`)
    .join('')}</dl>`;
}

/**
 * 단계가 있으면 단계마다 그림을 미리 그리고 이전, 다음 버튼을 붙인다. 없으면 모든 요소가 보이는 그림 하나다.
 * 순번 표시는 렌더러가 붙여서 모델이 라벨에 "1단계"를 쓸 이유가 없다
 */
export function framed(
  ids: string[],
  steps: Step[] | undefined,
  draw: (looks: Map<string, ElementLook>, k: number) => string,
  ctx: LensHtmlContext,
): string {
  if (!steps?.length) {
    return draw(new Map(ids.map((id) => [id, 'shown' as const])), 0);
  }
  const frames = stepFrames(ids, steps);
  const n = steps.length;
  const body = frames
    .map((fr, k) => {
      const s = steps[k]!;
      return `<div data-w-state="${k}"${k === 0 ? '' : ' hidden'}><p class="ws-step"><b>${ctx.escape(s.label)}</b>${s.note ? ` ${ctx.inline(s.note)}` : ''}${s.cite ? ctx.cite(s.cite) : ''}</p>${draw(fr.looks, k)}${stateHtml(fr, ctx)}</div>`;
    })
    .join('');
  return `<div class="w-nav" data-w-steps="${n}"><button type="button" data-w-step="prev" aria-disabled="true">이전</button><span class="w-pos" aria-live="polite">단계 1 / ${n}</span><button type="button" data-w-step="next" aria-disabled="false">다음</button></div>${body}`;
}

/** copyOf를 따라 올라간 원래 점의 줄. 복사된 점은 원래 줄 색으로 칠한다 */
function originLane(w: LaneGraph, id: string): string {
  const byId = new Map(w.nodes.map((n) => [n.id, n]));
  let node = byId.get(id);
  const seen = new Set<string>();
  while (node?.copyOf && !seen.has(node.id)) {
    seen.add(node.id);
    const up = byId.get(node.copyOf);
    if (!up) break;
    node = up;
  }
  return node?.lane ?? '';
}

function laneSvg(w: LaneGraph, looks: Map<string, ElementLook>, ctx: LensHtmlContext): string {
  const COL = 58;
  const ROW = 46;
  const LEFT = 120;
  const TOP = 26;
  const laneIdx = new Map(w.lanes.map((l, k) => [l.id, k]));
  const W = LEFT + w.nodes.length * COL + 24;
  const H = TOP + w.lanes.length * ROW + 8;
  const pos = new Map(
    w.nodes.map((n, k) => [
      n.id,
      { x: LEFT + k * COL + COL / 2, y: TOP + (laneIdx.get(n.lane) ?? 0) * ROW + ROW / 2 },
    ]),
  );
  const shown = (id: string) => (looks.get(id) ?? 'hidden') !== 'hidden';
  const lanes = w.lanes
    .map((l, k) => {
      const y = TOP + k * ROW + ROW / 2;
      return `<g class="wl-c${k}"><line class="wl-lane" x1="${LEFT - 6}" y1="${y}" x2="${W - 10}" y2="${y}"/><text class="wl-name" x="8" y="${y + 4}">${ctx.escape(l.label)}</text></g>`;
    })
    .join('');
  const edges = w.nodes
    .filter((n) => shown(n.id))
    .flatMap((n) => {
      const b = pos.get(n.id)!;
      const line = (from: string, cls: string) => {
        const a = pos.get(from);
        if (!a || !shown(from)) return '';
        const mid = f1((a.x + b.x) / 2);
        // 줄을 건너는 선은 가운데에서 꺾어 같은 줄 선과 겹치지 않게 한다
        const d =
          a.y === b.y
            ? `M${f1(a.x)},${f1(a.y)} L${f1(b.x)},${f1(b.y)}`
            : `M${f1(a.x)},${f1(a.y)} C${mid},${f1(a.y)} ${mid},${f1(b.y)} ${f1(b.x)},${f1(b.y)}`;
        const gone = looks.get(n.id) === 'gone' || looks.get(from) === 'gone' ? ' w-gone' : '';
        return `<path class="${cls}${gone}" d="${d}"/>`;
      };
      return [
        ...(n.parents ?? []).map((p) => line(p, 'wl-edge')),
        ...(n.copyOf ? [line(n.copyOf, 'wl-copy')] : []),
      ];
    })
    .join('');
  const nodes = w.nodes
    .map((n, k) => {
      const look = looks.get(n.id);
      if (look === 'hidden' || look === undefined) return '';
      const p = pos.get(n.id)!;
      const color = laneIdx.get(originLane(w, n.id)) ?? 0;
      const label = ill(n.label, n.illustrative);
      // 이웃 점 글자가 겹치지 않게 위아래로 번갈아 둔다
      const ty = k % 2 === 0 ? p.y - 13 : p.y + 21;
      return `<g class="wl-node wl-c${color}${lookClass(look)}${n.illustrative ? ' w-ill' : ''}"${n.cite ? ` data-unit="${n.cite.key}"` : ''}><title>${ctx.escape(label)}</title><circle cx="${f1(p.x)}" cy="${f1(p.y)}" r="${look === 'focus' ? 9 : 7}"/><text x="${f1(p.x)}" y="${f1(ty)}" text-anchor="middle">${ctx.escape(label)}</text></g>`;
    })
    .join('');
  return `<div class="w-scroll"><svg class="wl-svg" viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="${ctx.escape(w.title)}">${lanes}${edges}${nodes}</svg></div>`;
}

function laneGraphHtml(w: LaneGraph, ctx: LensHtmlContext): string {
  const legend = `<p class="w-legend">굵은 선은 부모 연결, 가는 점선은 복사해 새로 쌓은 점이에요. 복사된 점은 원래 줄 색으로 칠해요. 흐린 점선은 그 단계에서 버려지는 점이에요.</p>`;
  return `${framed(
    w.nodes.map((n) => n.id),
    w.steps,
    (looks) => laneSvg(w, looks, ctx),
    ctx,
  )}${legend}`;
}

/** 같은 트랙에서 겹치는 기간은 아랫줄로 내린다. 단계가 바뀌어도 자리가 흔들리지 않게 숨은 기간까지 한 번에 놓는다 */
function packSpans(
  spans: Calendar['spans'],
): Array<Array<{ k: number; from: number; to: number }>> {
  const rows: Array<Array<{ k: number; from: number; to: number }>> = [];
  spans
    .map((sp, k) => ({ k, from: sp.at ?? sp.from ?? 0, to: sp.at ?? sp.to ?? 0 }))
    .sort((a, b) => a.from - b.from)
    .forEach((it) => {
      const row = rows.find((r) => r.every((x) => x.to < it.from || x.from > it.to));
      if (row) row.push(it);
      else rows.push([it]);
    });
  return rows;
}

function calendarTable(w: Calendar, looks: Map<string, ElementLook>, ctx: LensHtmlContext): string {
  const cols = w.columns.length;
  const head = `<thead><tr><th></th>${w.columns.map((c) => `<th>${ctx.escape(c)}</th>`).join('')}</tr></thead>`;
  const body = w.tracks
    .map((t) => {
      const spans = w.spans.filter((sp) => sp.track === t.id);
      const rows = packSpans(spans);
      if (rows.length === 0) rows.push([]);
      return rows
        .map((row, r) => {
          const th =
            r === 0 ? `<th scope="row" rowspan="${rows.length}">${ctx.escape(t.label)}</th>` : '';
          const cells: string[] = [];
          for (let c = 0; c < cols; ) {
            const it = row.find((x) => x.from === c);
            if (!it) {
              cells.push('<td></td>');
              c++;
              continue;
            }
            const sp = spans[it.k]!;
            const look = sp.id ? looks.get(sp.id) : 'shown';
            const label = ill(sp.label, sp.illustrative);
            const cls = `wc-span${sp.at !== undefined ? ' wc-at' : ''}${sp.marker ? ` wc-${sp.marker}` : ''}${sp.illustrative ? ' w-ill' : ''}${lookClass(look)}`;
            cells.push(
              `<td colspan="${it.to - it.from + 1}"><span class="${cls}">${ctx.escape(label)}${look === 'hidden' ? '' : refChip(sp.cite, ctx)}</span></td>`,
            );
            c = it.to + 1;
          }
          return `<tr>${th}${cells.join('')}</tr>`;
        })
        .join('');
    })
    .join('');
  return `<div class="w-scroll"><table class="wc">${head}<tbody>${body}</tbody></table></div>`;
}

function calendarHtml(w: Calendar, ctx: LensHtmlContext): string {
  const ids = w.spans.flatMap((sp) => (sp.id ? [sp.id] : []));
  return `${framed(ids, w.steps, (looks) => calendarTable(w, looks, ctx), ctx)}${w.note ? `<p class="w-caption">${ctx.inline(w.note)}</p>` : ''}`;
}

/** 카드 순서를 점으로 늘어놓고 되돌아가는 화살표를 위쪽 호로 그린다 */
function stepperSvg(w: Stepper, looks: Map<string, ElementLook>): string {
  const GAP = 64;
  const n = w.items.length;
  const loops = w.loops ?? [];
  const Y = 18 + loops.length * 12 + 18;
  const W = 24 + (n - 1) * GAP + 24;
  const H = Y + 18;
  const x = (k: number) => 24 + k * GAP;
  const idx = new Map(w.items.map((it, k) => [it.id, k]));
  const arrow = (tx: number, ty: number, dir: 1 | -1) =>
    `<polygon class="wst-head" points="${f1(tx)},${f1(ty)} ${f1(tx - 6 * dir)},${f1(ty - 4)} ${f1(tx - 6 * dir)},${f1(ty + 4)}"/>`;
  const forward = w.items
    .slice(1)
    .map((_, k) => {
      const x1 = x(k) + 10;
      const x2 = x(k + 1) - 10;
      return `<line class="wst-line" x1="${x1}" y1="${Y}" x2="${x2}" y2="${Y}"/>${arrow(x2, Y, 1)}`;
    })
    .join('');
  const arcs = loops
    .map((l, j) => {
      const a = idx.get(l.from);
      const b = idx.get(l.to);
      if (a === undefined || b === undefined) return '';
      const top = Y - 22 - j * 12;
      const xa = x(a);
      const xb = x(b);
      return `<path class="wst-loop" d="M${xa},${Y - 9} C${xa},${top} ${xb},${top} ${xb},${Y - 11}"/><polygon class="wst-head" points="${xb},${Y - 9} ${xb - 4},${Y - 16} ${xb + 4},${Y - 16}"/>`;
    })
    .join('');
  const dots = w.items
    .map((it, k) => {
      const look = looks.get(it.id);
      return `<g class="wst-dot${it.optional ? ' wst-opt' : ''}${lookClass(look)}"><circle cx="${x(k)}" cy="${Y}" r="${look === 'focus' ? 11 : 9}"/><text x="${x(k)}" y="${Y + 4}" text-anchor="middle">${k + 1}</text></g>`;
    })
    .join('');
  return `<div class="w-scroll"><svg class="wst-svg" viewBox="0 0 ${W} ${H}" width="${W}" aria-hidden="true">${forward}${arcs}${dots}</svg></div>`;
}

function stepperCards(w: Stepper, looks: Map<string, ElementLook>, ctx: LensHtmlContext): string {
  const byId = new Map(w.items.map((it) => [it.id, it]));
  return `<ol class="wst-cards">${w.items
    .map((it, k) => {
      const look = looks.get(it.id);
      const back = (w.loops ?? [])
        .filter((l) => l.from === it.id && byId.has(l.to))
        .map(
          (l) =>
            `<p class="wst-back">↩ ${ctx.escape(byId.get(l.to)!.label)}(으)로 돌아가요${l.label ? `. ${ctx.escape(l.label)}` : ''}</p>`,
        )
        .join('');
      const tags = `${it.optional ? ' <span class="w-tag">선택</span>' : ''}${it.illustrative ? ` <span class="w-ill-tag">${ILL_TAG}</span>` : ''}`;
      return `<li class="wst-card${it.optional ? ' wst-opt' : ''}${it.illustrative ? ' w-ill' : ''}${lookClass(look)}"><span class="wst-n">${k + 1}</span><div><b>${ctx.escape(it.label)}</b>${tags}${it.cite ? ctx.cite(it.cite) : ''}${it.detail ? `<p>${ctx.inline(it.detail)}</p>` : ''}${back}</div></li>`;
    })
    .join('')}</ol>`;
}

function stepperHtml(w: Stepper, ctx: LensHtmlContext): string {
  return framed(
    w.items.map((it) => it.id),
    w.steps,
    (looks) => `${stepperSvg(w, looks)}${stepperCards(w, looks, ctx)}`,
    ctx,
  );
}

function analogyHtml(w: AnalogyMap, ctx: LensHtmlContext): string {
  const rows = w.rows
    .map(
      (r) =>
        `<tr><td class="wa-src">${ctx.escape(r.term)}${ctx.cite(r.termCite)}</td><td class="wa-analog">${ctx.escape(r.analog)}</td></tr>`,
    )
    .join('');
  const breaks = w.breaks.filter((b) => b.trim());
  return `<table class="wa"><thead><tr><th>원문 말</th><th>${ctx.escape(w.domain)}에 빗대면</th></tr></thead><tbody>${rows}</tbody></table>${
    breaks.length
      ? `<div class="wa-breaks"><b>비유가 안 맞는 곳</b><ul>${breaks.map((b) => `<li>${ctx.inline(b)}</li>`).join('')}</ul></div>`
      : ''
  }`;
}

export type FlowWidget = LaneGraph | Calendar | Stepper | AnalogyMap;

export const isFlowWidget = (w: Widget): w is FlowWidget =>
  w.kind === 'laneGraph' ||
  w.kind === 'calendar' ||
  w.kind === 'stepper' ||
  w.kind === 'analogyMap';

export function flowWidgetHtml(w: FlowWidget, ctx: LensHtmlContext): string {
  if (w.kind === 'laneGraph') return laneGraphHtml(w, ctx);
  if (w.kind === 'calendar') return calendarHtml(w, ctx);
  if (w.kind === 'stepper') return stepperHtml(w, ctx);
  return analogyHtml(w, ctx);
}

export function stepsMarkdown(steps: Step[] | undefined): string[] {
  if (!steps?.length) return [];
  const out = ['', '단계:'];
  steps.forEach((s, k) => {
    const state = s.state?.length
      ? ` (${s.state.map((kv) => `${kv.key}: ${kv.value}`).join(', ')})`
      : '';
    out.push(`${k + 1}. ${cell(s.label)}${s.note ? `. ${cell(s.note)}` : ''}${state}`);
  });
  return out;
}

export function flowWidgetMarkdown(w: FlowWidget): string[] {
  const out: string[] = [];
  if (w.kind === 'laneGraph') {
    const byId = new Map(w.nodes.map((n) => [n.id, n]));
    for (const lane of w.lanes) {
      const nodes = w.nodes
        .filter((n) => n.lane === lane.id)
        .map((n) => {
          const from = n.copyOf ? byId.get(n.copyOf) : undefined;
          return `${ill(n.label, n.illustrative)}${from ? `(${from.label} 복사)` : ''}`;
        });
      out.push(`- ${lane.label}: ${nodes.join(' → ') || '없음'}`);
    }
    out.push(...stepsMarkdown(w.steps));
  } else if (w.kind === 'calendar') {
    out.push(`| | ${w.columns.map(cell).join(' | ')} |`, `| --- |${w.columns.map(() => ' --- |').join('')}`);
    for (const t of w.tracks) {
      const cells = w.columns.map((_, c) =>
        w.spans
          .filter(
            (sp) =>
              sp.track === t.id && (sp.at ?? sp.from ?? -1) <= c && c <= (sp.at ?? sp.to ?? -1),
          )
          .map((sp) => cell(ill(sp.label, sp.illustrative)))
          .join(', '),
      );
      out.push(`| ${cell(t.label)} | ${cells.join(' | ')} |`);
    }
    if (w.note) out.push('', w.note);
    out.push(...stepsMarkdown(w.steps));
  } else if (w.kind === 'stepper') {
    const byId = new Map(w.items.map((it) => [it.id, it]));
    w.items.forEach((it, k) =>
      out.push(
        `${k + 1}. ${ill(it.label, it.illustrative)}${it.optional ? ' (선택)' : ''}${it.detail ? `. ${it.detail}` : ''}`,
      ),
    );
    for (const l of w.loops ?? []) {
      const a = byId.get(l.from);
      const b = byId.get(l.to);
      if (a && b)
        out.push(`- ↩ ${a.label}에서 ${b.label}(으)로 돌아간다${l.label ? `. ${l.label}` : ''}`);
    }
    out.push(...stepsMarkdown(w.steps));
  } else {
    out.push(`| 원문 말 | ${cell(w.domain)}에 빗대면 |`, '| --- | --- |');
    for (const r of w.rows) out.push(`| ${cell(r.term)} | ${cell(r.analog)} |`);
    const breaks = w.breaks.filter((b) => b.trim());
    if (breaks.length) out.push('', '비유가 안 맞는 곳:', ...breaks.map((b) => `- ${b}`));
  }
  return out;
}

export const FLOW_WIDGET_CSS = `
.w-scroll{overflow-x:auto}
.w-nav{display:flex;gap:8px;align-items:center;margin:6px 0;font-size:.9em}
.w-nav button{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:2px 12px;cursor:pointer}
.w-nav button[aria-disabled="true"]{opacity:.4;cursor:default}
.w-pos{color:var(--muted);font-variant-numeric:tabular-nums}
.w-state{display:flex;flex-wrap:wrap;gap:6px 14px;margin:6px 0;font-size:.86em}
.w-state div{display:flex;gap:6px}
.w-state dt{color:var(--muted)}.w-state dd{margin:0;font-weight:600}
.w-gone{opacity:.35}
.w-hide{visibility:hidden}
.w-tag{font-size:.75em;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 4px}
.w-cell-ref{border:0;background:none;color:var(--accent);font-size:.8em;cursor:pointer;padding:0 2px}
.wl-svg{display:block;height:auto;max-width:none}
.wl-svg text{fill:var(--fg);font-size:10px}
.wl-svg .wl-name{font-size:11px;font-weight:600}
.wl-lane{stroke:var(--line);stroke-width:1}
.wl-edge{fill:none;stroke:var(--muted);stroke-width:2}
.wl-copy{fill:none;stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3}
.wl-node circle{stroke:var(--card);stroke-width:2;fill:currentColor}
.wl-node.w-focus circle{stroke:var(--fg);stroke-width:2.5}
.wl-node.w-gone circle{fill:none;stroke:currentColor;stroke-dasharray:3 2}
.wl-node.w-ill circle{fill:var(--card);stroke:currentColor;stroke-dasharray:3 2}
path.w-gone{stroke-dasharray:3 3}
.wl-c0{color:var(--accent)}.wl-c1{color:var(--warn)}.wl-c2{color:#2a9d8f}.wl-c3{color:#8e6bbf}.wl-c4{color:#c0703a}.wl-c5{color:#5a7fa8}
.wl-c0 .wl-name,.wl-c1 .wl-name,.wl-c2 .wl-name,.wl-c3 .wl-name,.wl-c4 .wl-name,.wl-c5 .wl-name{fill:currentColor}
.wc{border-collapse:collapse;font-size:.86em;min-width:100%}
.wc th,.wc td{border:1px solid var(--line);padding:4px 6px;text-align:center;vertical-align:middle}
.wc thead th{color:var(--muted);font-weight:600}
.wc-span{display:block;background:color-mix(in srgb, var(--accent) 18%, transparent);border-radius:6px;padding:2px 6px}
.wc-at{background:none;border:1px solid var(--accent)}
.wc-release{background:var(--accent);color:var(--on-accent)}
.wc-warn{background:color-mix(in srgb, var(--warn) 22%, transparent)}
.wc-span.w-ill{background:none;border:1px dashed var(--muted)}
.wc-span.w-focus{outline:2px solid var(--fg)}
.wst-svg{display:block;height:auto;max-width:none}
.wst-line,.wst-loop{fill:none;stroke:var(--muted);stroke-width:1.5}
.wst-loop{stroke:var(--warn);stroke-dasharray:4 3}
.wst-head{fill:var(--muted)}
.wst-dot circle{fill:var(--card);stroke:var(--accent);stroke-width:1.5}
.wst-dot text{fill:var(--fg);font-size:10px}
.wst-dot.wst-opt circle{stroke-dasharray:3 2}
.wst-dot.w-focus circle{fill:var(--accent)}.wst-dot.w-focus text{fill:var(--on-accent)}
.wst-cards{list-style:none;padding:0;margin:6px 0;display:grid;gap:6px}
.wst-card{display:flex;gap:10px;border:1px solid var(--line);border-radius:8px;padding:6px 10px}
.wst-card p{margin:2px 0;font-size:.9em}
.wst-card.wst-opt{border-style:dashed}
.wst-card.w-ill{border-style:dashed;color:var(--muted)}
.wst-card.w-focus{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.wst-n{flex:none;width:22px;height:22px;border-radius:50%;background:var(--chip);display:grid;place-items:center;font-size:.8em;font-weight:700}
.wst-back{color:var(--warn)}
.wa{border-collapse:collapse;width:100%;font-size:.9em}
.wa th,.wa td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}
.wa-src{background:color-mix(in srgb, var(--accent) 8%, transparent)}
.wa-analog{background:var(--hl)}
.wa-breaks{font-size:.9em;border-left:3px solid var(--warn);padding:2px 10px;margin:8px 0}
.wa-breaks ul{margin:2px 0;padding-left:18px}
`;
