import type { ElementLook } from './lens-steps.js';
import type { Widget } from './lens-widget-schema.js';
import { sequenceSteps, stepElementIds } from './lens-widgets.js';
import type { LensHtmlContext } from './render-lens.js';
import { f1, framed, ill as named, lookClass, srText, stepsMarkdown } from './render-widgets-flow.js';

/**
 * 상자와 화살표로 그리는 단계형 그림(stateMachine, sequence, swimlane). 자리는 렌더러가 잡는다.
 * 화살표 머리는 marker 대신 다각형으로 그린다. 단계마다 그림을 미리 그려 두면 같은 marker id가 한 문서에 여러 번 생긴다
 */

type StateMachine = Extract<Widget, { kind: 'stateMachine' }>;
type Sequence = Extract<Widget, { kind: 'sequence' }>;
type Swimlane = Extract<Widget, { kind: 'swimlane' }>;
export type GraphWidget = StateMachine | Sequence | Swimlane;

export const isGraphWidget = (w: Widget): w is GraphWidget =>
  w.kind === 'stateMachine' || w.kind === 'sequence' || w.kind === 'swimlane';

const LINE = 14;
const BOX_W = 116;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 11px 글꼴에서 한글 한 자를 1로 친 글자 폭. 영숫자와 기호는 그 절반 남짓이다 */
const charWidth = (ch: string) =>
  /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(ch) ? 1 : ch === ' ' ? 0.35 : 0.6;
const widthOf = (text: string) => [...text].reduce((n, ch) => n + charWidth(ch), 0);

/** 폭 안에 들어가는 앞부분 */
function fit(text: string, max: number): string {
  let w = 0;
  let k = 0;
  for (const ch of text) {
    w += charWidth(ch);
    if (w > max) break;
    k += ch.length;
  }
  return text.slice(0, Math.max(k, 1));
}

/**
 * 상자 안 줄바꿈. 띄어쓰기에서 먼저 끊고 한 낱말이 폭을 넘으면 폭에 맞춰 자른다.
 * 세 줄을 넘으면 말줄임표로 끝낸다. max는 한글 글자 수로 센 줄 폭이다
 */
export function wrapLabel(label: string, max = 9.8, lines = 3): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of label.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (widthOf(rest) > max) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      const head = fit(rest, max);
      out.push(head);
      rest = rest.slice(head.length);
    }
    const next = cur ? `${cur} ${rest}` : rest;
    if (widthOf(next) > max && cur) {
      out.push(cur);
      cur = rest;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  if (out.length <= lines) return out;
  const kept = out.slice(0, lines);
  kept[lines - 1] = `${fit(kept[lines - 1]!, max - 1)}…`;
  return kept;
}

function textLines(
  lines: string[],
  x: number,
  cy: number,
  ctx: LensHtmlContext,
  cls = '',
  anchor: 'middle' | 'start' = 'middle',
): string {
  const top = cy - ((lines.length - 1) * LINE) / 2 + 4;
  return `<text${cls ? ` class="${cls}"` : ''} x="${f1(x)}" y="${f1(top)}" text-anchor="${anchor}">${lines
    .map((l, k) => `<tspan x="${f1(x)}"${k ? ` dy="${LINE}"` : ''}>${ctx.escape(l)}</tspan>`)
    .join('')}</text>`;
}

/** 상자 중심에서 (tx, ty) 쪽으로 그은 선이 상자 테두리와 만나는 점 */
function edgePoint(b: Box, tx: number, ty: number): [number, number] {
  const dx = tx - b.x;
  const dy = ty - b.y;
  if (dx === 0 && dy === 0) return [b.x, b.y];
  const sx = dx === 0 ? Infinity : b.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : b.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return [b.x + dx * s, b.y + dy * s];
}

function head(tx: number, ty: number, fx: number, fy: number, cls: string): string {
  const len = Math.hypot(tx - fx, ty - fy) || 1;
  const ux = (tx - fx) / len;
  const uy = (ty - fy) / len;
  const bx = tx - ux * 7;
  const by = ty - uy * 7;
  return `<polygon class="${cls}" points="${f1(tx)},${f1(ty)} ${f1(bx - uy * 4)},${f1(by + ux * 4)} ${f1(bx + uy * 4)},${f1(by - ux * 4)}"/>`;
}

interface Edge {
  d: string;
  head: string;
  lx: number;
  ly: number;
}

