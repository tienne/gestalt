import type { LensHtmlContext } from './render-lens.js';
import type { Widget, WidgetValue } from './lens-widget-schema.js';

/**
 * 인터랙티브 그림 렌더러. 상태마다 그림을 다 그려 두고 하나만 보인다.
 * 뷰어 스크립트는 hidden만 바꾼다. 값을 계산하거나 단계 사이를 채우지 않는다
 */

export const WIDGET_BADGE: Record<Widget['class'], string> = {
  A: '원문 표 데이터',
  B: '설명용, 원문 데이터 아님',
  C: 'AI가 이해한 대로 다시 그림',
};

/** 값 글자. 표 칸 출처가 있으면 원문 칸 글자를 그대로 보인다(0.2862를 0.29로 바꾸지 않는다) */
function valueText(v: WidgetValue, ctx: LensHtmlContext): string {
  if (v.src && 'table' in v.src) {
    const ref = v.src;
    const cell = ctx.source?.tables.find((t) => t.id === ref.table)?.rows[ref.row]?.[ref.col];
    if (cell !== undefined) return cell;
  }
  return String(v.value);
}

function valueSrc(v: WidgetValue, ctx: LensHtmlContext): string {
  if (!v.src) return '';
  if ('table' in v.src) {
    const ref = v.src;
    const table = ctx.source?.tables.find((t) => t.id === ref.table);
    return ` data-cell="${ctx.escape(`${ref.table}:${ref.row}:${ref.col}`)}"${table ? ` data-unit="${table.unit}" title="표 ${ctx.escape(table.number)} ${ref.row + 1}행 ${ref.col + 1}열"` : ''}`;
  }
  return ` data-unit="${v.src.cite.key}"`;
}

const pct = (n: number) => `${Math.max(0, Math.min(100, n)).toFixed(1)}%`;

function toggleBarsHtml(w: Extract<Widget, { kind: 'toggleBars' }>, ctx: LensHtmlContext): string {
  const max =
    Math.max(...w.items.flatMap((it) => [Math.abs(it.off.value), Math.abs(it.on.value)]), 0) || 1;
  const state = (which: 'off' | 'on', hidden: boolean) =>
    `<div class="wb-bars" data-w-state="${which}"${hidden ? ' hidden' : ''}>${w.items
      .map((it) => {
        const v = it[which];
        return `<div class="wb-row"><span class="wb-label">${ctx.escape(it.label)}</span><span class="wb-track"><span class="wb-bar" style="width:${pct((Math.abs(v.value) / max) * 100)}"></span></span><span class="wb-val"${valueSrc(v, ctx)}>${ctx.escape(valueText(v, ctx))}</span></div>`;
      })
      .join('')}</div>`;
  return `<div class="w-toggle" role="group" aria-label="조건 바꾸기"><button type="button" data-w-toggle="off" aria-pressed="true">${ctx.escape(w.toggle.off)}</button><button type="button" data-w-toggle="on" aria-pressed="false">${ctx.escape(w.toggle.on)}</button></div>${state('off', false)}${state('on', true)}`;
}

function heatmapHtml(w: Extract<Widget, { kind: 'heatmap' }>, ctx: LensHtmlContext): string {
  const flat = w.cells.flat().map((v) => v.value);
  const min = Math.min(...flat);
  const span = Math.max(...flat) - min || 1;
  // 진하기는 값 크기 순서만 따른다. 좋은 쪽이 어디인지는 범례 글자가 알려 준다
  const shade = (v: number) => Math.round(12 + ((v - min) / span) * 70);
  const legend =
    w.better === 'low'
      ? '진할수록 값이 커요. 낮을수록 좋은 지표예요.'
      : w.better === 'high'
        ? '진할수록 값이 커요. 높을수록 좋은 지표예요.'
        : '진할수록 값이 커요.';
  return `<div class="wh-scroll"><table class="wh"><thead><tr><th>${w.y.title ? ctx.escape(w.y.title) : ''}${w.x.title ? ` / ${ctx.escape(w.x.title)}` : ''}</th>${w.x.labels
    .map((l) => `<th>${ctx.escape(l)}</th>`)
    .join('')}</tr></thead><tbody>${w.cells
    .map(
      (row, r) =>
        `<tr><th>${ctx.escape(w.y.labels[r] ?? '')}</th>${row
          .map(
            (v) =>
              `<td style="background:color-mix(in srgb, var(--accent) ${shade(v.value)}%, transparent)"${valueSrc(v, ctx)}>${ctx.escape(valueText(v, ctx))}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('')}</tbody></table></div><p class="w-legend">${legend}</p>`;
}

/** 노드는 원 위에 같은 간격으로 놓는다. 단계마다 같은 자리라 넘겨 볼 때 간선만 바뀐다 */
function stepSvg(
  step: Extract<Widget, { kind: 'stepSlider' }>['steps'][number],
  ctx: LensHtmlContext,
): string {
  const W = 360;
  const H = 260;
  const R = 95;
  const pos = new Map(
    step.nodes.map((n, k) => {
      const a = (2 * Math.PI * k) / step.nodes.length - Math.PI / 2;
      return [n.id, { x: W / 2 + R * Math.cos(a), y: H / 2 + R * Math.sin(a), label: n.label }];
    }),
  );
  const edges = step.edges
    .map((e) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) return '';
      return `<line class="ws-${e.strength}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"/>`;
    })
    .join('');
  const nodes = [...pos.values()]
    .map(
      (p) =>
        `<g><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="9"/><text x="${p.x.toFixed(1)}" y="${(p.y + (p.y > H / 2 ? 22 : -14)).toFixed(1)}" text-anchor="middle">${ctx.escape(p.label)}</text></g>`,
    )
    .join('');
  return `<svg class="ws-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${ctx.escape(step.label)}">${edges}${nodes}</svg>`;
}

