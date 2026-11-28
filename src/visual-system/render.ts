import { DIFF_KINDS, SERIES_CUES, STATUS_CUES, type DiffKind, type StatusKind } from './color.js';

/**
 * 공통 시각화 렌더러. 결과는 문자열 HTML이고 색은 전부 `--gestalt-color-*` 변수로만 쓴다.
 * 단계가 있는 요소는 `data-vs-steps`와 `data-at`을 달고 기본 상태는 마지막 단계다.
 * 스크립트가 없거나(정지 HTML, 인쇄) 모션을 줄인 환경에서도 최종 값과 라벨, 출처가 그대로 보인다.
 */

export const esc = (s: string | number): string =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export interface Source {
  label: string;
  href?: string;
}

// 출처 링크는 데이터에서 그대로 온다. javascript: 같은 스킴이 섞이면 클릭 한 번에 스크립트가 돌아서 허용한 형태만 남긴다
const safeHref = (h: string): string => (/^(https?:\/\/|#|\/|mailto:)/i.test(h) ? h : '#');

const sourceHtml = (s?: Source): string =>
  s
    ? `<p class="vs-src">출처 ${s.href ? `<a href="${esc(safeHref(s.href))}" target="_blank" rel="noopener">${esc(s.label)}</a>` : esc(s.label)}</p>`
    : '';

const fmt = (n: number): string => (Number.isInteger(n) ? n.toLocaleString('en-US') : String(n));

interface FrameOptions {
  title?: string;
  caption?: string;
  source?: Source;
  /** 단계 이름. 두 개 이상이면 이전과 다음 버튼, 위치 표시를 단다 */
  steps?: string[];
  cls?: string;
  aria?: string;
}

/** 모든 요소가 같은 틀을 쓴다. 문서 사이트와 제품이 같은 런타임으로 단계를 조작한다 */
export function frame(id: string, inner: string, o: FrameOptions = {}): string {
  const steps = o.steps ?? [];
  const n = steps.length;
  const ctl =
    n > 1
      ? `<div class="vs-ctl"><button type="button" data-vs-step="prev">이전</button><span class="vs-pos" aria-live="polite">단계 ${n} / ${n} · ${esc(steps[n - 1]!)}</span><button type="button" data-vs-step="next">다음</button></div>`
      : '';
  const stepAttr =
    n > 1
      ? ` data-vs-steps="${n}" data-vs-current="${n}" data-vs-labels="${esc(JSON.stringify(steps))}" tabindex="0"`
      : '';
  return `<figure class="vs-fig${o.cls ? ` ${o.cls}` : ''}" data-vs="${esc(id)}"${stepAttr}${o.aria ? ` aria-label="${esc(o.aria)}"` : ''}>${
    o.title ? `<figcaption class="vs-title">${esc(o.title)}</figcaption>` : ''
  }<div class="vs-body">${inner}</div>${ctl}${o.caption ? `<p class="vs-cap">${esc(o.caption)}</p>` : ''}${sourceHtml(o.source)}</figure>`;
}

export const at = (k?: number): string => (k ? ` data-at="${k}"` : '');
export const focusAt = (k?: number): string => (k ? ` data-focus-at="${k}"` : '');

export interface StatData {
  value: string;
  unit?: string;
  label: string;
  source?: Source;
}

export function statCard(d: StatData): string {
  return frame(
    'stat-card',
    `<div class="vs-stat"><b class="vs-stat-v">${esc(d.value)}${d.unit ? `<small>${esc(d.unit)}</small>` : ''}</b><span>${esc(d.label)}</span></div>`,
    { source: d.source },
  );
}

export function bigNumber(d: StatData & { context: string }): string {
  return frame(
    'big-number',
    `<div class="vs-big"><b>${esc(d.value)}${d.unit ? `<small>${esc(d.unit)}</small>` : ''}</b><p>${esc(d.label)}</p><p class="vs-muted">${esc(d.context)}</p></div>`,
    { source: d.source },
  );
}

export interface BarItem {
  label: string;
  value: number;
}

export interface BarData {
  title?: string;
  items: BarItem[];
  unit: string;
  max: number;
  /** 강조할 항목 이름. 여러 개면 단계마다 하나씩 */
  focus?: string[];
  reveal?: boolean;
  source?: Source;
}

export function barHorizontal(d: BarData, id = 'bar-horizontal'): string {
  const focus = d.focus ?? [];
  const rows = d.items
    .map((it, i) => {
      const fi = focus.indexOf(it.label);
      const w = Math.max(0, Math.min(100, (it.value / d.max) * 100));
      return `<div class="vs-bar-row${fi >= 0 && focus.length === 1 ? ' is-focus' : ''}"${d.reveal ? at(i + 1) : ''}${focus.length > 1 && fi >= 0 ? focusAt(fi + 1) : ''}><span class="vs-bar-l">${esc(it.label)}</span><span class="vs-bar-t"><span class="vs-bar" style="width:${w.toFixed(1)}%"></span></span><span class="vs-bar-v">${fmt(it.value)}${esc(d.unit)}</span></div>`;
    })
    .join('');
  const steps = d.reveal
    ? d.items.map((it) => it.label)
    : focus.length > 1
      ? focus.map((f) => `${f} 강조`)
      : undefined;
  return frame(
    id,
    `<div class="vs-bars" role="list">${rows}</div><p class="vs-axis">축 0–${fmt(d.max)}${esc(d.unit)}</p>`,
    { title: d.title, steps, source: d.source },
  );
}

export function barVertical(d: BarData, id = 'bar-vertical'): string {
  const h = 160;
  const cols = d.items
    .map((it, i) => {
      const bh = Math.round((it.value / d.max) * h);
      return `<div class="vs-col"${d.reveal ? at(i + 1) : ''}><span class="vs-bar-v">${fmt(it.value)}${esc(d.unit)}</span><span class="vs-col-bar${i === d.items.length - 1 ? ' is-last' : ''}" style="height:${bh}px"></span><span class="vs-bar-l">${esc(it.label)}</span></div>`;
    })
    .join('');
  return frame(
    id,
    `<div class="vs-cols" style="--vs-h:${h}px">${cols}</div><p class="vs-axis">축 0–${fmt(d.max)}${esc(d.unit)}</p>`,
    { title: d.title, steps: d.reveal ? d.items.map((i) => i.label) : undefined, source: d.source },
  );
}

export interface TrendSeries {
  name: string;
  points: number[];
}

export interface TrendData {
  title?: string;
  x: string[];
  series: TrendSeries[];
  unit: string;
  min: number;
  max: number;
  /** 선 끝 직접 라벨. 'step'이면 선을 먼저 보이고 다음 단계에 라벨을 붙인다 */
  endLabels?: boolean | 'step';
  /** 축은 그대로 두고 음영만 옮기는 구간. x 인덱스 범위 */
  bands?: Array<{ from: number; to: number; label: string }>;
  source?: Source;
}

const MARKERS: Record<string, (x: number, y: number) => string> = {
  circle: (x, y) => `<circle cx="${x}" cy="${y}" r="4"/>`,
  square: (x, y) => `<rect x="${x - 4}" y="${y - 4}" width="8" height="8"/>`,
  triangle: (x, y) => `<path d="M${x} ${y - 5}L${x + 5} ${y + 4}L${x - 5} ${y + 4}Z"/>`,
  diamond: (x, y) => `<path d="M${x} ${y - 5}L${x + 5} ${y}L${x} ${y + 5}L${x - 5} ${y}Z"/>`,
  cross: (x, y) =>
    `<path d="M${x - 4} ${y - 4}L${x + 4} ${y + 4}M${x + 4} ${y - 4}L${x - 4} ${y + 4}" class="vs-stroke-only"/>`,
  ring: (x, y) => `<circle cx="${x}" cy="${y}" r="4" class="vs-ring"/>`,
};

export function trendLine(d: TrendData, id = 'trend-line'): string {
  const W = 560;
  const H = 240;
  const L = 44;
  const R = d.endLabels ? 128 : 16;
  const T = 14;
  const B = 30;
  const px = (i: number) => L + (i * (W - L - R)) / Math.max(1, d.x.length - 1);
  const py = (v: number) => T + (1 - (v - d.min) / (d.max - d.min)) * (H - T - B);
  const ticks = [d.min, (d.min + d.max) / 2, d.max];
  const grid = ticks
    .map(
      (t) =>
        `<line x1="${L}" x2="${W - R}" y1="${py(t)}" y2="${py(t)}" class="vs-grid"/><text x="${L - 6}" y="${py(t) + 4}" text-anchor="end" class="vs-tick">${fmt(t)}</text>`,
    )
    .join('');
  const xl = d.x
    .map(
      (x, i) =>
        `<text x="${px(i)}" y="${H - 10}" text-anchor="middle" class="vs-tick">${esc(x)}</text>`,
    )
    .join('');
  const bandSteps = d.bands ?? [];
  const bands = bandSteps
    .map(
      (b, i) =>
        `<g data-focus-at="${i + 1}" class="vs-band"><rect x="${px(b.from)}" y="${T}" width="${px(b.to) - px(b.from)}" height="${H - T - B}"/><text x="${(px(b.from) + px(b.to)) / 2}" y="${T + 14}" text-anchor="middle">${esc(b.label)}</text></g>`,
    )
    .join('');
  const lines = d.series
    .map((s, si) => {
      const cue = SERIES_CUES[si % SERIES_CUES.length]!;
      const pts = s.points.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
      const marks = s.points.map((v, i) => MARKERS[cue.marker]!(px(i), py(v))).join('');
      const last = s.points[s.points.length - 1]!;
      const label = d.endLabels
        ? `<text x="${W - R + 8}" y="${py(last) + 4}" class="vs-end"${d.endLabels === 'step' ? at(2) : ''}>${esc(s.name)} ${fmt(last)}${esc(d.unit)}</text>`
        : '';
      return `<g class="vs-s${si + 1}"><polyline points="${pts}" fill="none"${cue.dash ? ` stroke-dasharray="${cue.dash}"` : ''}/>${marks}${label}</g>`;
    })
    .join('');
  const legend = `<ul class="vs-legend">${d.series
    .map(
      (s, si) =>
        `<li class="vs-s${si + 1}"><svg width="28" height="10" aria-hidden="true"><line x1="0" x2="28" y1="5" y2="5"${SERIES_CUES[si]!.dash ? ` stroke-dasharray="${SERIES_CUES[si]!.dash}"` : ''}/></svg>${esc(s.name)} <span class="vs-muted">${esc(SERIES_CUES[si]!.label)}</span></li>`,
    )
    .join('')}</ul>`;
  const steps =
    d.endLabels === 'step'
      ? ['선', '선과 끝 라벨']
      : bandSteps.length > 1
        ? bandSteps.map((b) => b.label)
        : undefined;
  const aria = `${d.title ?? '추세선'}: ${d.series.map((s) => `${s.name} ${s.points.join(', ')}${d.unit}`).join('; ')}`;
  return frame(
    id,
    `<svg viewBox="0 0 ${W} ${H}" class="vs-svg" role="img" aria-label="${esc(aria)}">${bands}${grid}${xl}${lines}</svg>${legend}<p class="vs-axis">세로축 ${fmt(d.min)}–${fmt(d.max)}${esc(d.unit)}</p>`,
    { title: d.title, steps, source: d.source },
  );
}

export interface DonutData {
  value: number;
  denominator: number;
  unit: string;
  label: string;
  source?: Source;
  /** 재생하면 0에서 값까지 호와 숫자가 함께 자란다 */
  sync?: boolean;
}

export function donut(d: DonutData, id = 'donut'): string {
  const r = 70;
  const c = 2 * Math.PI * r;
  const ratio = d.value / d.denominator;
  const pct = Math.round(ratio * 1000) / 10;
  return frame(
    id,
    `<div class="vs-donut"${d.sync ? ` data-vs-sync="${pct}"` : ''}><svg viewBox="0 0 180 180" role="img" aria-label="${esc(`${d.label} ${pct}${d.unit} (${fmt(d.value)} / ${fmt(d.denominator)})`)}"><circle cx="90" cy="90" r="${r}" class="vs-donut-track"/><circle cx="90" cy="90" r="${r}" class="vs-donut-arc" stroke-dasharray="${(ratio * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 90 90)" style="--vs-c:${c.toFixed(2)}"/></svg><div class="vs-donut-c"><b data-vs-count="${pct}">${pct}</b><small>${esc(d.unit)}</small></div></div><p class="vs-donut-l">${esc(d.label)} <span class="vs-muted">${fmt(d.value)} / ${fmt(d.denominator)}</span></p>`,
    { source: d.source, steps: d.sync ? ['0', `${pct}${d.unit}`] : undefined },
  );
}

export interface CardData {
  title: string;
  rows: Array<{ k: string; v: string }>;
  tone?: 'accent' | 'plain';
}

export function comparisonCards(cards: CardData[], source?: Source, title?: string): string {
  const html = cards
    .map(
      (c) =>
        `<section class="vs-card${c.tone === 'accent' ? ' is-accent' : ''}"><h4>${esc(c.title)}</h4><dl>${c.rows.map((r) => `<dt>${esc(r.k)}</dt><dd>${esc(r.v)}</dd>`).join('')}</dl></section>`,
    )
    .join('');
  return frame('comparison-cards', `<div class="vs-cards">${html}</div>`, { source, title });
}

export function dotGrid(
  d: { value: number; denominator: number; label: string; source?: Source; stepped?: boolean },
  id = 'dot-grid',
): string {
  const dots = Array.from(
    { length: d.denominator },
    (_, i) =>
      `<span class="vs-dot${i < d.value ? ' is-on' : ''}"${d.stepped && i < d.value ? ' data-at="2"' : ''}></span>`,
  ).join('');
  return frame(
    id,
    `<div class="vs-dots" role="img" aria-label="${esc(`${d.denominator}칸 중 ${d.value}칸, ${d.label}`)}">${dots}</div><p class="vs-dots-l"><b>${d.value}</b> / ${d.denominator} ${esc(d.label)}</p>`,
    {
      source: d.source,
      steps: d.stepped ? [`분모 ${d.denominator}칸`, `${d.value}칸 채움`] : undefined,
    },
  );
}

export function layerStack(
  d: { layers: Array<{ name: string; value: string }>; navigate?: boolean; source?: Source },
  id = 'layer-stack',
): string {
  const rows = d.layers
    .map(
      (l, i) =>
        `<div class="vs-layer"${d.navigate ? focusAt(i + 1) : ''}><span>${esc(l.name)}</span><b>${esc(l.value)}</b></div>`,
    )
    .join('');
  return frame(id, `<div class="vs-layers">${rows}</div>`, {
    source: d.source,
    steps: d.navigate ? d.layers.map((l) => l.name) : undefined,
  });
}

export function balanceScale(d: {
  left: { title: string; items: string[] };
  right: { title: string; items: string[] };
  verdict: string;
  source?: Source;
}): string {
  const all = [
    ...d.left.items.map((t) => ({ side: 'l', t })),
    ...d.right.items.map((t) => ({ side: 'r', t })),
  ];
  const order = all.map((x, i) => ({ ...x, k: i + 1 }));
  const side = (s: 'l' | 'r', title: string) =>
    `<div class="vs-pan vs-pan-${s}"><h4>${esc(title)}</h4><ul>${order
      .filter((x) => x.side === s)
      .map((x) => `<li${at(x.k)}>${esc(x.t)}</li>`)
      .join('')}</ul></div>`;
  const tilt = d.left.items.length - d.right.items.length;
  return frame(
    'balance-scale',
    `<div class="vs-scale" style="--vs-tilt:${Math.max(-8, Math.min(8, tilt * 3))}deg"><div class="vs-beam"></div>${side('l', d.left.title)}${side('r', d.right.title)}</div><p class="vs-verdict"${at(order.length)}>${esc(d.verdict)}</p>`,
    { source: d.source, steps: order.map((x) => x.t) },
  );
}

export interface GraphNode {
  id: string;
  label: string;
  group: number;
  x: number;
  y: number;
  at?: number;
  human?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  at?: number;
}

export function nodeGraph(
  d: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    groups: string[];
    steps?: string[];
    focus?: string[];
    source?: Source;
    title?: string;
  },
  id = 'node-graph',
): string {
  const W = 560;
  const H = 260;
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const edges = d.edges
    .map((e) => {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) return '';
      return `<g class="vs-edge"${at(e.at)}><line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"${e.dashed ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#vs-arrow)"/>${e.label ? `<text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 6}" text-anchor="middle">${esc(e.label)}</text>` : ''}</g>`;
    })
    .join('');
  const nodes = d.nodes
    .map((n) => {
      const fi = d.focus?.indexOf(n.id) ?? -1;
      const w = Math.max(64, n.label.length * 13 + 20);
      return `<g class="vs-node vs-s${n.group + 1}${n.human ? ' is-human' : ''}"${at(n.at)}${fi >= 0 ? focusAt(fi + 1) : ''} tabindex="0" role="listitem" aria-label="${esc(`${n.label}, ${d.groups[n.group] ?? ''}`)}"><rect x="${n.x - w / 2}" y="${n.y - 15}" width="${w}" height="30" rx="6"/><text x="${n.x}" y="${n.y + 5}" text-anchor="middle">${n.human ? '👤 ' : ''}${esc(n.label)}</text></g>`;
    })
    .join('');
  const legend = `<ul class="vs-legend">${d.groups.map((g, i) => `<li class="vs-s${i + 1}"><span class="vs-key"></span>${esc(g)}</li>`).join('')}</ul>`;
  return frame(
    id,
    `<svg viewBox="0 0 ${W} ${H}" class="vs-svg" role="list" aria-label="${esc(d.title ?? '관계 그래프')}"><defs><marker id="vs-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="vs-arrowhead"/></marker></defs>${edges}${nodes}</svg>${legend}`,
    { source: d.source, steps: d.steps, title: d.title },
  );
}