/** 두 상자를 잇는 화살표. bend가 0이 아니면 진행 방향 왼쪽으로 휘는 곡선이다. 같은 상자면 오른쪽으로 도는 고리다 */
function connect(a: Box, b: Box, bend: number): Edge {
  if (a === b) {
    const right = a.x + a.w / 2;
    return {
      d: `M${f1(right)},${f1(a.y - 7)} C${f1(right + 30)},${f1(a.y - 24)} ${f1(right + 30)},${f1(a.y + 24)} ${f1(right)},${f1(a.y + 7)}`,
      head: head(right, a.y + 7, right + 12, a.y + 14, 'wg-head'),
      lx: right + 16,
      ly: a.y - 24,
    };
  }
  if (bend === 0) {
    const [x1, y1] = edgePoint(a, b.x, b.y);
    const [x2, y2] = edgePoint(b, a.x, a.y);
    return {
      d: `M${f1(x1)},${f1(y1)} L${f1(x2)},${f1(y2)}`,
      head: head(x2, y2, x1, y1, 'wg-head'),
      lx: (x1 + x2) / 2,
      ly: (y1 + y2) / 2 - 4,
    };
  }
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const cx = (a.x + b.x) / 2 + ((b.y - a.y) / len) * bend;
  const cy = (a.y + b.y) / 2 - ((b.x - a.x) / len) * bend;
  const [x1, y1] = edgePoint(a, cx, cy);
  const [x2, y2] = edgePoint(b, cx, cy);
  return {
    d: `M${f1(x1)},${f1(y1)} Q${f1(cx)},${f1(cy)} ${f1(x2)},${f1(y2)}`,
    head: head(x2, y2, cx, cy, 'wg-head'),
    lx: 0.25 * x1 + 0.5 * cx + 0.25 * x2,
    ly: 0.25 * y1 + 0.5 * cy + 0.25 * y2,
  };
}

/** 화살표 라벨 글자 폭. 상자보다 조금 넓게 두 줄까지 쓰고 넘치면 줄임표로 끝낸다 */
const ARROW_LABEL_MAX = 12;
const ARROW_LABEL_LINES = 2;

const edgeLabel = (e: Edge, text: string | undefined, ctx: LensHtmlContext) =>
  text
    ? textLines(wrapLabel(text, ARROW_LABEL_MAX, ARROW_LABEL_LINES), e.lx, e.ly - 4, ctx, 'wg-elabel')
    : '';

const svgOpen = (w: number, h: number, title: string, ctx: LensHtmlContext) =>
  `<div class="w-scroll"><svg class="wg-svg" viewBox="0 0 ${f1(w)} ${f1(h)}" width="${f1(w)}" role="img" aria-label="${ctx.escape(title)}">`;

/** 끝점 하나라도 안 보이는 화살표는 같이 숨긴다. 점선으로 남는 끝점에 닿은 화살표도 점선이다 */
function arrowLook(
  own: ElementLook | undefined,
  a: ElementLook | undefined,
  b: ElementLook | undefined,
): ElementLook {
  if (own === 'hidden' || a === 'hidden' || b === 'hidden') return 'hidden';
  if (own === 'gone' || a === 'gone' || b === 'gone') return 'gone';
  return own ?? 'shown';
}

// ── stateMachine ──