function stepSliderHtml(w: Extract<Widget, { kind: 'stepSlider' }>, ctx: LensHtmlContext): string {
  const n = w.steps.length;
  const states = w.steps
    .map(
      (s, k) =>
        `<div data-w-state="${k}"${k === 0 ? '' : ' hidden'}><p class="ws-step"><b>${ctx.escape(s.label)}</b>${s.note ? ` ${ctx.inline(s.note)}` : ''}</p>${stepSvg(s, ctx)}</div>`,
    )
    .join('');
  // 슬라이더는 정수 칸만 고른다. 칸 사이 값은 없다
  return `<label class="ws-range">단계 <input type="range" min="0" max="${n - 1}" step="1" value="0" data-w-slider aria-valuetext="${ctx.escape(w.steps[0]!.label)}" data-labels="${ctx.escape(JSON.stringify(w.steps.map((s) => s.label)))}"></label><ol class="ws-ticks">${w.steps
    .map((s) => `<li>${ctx.escape(s.label)}</li>`)
    .join(
      '',
    )}</ol>${states}<p class="w-legend">굵은 선은 강한 간선, 옅은 선은 약한 간선이에요.</p>`;
}

function beforeAfterHtml(
  w: Extract<Widget, { kind: 'beforeAfter' }>,
  ctx: LensHtmlContext,
): string {
  const side = (s: typeof w.before) =>
    `<div class="wba-side"><h5>${ctx.escape(s.title)}</h5><ul>${s.items
      .map(
        (it) =>
          `<li>${ctx.escape(it.label)}${it.value ? ` <b${valueSrc(it.value, ctx)}>${ctx.escape(valueText(it.value, ctx))}</b>` : ''}</li>`,
      )
      .join('')}</ul></div>`;
  return `<div class="wba">${side(w.before)}<span class="wba-arrow" aria-hidden="true">→</span>${side(w.after)}</div>`;
}

export function widgetHtml(w: Widget, ctx: LensHtmlContext): string {
  const body =
    w.kind === 'toggleBars'
      ? toggleBarsHtml(w, ctx)
      : w.kind === 'heatmap'
        ? heatmapHtml(w, ctx)
        : w.kind === 'stepSlider'
          ? stepSliderHtml(w, ctx)
          : beforeAfterHtml(w, ctx);
  const diffs =
    w.class === 'C' && w.differences?.length
      ? `<div class="w-diffs"><b>원문 그림과 다른 점</b><ul>${w.differences
          .filter((d) => d.trim())
          .map((d) => `<li>${ctx.inline(d)}</li>`)
          .join('')}</ul></div>`
      : '';
  const fig =
    w.class === 'C' && w.figure ? ctx.source?.figures.find((f) => f.id === w.figure) : undefined;
  // C는 원문 크롭과 나란히 둔다. 토글로 바꾸면 어느 쪽이 원문인지 헷갈린다
  const original = fig?.image
    ? `<figure class="w-original"><img src="${ctx.escape(fig.image)}" alt="그림 ${ctx.escape(fig.number)} 원문" loading="lazy"><figcaption>원문 그림 ${ctx.escape(fig.number)} ${ctx.loc(fig.unit)}</figcaption></figure>`
    : '';
  const head = `<p class="w-head"><span class="w-badge w-badge-${w.class}">${WIDGET_BADGE[w.class]}</span> <b>${ctx.escape(w.title)}</b>${ctx.cite(w.cite)}</p>${diffs}${w.caption ? `<p class="w-caption">${ctx.inline(w.caption)}</p>` : ''}`;
  const inner = `<div class="w-body">${body}</div>`;
  return `<figure class="widget w-${w.class}" data-widget id="${ctx.pfx ?? ''}w-${ctx.escape(w.id)}">${head}${original ? `<div class="w-pair">${original}${inner}</div>` : inner}</figure>`;
}