export interface LogEvent {
  time: string;
  source: string;
  status: StatusKind;
  text: string;
}

export function eventLog(
  events: LogEvent[],
  o: { live?: LogEvent[]; source?: Source } = {},
): string {
  const row = (e: LogEvent) =>
    `<li class="vs-ev"><time>${esc(e.time)}</time><span class="vs-src-badge">${esc(e.source)}</span>${statusBadge(e.status)}<span>${esc(e.text)}</span></li>`;
  const live = o.live?.length
    ? `<div class="vs-live-ctl"><button type="button" data-vs-live>새 이벤트 받기</button><span class="vs-live-n" aria-live="polite"></span></div><template data-vs-live-queue>${o.live.map(row).join('')}</template>`
    : '';
  return frame(
    'event-log',
    `<ol class="vs-log" tabindex="0" aria-label="이벤트 로그">${events.map(row).join('')}</ol>${live}`,
    { source: o.source },
  );
}

export interface DurationSegment {
  label: string;
  plan: number;
  actual: number;
}

export function durationBar(
  d: {
    total: number;
    unit: string;
    segments: DurationSegment[];
    deviation?: boolean;
    source?: Source;
  },
  id = 'duration-bar',
): string {
  const sum = d.segments.reduce((t, s) => t + s.actual, 0);
  const bar = d.segments
    .map(
      (s, i) =>
        `<span class="vs-seg vs-s${(i % 6) + 1}" style="flex:${s.actual}" title="${esc(`${s.label} ${s.actual}${d.unit}`)}"><b>${esc(s.label)}</b> ${fmt(s.actual)}${esc(d.unit)}</span>`,
    )
    .join('');
  const dev = d.deviation
    ? `<table class="vs-table"><thead><tr><th>구간</th><th>계획</th><th>실제</th><th>편차</th></tr></thead><tbody>${d.segments
        .map((s) => {
          const diff = s.actual - s.plan;
          const kind: StatusKind = diff > 0 ? 'warning' : 'success';
          return `<tr><td>${esc(s.label)}</td><td>${fmt(s.plan)}${esc(d.unit)}</td><td>${fmt(s.actual)}${esc(d.unit)}</td><td class="vs-${kind}-text">${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${fmt(Math.abs(diff))}${esc(d.unit)}</td></tr>`;
        })
        .join('')}</tbody></table>`
    : '';
  return frame(
    id,
    `<p class="vs-muted">전체 ${fmt(d.total)}${esc(d.unit)} · 구간 합 ${fmt(sum)}${esc(d.unit)}</p><div class="vs-dur">${bar}</div>${dev}`,
    { source: d.source },
  );
}

export function statusBadge(kind: StatusKind, label?: string): string {
  const cue = STATUS_CUES[kind];
  return `<span class="vs-badge vs-badge-${kind}"><span aria-hidden="true">${cue.symbol}</span> ${esc(label ?? cue.label)}</span>`;
}

export function statusMatrix(
  d: {
    cols: string[];
    rows: Array<{ label: string; cells: Array<StatusKind | null> }>;
    reveal?: boolean;
    source?: Source;
  },
  id = 'status-matrix',
): string {
  let k = 0;
  const steps: string[] = [];
  const body = d.rows
    .map(
      (r) =>
        `<tr><th scope="row">${esc(r.label)}</th>${r.cells
          .map((c, ci) => {
            if (d.reveal) {
              k++;
              steps.push(`${r.label} · ${d.cols[ci]}`);
            }
            return `<td${d.reveal ? at(k) : ''}>${c ? statusBadge(c) : '<span class="vs-muted">없음</span>'}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  return frame(
    id,
    `<table class="vs-table vs-matrix"><thead><tr><th></th>${d.cols.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`,
    { source: d.source, steps: d.reveal ? steps : undefined },
  );
}

export function sourceCite(d: {
  text: string;
  cites: Array<{ label: string; href?: string }>;
}): string {
  return frame(
    'source-cite',
    `<p class="vs-prose">${esc(d.text)} ${d.cites.map((c) => `<a class="vs-cite" ${c.href ? `href="${esc(safeHref(c.href))}"` : 'href="#"'}>${esc(c.label)}</a>`).join(' ')}</p>`,
  );
}

export function quoteCard(d: { quote: string; who?: string; source?: Source }): string {
  return frame(
    'quote-card',
    `<blockquote class="vs-quote"><p>${esc(d.quote)}</p>${d.who ? `<footer>${esc(d.who)}</footer>` : ''}</blockquote>`,
    { source: d.source },
  );
}

export function lineHighlight(
  d: { lines: string[]; focus: number[]; source?: Source },
  id = 'line-highlight',
): string {
  const rows = d.lines.map((l, i) => {
    const fi = d.focus.indexOf(i);
    return `<li${fi >= 0 ? focusAt(fi + 1) : ''}><span class="vs-ln">${i + 1}</span>${esc(l)}</li>`;
  });
  return frame(id, `<ol class="vs-lines">${rows.join('')}</ol>`, {
    source: d.source,
    steps: d.focus.length > 1 ? d.focus.map((f) => `${f + 1}번째 줄`) : undefined,
  });
}

export function diffView(
  rows: Array<{ kind: DiffKind | 'same'; text: string }>,
  source?: Source,
): string {
  const html = rows
    .map((r) => {
      if (r.kind === 'same')
        return `<li class="vs-diff-same"><span class="vs-diff-sym" aria-hidden="true"> </span>${esc(r.text)}</li>`;
      const k = DIFF_KINDS[r.kind];
      return `<li class="vs-diff-${r.kind}"><span class="vs-diff-sym" aria-label="${k.label}">${k.symbol}</span>${esc(r.text)}</li>`;
    })
    .join('');
  return frame(
    'diff',
    `<ul class="vs-diff">${html}</ul><p class="vs-muted">+ 추가 · − 삭제 · ~ 변경</p>`,
    { source },
  );
}

export interface SlideData {
  kind: string;
  title?: string;
  sub?: string;
  items?: string[];
  value?: string;
  unit?: string;
  quote?: string;
  who?: string;
  left?: { title: string; items: string[] };
  right?: { title: string; items: string[] };
  bars?: BarItem[];
  unitMax?: number;
  source?: Source;
  page?: string;
}

/** 16:9 장표 한 장. 단계가 있는 장은 클릭 공개와 같은 data-at을 쓴다 */
export function slide(d: SlideData): string {
  const items = d.items ?? [];
  const stepped = ['slide-list', 'slide-process', 'slide-qa'].includes(d.kind);
  let inner: string;
  switch (d.kind) {
    case 'slide-cover':
      inner = `<p class="sl-kicker">${esc(d.sub ?? '')}</p><h3 class="sl-hero">${esc(d.title ?? '')}</h3><p class="sl-meta">${esc(items.join(' · '))}</p>`;
      break;
    case 'slide-chapter':
      inner = `<b class="sl-chap-n">${esc(d.value ?? '01')}</b><h3 class="sl-h">${esc(d.title ?? '')}</h3>`;
      break;
    case 'slide-statement':
      inner = `<h3 class="sl-hero">${esc(d.title ?? '')}</h3>${d.sub ? `<p class="sl-sub">${esc(d.sub)}</p>` : ''}`;
      break;
    case 'slide-number':
      inner = `<b class="sl-num">${esc(d.value ?? '')}<small>${esc(d.unit ?? '')}</small></b><p class="sl-sub">${esc(d.title ?? '')}</p>`;
      break;
    case 'slide-compare':
      inner = `<h3 class="sl-h">${esc(d.title ?? '')}</h3><div class="sl-2col">${[d.left, d.right]
        .map((s, i) =>
          s
            ? `<section class="${i ? 'is-accent' : ''}"><h4>${esc(s.title)}</h4><ul>${s.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>`
            : '',
        )
        .join('')}</div>`;
      break;
    case 'slide-quote':
      inner = `<blockquote class="sl-quote">“${esc(d.quote ?? '')}”</blockquote><p class="sl-sub">${esc(d.who ?? '')}</p>`;
      break;
    case 'slide-list':
      inner = `<h3 class="sl-h">${esc(d.title ?? '')}</h3><ul class="sl-list">${items.map((x, i) => `<li${at(i + 1)}>${esc(x)}</li>`).join('')}</ul>`;
      break;
    case 'slide-process':
      inner = `<h3 class="sl-h">${esc(d.title ?? '')}</h3><ol class="sl-proc">${items.map((x, i) => `<li${at(i + 1)}><b>${i + 1}</b>${esc(x)}</li>`).join('')}</ol>`;
      break;
    case 'slide-bar-chart': {
      const max = d.unitMax ?? Math.max(...(d.bars ?? []).map((b) => b.value));
      inner = `<h3 class="sl-h">${esc(d.title ?? '')}</h3><div class="vs-bars">${(d.bars ?? [])
        .map(
          (b, i) =>
            `<div class="vs-bar-row${i === 0 ? ' is-focus' : ''}"><span class="vs-bar-l">${esc(b.label)}</span><span class="vs-bar-t"><span class="vs-bar" style="width:${((b.value / max) * 100).toFixed(1)}%"></span></span><span class="vs-bar-v">${fmt(b.value)}${esc(d.unit ?? '')}</span></div>`,
        )
        .join('')}</div>`;
      break;
    }
    case 'slide-image':
      inner = `<h3 class="sl-h">${esc(d.title ?? '')}</h3><div class="sl-img" role="img" aria-label="${esc(d.sub ?? '')}"><span>${esc(d.sub ?? '이미지')}</span></div>`;
      break;
    case 'slide-qa':
      inner = `<h3 class="sl-h">${esc(d.title ?? '')}</h3><dl class="sl-qa">${items
        .map((x, i) =>
          i % 2 === 0 ? `<dt${at(i + 1)}>Q. ${esc(x)}</dt>` : `<dd${at(i + 1)}>A. ${esc(x)}</dd>`,
        )
        .join('')}</dl>`;
      break;
    default:
      inner = `<h3 class="sl-h">${esc(d.title ?? '')}</h3>`;
  }
  const page = d.page ? `<span class="sl-page">${esc(d.page)}</span>` : '';
  const src = d.source ? `<span class="sl-src">출처 ${esc(d.source.label)}</span>` : '';
  return frame(
    d.kind,
    `<div class="vs-slide sl-${d.kind.replace('slide-', '')}${d.kind === 'slide-chapter' || d.kind === 'slide-statement' ? ' is-inverse' : ''}">${inner}<footer>${src}${page}</footer></div>`,
    {
      steps: stepped ? items.map((x, i) => `${i + 1}. ${x.slice(0, 18)}`) : undefined,
    },
  );
}