/** 시작 상태에서 너비 우선으로 층을 나눈다. 닿지 않는 상태는 그 아래 층부터 다시 나눈다. pos 힌트가 있으면 따른다 */
function stateLayout(w: StateMachine): Map<string, { row: number; col: number }> {
  const depth = new Map<string, number>();
  const next = new Map<string, string[]>();
  for (const t of w.transitions) next.set(t.from, [...(next.get(t.from) ?? []), t.to]);
  const start = w.states.find((s) => s.initial) ?? w.states[0]!;
  let base = 0;
  for (const seed of [start, ...w.states]) {
    if (depth.has(seed.id)) continue;
    const queue = [seed.id];
    depth.set(seed.id, base);
    while (queue.length) {
      const id = queue.shift()!;
      for (const to of next.get(id) ?? []) {
        if (depth.has(to) || !w.states.some((s) => s.id === to)) continue;
        depth.set(to, depth.get(id)! + 1);
        queue.push(to);
      }
    }
    base = Math.max(...depth.values()) + 1;
  }
  const pos = new Map<string, { row: number; col: number }>();
  const rows = new Map<number, string[]>();
  const perRow = new Map<number, number>();
  for (const s of w.states) {
    const row = s.pos?.row ?? depth.get(s.id)!;
    perRow.set(row, (perRow.get(row) ?? 0) + 1);
    if (s.pos) pos.set(s.id, s.pos);
    else rows.set(row, [...(rows.get(row) ?? []), s.id]);
  }
  const hintedCols = w.states.flatMap((s) => (s.pos ? [s.pos.col + 1] : []));
  // 자리 힌트가 있는 상태까지 층마다 세어야 빈 칸이 늘 남는다
  const ncols = Math.max(1, ...hintedCols, ...perRow.values());
  for (const [row, ids] of rows) {
    const taken = new Set(
      [...pos.entries()].filter(([, p]) => p.row === row).map(([, p]) => p.col),
    );
    let col = Math.floor((ncols - ids.length) / 2);
    for (const id of ids) {
      for (let tries = 0; tries < ncols && taken.has(col % ncols); tries++) col++;
      pos.set(id, { row, col: col % ncols });
      taken.add(col % ncols);
      col++;
    }
  }
  return pos;
}

function stateSvg(w: StateMachine, looks: Map<string, ElementLook>, ctx: LensHtmlContext): string {
  const pos = stateLayout(w);
  const ncols = Math.max(...[...pos.values()].map((p) => p.col)) + 1;
  const nrows = Math.max(...[...pos.values()].map((p) => p.row)) + 1;
  // 자기 고리가 오른쪽으로 30px 나가서 칸 사이를 넉넉히 둔다
  const colW = Math.max(164, Math.min(190, 680 / ncols));
  const rowH = 92;
  // 같은 칸에서 층을 건너뛰는 곡선과 그 라벨이 양옆으로 나간다
  const pad = 36;
  const W = ncols * colW + 2 * pad;
  const top = 44;
  const H = top + (nrows - 1) * rowH + 50;
  const boxes = new Map<string, Box>();
  const wrapped = new Map<string, string[]>();
  for (const s of w.states) {
    const p = pos.get(s.id)!;
    const lines = wrapLabel(named(s.label, s.illustrative));
    wrapped.set(s.id, lines);
    boxes.set(s.id, {
      x: pad + (p.col + 0.5) * colW,
      y: top + p.row * rowH,
      w: BOX_W,
      h: lines.length * LINE + 14,
    });
  }
  const pairs = new Set(w.transitions.map((t) => `${t.from}>${t.to}`));
  const edges = w.transitions
    .map((t) => {
      const a = boxes.get(t.from);
      const b = boxes.get(t.to);
      if (!a || !b) return '';
      const pa = pos.get(t.from)!;
      const pb = pos.get(t.to)!;
      const opposite = pairs.has(`${t.to}>${t.from}`) && t.from !== t.to;
      const skip = Math.abs(pb.row - pa.row);
      const back = pb.row < pa.row || (pb.row === pa.row && pb.col < pa.col);
      // 같은 칸에서 층을 건너뛰는 화살표는 곡선 꼭대기가 상자 밖으로 나가게 크게 휘어 가운데 상자를 비켜 간다
      // (이차 곡선 꼭대기는 bend의 절반이다). 서로 오가는 짝과 거슬러 올라가는 화살표는 작게 휘고 나머지는 곧게 긋는다
      const bend =
        a === b
          ? 0
          : skip > 1 && pa.col === pb.col
            ? 2 * (BOX_W / 2 + 16)
            : opposite
              ? 18
              : back
                ? 40
                : 0;
      const e = connect(a, b, bend);
      const look = arrowLook(looks.get(t.id), looks.get(t.from), looks.get(t.to));
      const ill = t.illustrative ? ' w-ill' : '';
      return `<g class="wg-edge${ill}${lookClass(look)}"><path d="${e.d}"/>${e.head}${edgeLabel(e, t.label && named(t.label, t.illustrative), ctx)}</g>`;
    })
    .join('');
  const nodes = w.states
    .map((s) => {
      const b = boxes.get(s.id)!;
      const x0 = b.x - b.w / 2;
      const y0 = b.y - b.h / 2;
      const final = s.final
        ? `<rect class="wg-final" x="${f1(x0 + 3)}" y="${f1(y0 + 3)}" width="${f1(b.w - 6)}" height="${f1(b.h - 6)}" rx="6"/>`
        : '';
      const initial = s.initial
        ? `<circle class="wg-start" cx="${f1(x0 - 16)}" cy="${f1(b.y)}" r="5"/><line class="wg-line" x1="${f1(x0 - 11)}" y1="${f1(b.y)}" x2="${f1(x0 - 1)}" y2="${f1(b.y)}"/>${head(x0, b.y, x0 - 11, b.y, 'wg-head')}`
        : '';
      return `<g class="wg-node${s.illustrative ? ' w-ill' : ''}${lookClass(looks.get(s.id))}">${initial}<rect x="${f1(x0)}" y="${f1(y0)}" width="${b.w}" height="${f1(b.h)}" rx="8"/>${final}${textLines(wrapped.get(s.id)!, b.x, b.y, ctx)}</g>`;
    })
    .join('');
  return `${svgOpen(W, H, w.title, ctx)}${edges}${nodes}</svg></div>`;
}