export function widgetMarkdown(w: Widget, ctx: { cell: (v: WidgetValue) => string }): string[] {
  const out = [`**${w.title}** *(${WIDGET_BADGE[w.class]})*`, ''];
  if (w.class === 'C' && w.differences?.length) {
    out.push('원문 그림과 다른 점:', ...w.differences.map((d) => `- ${d}`), '');
  }
  if (w.kind === 'toggleBars') {
    out.push(`| 항목 | ${w.toggle.off} | ${w.toggle.on} |`, '| --- | --- | --- |');
    for (const it of w.items)
      out.push(`| ${it.label} | ${ctx.cell(it.off)} | ${ctx.cell(it.on)} |`);
  } else if (w.kind === 'heatmap') {
    out.push(
      `| | ${w.x.labels.join(' | ')} |`,
      `| --- |${w.x.labels.map(() => ' --- |').join('')}`,
    );
    w.cells.forEach((row, r) =>
      out.push(`| ${w.y.labels[r] ?? ''} | ${row.map(ctx.cell).join(' | ')} |`),
    );
  } else if (w.kind === 'stepSlider') {
    for (const s of w.steps) {
      const strong = s.edges.filter((e) => e.strength === 'strong').length;
      out.push(
        `- ${s.label}: 강한 간선 ${strong}개, 약한 간선 ${s.edges.length - strong}개${s.note ? `. ${s.note}` : ''}`,
      );
    }
  } else {
    for (const side of [w.before, w.after]) {
      out.push(
        `- ${side.title}: ${side.items.map((it) => (it.value ? `${it.label} ${ctx.cell(it.value)}` : it.label)).join(', ')}`,
      );
    }
  }
  out.push('');
  return out;
}

export const WIDGET_CSS = `
.widget{margin:16px 0;border:1px solid var(--line);border-radius:10px;background:var(--card);padding:10px 14px}
.w-head{margin:0 0 6px}
.w-badge{display:inline-block;font-size:.75em;font-weight:700;border-radius:999px;padding:1px 9px;border:1px solid currentColor}
.w-badge-A{color:var(--accent)}
.w-badge-B{color:var(--muted)}
.w-badge-C{color:var(--warn)}
.w-diffs{font-size:.9em;border-left:3px solid var(--warn);padding:2px 10px;margin:6px 0;background:var(--hl);border-radius:0 6px 6px 0}
.w-diffs ul{margin:2px 0;padding-left:18px}
.w-caption,.w-legend{color:var(--muted);font-size:.88em;margin:6px 0}
.w-pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:12px;align-items:start}
.w-original{margin:0}.w-original img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:6px;background:#fff}
.w-original figcaption{font-size:.85em;color:var(--muted)}
.w-toggle{display:flex;gap:6px;margin:6px 0}
.w-toggle button{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:2px 12px;cursor:pointer}
.w-toggle button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.wb-row{display:grid;grid-template-columns:minmax(120px,38%) 1fr auto;gap:8px;align-items:center;font-size:.88em;margin:3px 0}
.wb-track{background:var(--chip);border-radius:3px;height:12px;overflow:hidden}
.wb-bar{display:block;height:100%;background:var(--accent)}
.wb-val{font-variant-numeric:tabular-nums;cursor:pointer}
.wh-scroll{overflow-x:auto}.wh{border-collapse:collapse;font-size:.86em;font-variant-numeric:tabular-nums}
.wh th,.wh td{padding:4px 10px;border:1px solid var(--line);text-align:center}
.wh td{cursor:pointer}
.ws-range{display:flex;gap:8px;align-items:center;font-size:.9em}
.ws-range input{flex:1}
.ws-ticks{display:flex;justify-content:space-between;list-style:none;padding:0;margin:0 0 4px;font-size:.75em;color:var(--muted)}
.ws-step{margin:4px 0;font-size:.9em}
.ws-svg{display:block;width:100%;max-width:420px;height:auto}
.ws-svg circle{fill:var(--card);stroke:var(--accent);stroke-width:1.5}
.ws-svg text{fill:var(--fg);font-size:11px}
.ws-svg line.ws-strong{stroke:var(--warn);stroke-width:2.5}
.ws-svg line.ws-weak{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3;opacity:.7}
.wba{display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center}
.wba-side{border:1px solid var(--line);border-radius:8px;padding:4px 10px}
.wba-side h5{margin:4px 0}
.wba-arrow{font-size:1.4em;color:var(--muted)}
@container (max-width:640px){.w-pair{grid-template-columns:minmax(0,1fr)}}
`;