// ── sequence ──

function sequenceSvg(w: Sequence, looks: Map<string, ElementLook>, ctx: LensHtmlContext): string {
  const n = w.actors.length;
  const colW = Math.max(132, Math.min(170, 680 / n));
  const col = new Map(w.actors.map((a, k) => [a.id, (k + 0.5) * colW]));
  const heads = w.actors.map((a) => wrapLabel(named(a.label, a.illustrative)));
  const headH = Math.max(...heads.map((l) => l.length)) * LINE + 12;
  const texts = w.messages.map((m, k) =>
    wrapLabel(`${k + 1}. ${named(m.label, m.illustrative)}`, ARROW_LABEL_MAX, ARROW_LABEL_LINES),
  );
  const extra = (Math.max(1, ...texts.map((l) => l.length)) - 1) * LINE;
  const rowH = 36 + extra;
  const top = 8 + headH + 22 + extra;
  const H = top + (w.messages.length - 1) * rowH + 30;
  // 자기 자신에게 보내는 메시지 라벨은 고리 오른쪽에 붙어서 마지막 참여자 밖으로 나간다
  const selfLast = w.messages.some((m) => m.from === m.to && m.from === w.actors[n - 1]?.id);
  const W = n * colW + (selfLast ? ARROW_LABEL_MAX * 12 - colW / 2 + 40 : 0);
  const actors = w.actors
    .map((a, k) => {
      const x = col.get(a.id)!;
      return `<g class="wg-actor${a.illustrative ? ' w-ill' : ''}${lookClass(looks.get(a.id))}"><rect x="${f1(x - BOX_W / 2)}" y="8" width="${BOX_W}" height="${f1(headH)}" rx="6"/>${textLines(heads[k]!, x, 8 + headH / 2, ctx)}<line class="wg-life" x1="${f1(x)}" y1="${f1(8 + headH)}" x2="${f1(x)}" y2="${f1(H - 8)}"/></g>`;
    })
    .join('');
  const messages = w.messages
    .map((m, k) => {
      const x1 = col.get(m.from);
      const x2 = col.get(m.to);
      if (x1 === undefined || x2 === undefined) return '';
      const y = top + k * rowH;
      const look = arrowLook(looks.get(m.id), looks.get(m.from), looks.get(m.to));
      const cls = `wg-msg${m.reply ? ' wg-reply' : ''}${m.illustrative ? ' w-ill' : ''}${lookClass(look)}`;
      const lines = texts[k]!;
      if (x1 === x2) {
        const d = `M${f1(x1)},${f1(y - 6)} h28 v14 h-26`;
        return `<g class="${cls}"><path d="${d}"/>${head(x1 + 1, y + 8, x1 + 10, y + 8, 'wg-head')}${textLines(lines, x1 + 34, y, ctx, 'wg-elabel', 'start')}</g>`;
      }
      const dir = x2 > x1 ? 1 : -1;
      const end = x2 - dir;
      // 라벨 마지막 줄이 화살표 바로 위에 오게 줄 수만큼 올린다
      const cy = y - 10 - ((lines.length - 1) * LINE) / 2;
      return `<g class="${cls}"><line x1="${f1(x1)}" y1="${f1(y)}" x2="${f1(end)}" y2="${f1(y)}"/>${head(end, y, x1, y, 'wg-head')}${textLines(lines, (x1 + x2) / 2, cy, ctx, 'wg-elabel')}</g>`;
    })
    .join('');
  return `${svgOpen(W, H, w.title, ctx)}${actors}${messages}</svg></div>`;
}

// ── swimlane ──

function swimlaneSvg(w: Swimlane, looks: Map<string, ElementLook>, ctx: LensHtmlContext): string {
  const LABEL_W = 78;
  const colW = 136;
  const ncols = Math.max(...w.activities.map((a) => a.col)) + 1;
  const W = LABEL_W + ncols * colW;
  const wrapped = new Map(
    w.activities.map((a) => [a.id, wrapLabel(named(a.label, a.illustrative))]),
  );
  const laneTop = new Map<string, number>();
  const laneH = new Map<string, number>();
  let y = 4;
  for (const lane of w.lanes) {
    const lines = Math.max(
      1,
      ...w.activities.filter((a) => a.lane === lane.id).map((a) => wrapped.get(a.id)!.length),
    );
    laneTop.set(lane.id, y);
    laneH.set(lane.id, lines * LINE + 40);
    y += lines * LINE + 40;
  }
  const H = y + 4;
  const boxes = new Map<string, Box>();
  for (const a of w.activities) {
    const t = laneTop.get(a.lane);
    if (t === undefined) continue;
    boxes.set(a.id, {
      x: LABEL_W + (a.col + 0.5) * colW,
      y: t + laneH.get(a.lane)! / 2,
      w: BOX_W,
      h: wrapped.get(a.id)!.length * LINE + 14,
    });
  }
  const lanes = w.lanes
    .map((lane, k) => {
      const t = laneTop.get(lane.id)!;
      const h = laneH.get(lane.id)!;
      return `<g class="wsw-lane wsw-${k % 2 ? 'odd' : 'even'}"><rect x="0" y="${f1(t)}" width="${f1(W)}" height="${f1(h)}"/>${textLines(wrapLabel(lane.label, 6), LABEL_W / 2, t + h / 2, ctx, 'wsw-name')}</g>`;
    })
    .join('');
  const byId = new Map(w.activities.map((a) => [a.id, a]));
  const arrows = (w.arrows ?? [])
    .map((ar) => {
      const a = boxes.get(ar.from);
      const b = boxes.get(ar.to);
      const fa = byId.get(ar.from);
      const fb = byId.get(ar.to);
      if (!a || !b || !fa || !fb) return '';
      const back = fb.col < fa.col || (fb.col === fa.col && fb.lane === fa.lane);
      const far = fa.lane === fb.lane && Math.abs(fb.col - fa.col) > 1;
      const e = connect(a, b, back ? 34 : far ? 26 : 0);
      const look = arrowLook(
        ar.id ? looks.get(ar.id) : undefined,
        looks.get(ar.from),
        looks.get(ar.to),
      );
      return `<g class="wg-edge${back ? ' wg-back' : ''}${lookClass(look)}"><path d="${e.d}"/>${e.head}${edgeLabel(e, ar.label, ctx)}</g>`;
    })
    .join('');
  const nodes = w.activities
    .map((a) => {
      const b = boxes.get(a.id);
      if (!b) return '';
      return `<g class="wg-node${a.illustrative ? ' w-ill' : ''}${lookClass(looks.get(a.id))}"><rect x="${f1(b.x - b.w / 2)}" y="${f1(b.y - b.h / 2)}" width="${b.w}" height="${f1(b.h)}" rx="6"/>${textLines(wrapped.get(a.id)!, b.x, b.y, ctx)}</g>`;
    })
    .join('');
  return `${svgOpen(W, H, w.title, ctx)}${lanes}${arrows}${nodes}</svg></div>`;
}

export function graphWidgetHtml(w: GraphWidget, ctx: LensHtmlContext): string {
  const ids = stepElementIds(w);
  const text = srText(graphWidgetMarkdown(w), ctx);
  if (w.kind === 'stateMachine') {
    return framed(ids, w.steps, (looks) => stateSvg(w, looks, ctx), ctx) + text;
  }
  if (w.kind === 'sequence') {
    return framed(ids, sequenceSteps(w), (looks) => sequenceSvg(w, looks, ctx), ctx) + text;
  }
  return framed(ids, w.steps, (looks) => swimlaneSvg(w, looks, ctx), ctx) + text;
}

export function graphWidgetMarkdown(w: GraphWidget): string[] {
  const out: string[] = [];
  if (w.kind === 'stateMachine') {
    const label = new Map(w.states.map((s) => [s.id, s.label]));
    const marks = (s: StateMachine['states'][number]) =>
      [s.initial ? '시작' : '', s.final ? '끝' : ''].filter(Boolean).join(', ');
    out.push(
      `상태: ${w.states
        .map((s) => {
          const m = marks(s);
          return `${named(s.label, s.illustrative)}${m ? `(${m})` : ''}`;
        })
        .join(', ')}`,
      '',
    );
    for (const t of w.transitions) {
      out.push(
        `- ${label.get(t.from) ?? t.from} → ${label.get(t.to) ?? t.to}${t.label ? `: ${named(t.label, t.illustrative)}` : ''}`,
      );
    }
    out.push(...stepsMarkdown(w.steps));
  } else if (w.kind === 'sequence') {
    const label = new Map(w.actors.map((a) => [a.id, a.label]));
    w.messages.forEach((m, k) =>
      out.push(
        `${k + 1}. ${label.get(m.from) ?? m.from} → ${label.get(m.to) ?? m.to}: ${named(m.label, m.illustrative)}${m.reply ? ' (응답)' : ''}`,
      ),
    );
    out.push(...stepsMarkdown(w.steps));
  } else {
    const label = new Map(w.activities.map((a) => [a.id, a.label]));
    for (const lane of w.lanes) {
      const acts = w.activities
        .filter((a) => a.lane === lane.id)
        .sort((a, b) => a.col - b.col)
        .map((a) => named(a.label, a.illustrative));
      out.push(`- ${lane.label}: ${acts.join(' → ') || '없음'}`);
    }
    if (w.arrows?.length) {
      out.push('', '화살표:');
      for (const ar of w.arrows) {
        out.push(
          `- ${label.get(ar.from) ?? ar.from} → ${label.get(ar.to) ?? ar.to}${ar.label ? `: ${ar.label}` : ''}`,
        );
      }
    }
    out.push(...stepsMarkdown(w.steps));
  }
  return out;
}

export const GRAPH_WIDGET_CSS = `
.wg-svg{display:block;height:auto;max-width:none}
.wg-svg text{fill:var(--fg);font-size:11px}
.wg-node rect,.wg-actor rect{fill:var(--card);stroke:var(--accent);stroke-width:1.5}
.wg-node.w-focus rect,.wg-actor.w-focus rect{fill:color-mix(in srgb, var(--accent) 18%, var(--card));stroke-width:2.5}
.wg-node.w-ill rect,.wg-actor.w-ill rect{stroke-dasharray:4 3;stroke:var(--muted)}
.wg-node.w-gone rect,.wg-actor.w-gone rect{stroke-dasharray:3 3}
.wg-final{fill:none;stroke:var(--accent);stroke-width:1}
.wg-start{fill:var(--fg)}
.wg-line{stroke:var(--muted);stroke-width:1.5}
.wg-edge path,.wg-msg line,.wg-msg path{fill:none;stroke:var(--muted);stroke-width:1.5}
.wg-head{fill:var(--muted)}
.wg-edge.w-focus path,.wg-msg.w-focus line,.wg-msg.w-focus path{stroke:var(--accent);stroke-width:2.5}
.wg-edge.w-focus .wg-head,.wg-msg.w-focus .wg-head{fill:var(--accent)}
.wg-edge.w-ill path,.wg-msg.w-ill line,.wg-msg.w-ill path,.wg-reply line,.wg-reply path,.wg-edge.w-gone path,.wg-msg.w-gone line{stroke-dasharray:4 3}
.wg-back path{stroke:var(--warn)}.wg-back .wg-head{fill:var(--warn)}
.wg-svg .wg-elabel{font-size:10.5px;stroke:var(--card);stroke-width:3px;paint-order:stroke;stroke-linejoin:round}
.wg-life{stroke:var(--line);stroke-width:1;stroke-dasharray:4 4}
.wsw-lane rect{stroke:var(--line);stroke-width:1}
.wsw-even rect{fill:color-mix(in srgb, var(--accent) 5%, transparent)}
.wsw-odd rect{fill:transparent}
.wg-svg .wsw-name{font-weight:600;font-size:11px}
`;
