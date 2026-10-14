import { CANVAS_PAD_TOP, CANVAS_PAD_X, LANE_INSET_Y, routeCanvas } from './canvas-geometry.js';
import type { RoutedCanvas } from './canvas-geometry.js';
import {
  DELTA_CHANGES,
  type ArchitectureDelta,
  type DeltaChange,
  type DeltaScope,
} from './delta.js';
import { THEME_BOOT_SCRIPT } from './html-client.js';
import { escapeHtml, viewTitle } from './html-renderer.js';
import { renderTokenCss } from './html-theme.js';
import { NODE_KIND_SHORT } from './kind-text.js';
import {
  computeGraphLayout,
  environmentRank,
  FLAT_BACKWARD_EDGE_KINDS,
  laneOfNode,
  NODE_TEXT_LEFT,
  PARTITION_RANK,
  textUnits,
  type GraphLayoutEdge,
  type GraphLayoutNode,
  type LayoutResult,
} from './layout.js';
import type { ArchitectureEdge, ArchitectureNode } from './types.js';
import { chipTextOverride, displayKindOf } from './types.js';

type Panel = 'before' | 'after';

/** 합집합 위의 선 하나. 끝점이 같으면 두 패널이 같은 경로를 쓴다. 다시 이은 선은 패널마다 따로 둔다 */
interface DeltaRoute {
  key: string;
  edgeId: string;
  panel: Panel | 'both';
  edge: ArchitectureEdge;
  changes: DeltaChange[];
}

export interface DeltaLayout {
  layout: LayoutResult;
  canvas: RoutedCanvas;
  routes: DeltaRoute[];
}

const EDGE_WIDTH = 1.5;
const ADDED_EDGE_WIDTH = 2.5;
const DASHED = '6 4';
const DOTTED = '1.5 4';
const BADGE_H = 18;
const BADGE_CHAR = 6.5;
const BADGE_PAD = 8;
const BADGE_GAP = 4;
const MARK_R = 8;
const CHIP_CHAR = 6.5;
const CHIP_GAP = 8;
const LEDGER_W = 320;
// 패널을 이보다 좁히면 카드 글자가 10px 아래로 내려가 읽히지 않는다. 그 밑은 가로 스크롤로 넘긴다
const MIN_SCALE = 0.75;
// 칸 사이 틈과 좌우 여백. 창이 세 칸 최소 폭보다 좁을 때만 옆으로 밀라는 안내가 보인다
const PAGE_CHROME = 80;

const BADGE_TEXT: Record<DeltaChange, string> = {
  ADDED: '+ 생김',
  REMOVED: '− 빠짐',
  CHANGED: 'Δ 변경',
  MOVED: '→ 이동',
  REWIRED: '↻ 다시 이음',
};

const MARK_TEXT: Record<DeltaChange, string> = {
  ADDED: '+',
  REMOVED: '−',
  CHANGED: 'Δ',
  MOVED: '→',
  REWIRED: '↻',
};

const COUNT_WORD: Record<DeltaChange, string> = {
  ADDED: '생김',
  REMOVED: '빠짐',
  CHANGED: '변경',
  MOVED: '이동',
  REWIRED: '다시 이음',
};

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

function nameOf(node: ArchitectureNode): string {
  return node.displayName ?? node.label;
}

function routesOf(delta: ArchitectureDelta, scope: DeltaScope): DeltaRoute[] {
  const out: DeltaRoute[] = [];
  for (const e of delta.edges) {
    if (!scope.edgeIds.has(e.id)) continue;
    const { before: b, after: a, changes } = e;
    if (b !== undefined && a !== undefined && b.from === a.from && b.to === a.to) {
      out.push({ key: e.id, edgeId: e.id, panel: 'both', edge: a, changes });
      continue;
    }
    if (b !== undefined)
      out.push({ key: `before:${b.id}`, edgeId: e.id, panel: 'before', edge: b, changes });
    if (a !== undefined)
      out.push({ key: `after:${a.id}`, edgeId: e.id, panel: 'after', edge: a, changes });
  }
  return out;
}

/**
 * 두 패널이 같이 쓰는 좌표. 합집합에 배치를 한 번만 돌린다.
 * 패널마다 따로 돌리면 바뀌지 않은 노드까지 자리가 흔들려 없는 이동이 생긴 것처럼 읽힌다
 */
export async function computeDeltaLayout(
  delta: ArchitectureDelta,
  scope: DeltaScope,
): Promise<DeltaLayout> {
  const nodes: GraphLayoutNode[] = delta.nodes
    .filter((n) => scope.nodeIds.has(n.id))
    .map((n) => {
      const node = (n.after ?? n.before)!;
      // 표시 이름이 바뀐 카드는 두 이름 중 긴 쪽으로 재야 두 패널의 카드 크기가 같다
      const names = [n.before, n.after].flatMap((x) => (x ? [nameOf(x)] : []));
      const longest = names.reduce((a, b) => (textUnits(b) > textUnits(a) ? b : a));
      return {
        id: n.id,
        label: node.label,
        ...(longest !== node.label ? { displayName: longest } : {}),
        rank: PARTITION_RANK[node.kind],
        lane: laneOfNode(node),
        kind: displayKindOf(node),
        ...(chipTextOverride(node) !== undefined ? { chip: chipTextOverride(node)! } : {}),
        ...(node.environment !== undefined ? { order: environmentRank(node.environment) } : {}),
        secondLine: n.id,
      };
    });
  const routes = routesOf(delta, scope);
  const edges: GraphLayoutEdge[] = routes.map((r) => ({
    id: r.key,
    from: r.edge.from,
    to: r.edge.to,
    ...(FLAT_BACKWARD_EDGE_KINDS.has(r.edge.kind) ? { backward: true } : {}),
  }));
  const layout = await computeGraphLayout(nodes, edges);
  const canvas = routeCanvas(
    layout,
    routes.map((r) => ({
      id: r.key,
      from: r.edge.from,
      to: r.edge.to,
      width: r.changes.includes('ADDED') ? ADDED_EDGE_WIDTH : EDGE_WIDTH,
      ...(FLAT_BACKWARD_EDGE_KINDS.has(r.edge.kind) ? { backward: true } : {}),
    })),
  );
  return { layout, canvas, routes };
}

export interface RenderDeltaOptions {
  audience: 'private' | 'shared';
}

/** 이전 | 변경 목록 | 이번 세 칸. 정적 페이지라 스크립트는 테마 고정 한 줄뿐이다 */
export function renderDeltaHtml(
  delta: ArchitectureDelta,
  scope: DeltaScope,
  laid: DeltaLayout,
  opts: RenderDeltaOptions,
): string {
  const title = `${viewTitle(delta.after.ir)} 구조 변경`;
  const { canvas } = laid;
  const minW = Math.ceil(canvas.width * MIN_SCALE);
  const counts = DELTA_CHANGES.map((c) => [c, delta.ledger.filter((e) => e.change === c).length])
    .filter(([, n]) => (n as number) > 0)
    .map(([c, n]) => `${COUNT_WORD[c as DeltaChange]} ${n}`)
    .join(', ');
  const scopeNote = scope.scoped
    ? `<p class="dl-note">전체 구성 요소 ${scope.total.components}개 가운데 바뀐 것과 바로 이웃한 ${scope.nodeIds.size}개만 그렸어요.</p>`
    : '';
  return [
    '<!doctype html>',
    '<html lang="ko">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<script>${THEME_BOOT_SCRIPT}</script>`,
    `<style>${renderTokenCss()}\n${DELTA_CSS}\n@media (min-width: ${2 * minW + LEDGER_W + PAGE_CHROME}px) { .dl-hint { display: none; } }</style>`,
    '</head>',
    `<body data-audience="${opts.audience}">`,
    '<header class="dl-head">',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="dl-sum">${escapeHtml(counts)}</p>`,
    scopeNote,
    renderLegend(),
    '</header>',
    `<div class="dl-scroll" role="region" aria-label="구조 변경 비교" tabindex="0">`,
    `<div class="dl-grid" style="grid-template-columns:minmax(${minW}px,${canvas.width}px) ${LEDGER_W}px minmax(${minW}px,${canvas.width}px)">`,
    renderPanel(delta, laid, 'before'),
    renderLedger(delta),
    renderPanel(delta, laid, 'after'),
    '</div>',
    '</div>',
    '<p class="dl-hint">화면이 좁으면 비교 칸을 옆으로 밀어 보세요.</p>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function renderLegend(): string {
  const item = (cls: string, text: string, about: string): string =>
    `<li><span class="dl-badge ${cls}">${escapeHtml(text)}</span>${escapeHtml(about)}</li>`;
  return (
    '<ul class="dl-legend" aria-label="읽는 법">' +
    item('b-added', BADGE_TEXT.ADDED, '이번에만 있음, 굵은 테두리') +
    item('b-removed', BADGE_TEXT.REMOVED, '이전에만 있음, 점 테두리') +
    item('b-changed', BADGE_TEXT.CHANGED, '속성이 바뀜, 왼쪽 굵은 줄') +
    item('b-moved', BADGE_TEXT.MOVED, '부모나 계정, 구간이 바뀜') +
    item('b-rewired', BADGE_TEXT.REWIRED, '연결 끝이 바뀜') +
    '<li><svg width="28" height="8" aria-hidden="true"><path d="M1 4H27" class="dl-edge" stroke-dasharray="6 4"/></svg>문서로만 확인한 연결</li>' +
    '</ul>'
  );
}

function panelDate(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

function renderPanel(delta: ArchitectureDelta, laid: DeltaLayout, panel: Panel): string {
  const { layout, canvas, routes } = laid;
  const snap = panel === 'before' ? delta.before : delta.after;
  const label = panel === 'before' ? '이전' : '이번';
  const boxes = new Map(layout.nodes.map((n) => [n.id, n]));
  const lanes = layout.lanes
    .map(
      (l) =>
        `<rect class="dl-lane" x="${r2(l.x + CANVAS_PAD_X)}" y="${LANE_INSET_Y}" width="${l.width}" height="${r2(canvas.height - LANE_INSET_Y * 2)}" rx="14"/>` +
        `<text class="dl-lane-t" x="${r2(l.x + CANVAS_PAD_X + l.width / 2)}" y="${LANE_INSET_Y + 24}">${escapeHtml(l.title)}</text>`,
    )
    .join('');
  const links = routes
    .filter((r) => r.panel === 'both' || r.panel === panel)
    .map((r) => {
      const route = canvas.edges.get(r.key);
      if (route === undefined) return '';
      const shown = r.changes;
      const removed = shown.includes('REMOVED');
      const added = shown.includes('ADDED');
      const dash = removed
        ? ` stroke-dasharray="${DOTTED}"`
        : r.edge.lineStyle === 'dashed'
          ? ` stroke-dasharray="${DASHED}"`
          : '';
      const cls = ['dl-edge', ...shown.map((c) => `c-${c.toLowerCase()}`)].join(' ');
      const width = added ? ADDED_EDGE_WIDTH : EDGE_WIDTH;
      const mark =
        shown.length > 0
          ? `<g class="dl-mark"><circle cx="${route.mid.x}" cy="${route.mid.y}" r="${MARK_R}"/>` +
            `<text x="${route.mid.x}" y="${r2(route.mid.y + 4)}">${shown.map((c) => MARK_TEXT[c]).join('')}</text></g>`
          : '';
      return (
        `<g class="dl-link" data-object-id="${escapeHtml(r.edgeId)}" data-status="${escapeHtml(shown.map((c) => c.toLowerCase()).join(' ') || 'unchanged')}" ` +
        `data-from="${escapeHtml(r.edge.from)}" data-to="${escapeHtml(r.edge.to)}">` +
        `<path class="${cls}" d="${route.d}" stroke-width="${width}"${dash}/><path class="dl-tip${removed ? ' c-removed' : ''}" d="${route.tip}"/>${mark}</g>`
      );
    })
    .join('');
  const cards = delta.nodes
    .map((n) => {
      const node = panel === 'before' ? n.before : n.after;
      const box = boxes.get(n.id);
      if (node === undefined || box === undefined) return '';
      return renderCard(node, box, n.changes, panel);
    })
    .join('');
  return (
    `<section class="dl-panel" data-snapshot="${panel}" aria-label="${label} 구조">` +
    `<h2>${label}<span>${escapeHtml(panelDate(snap.ir.generatedAt))}</span></h2>` +
    `<svg class="dl-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas.width} ${canvas.height}" role="img" aria-label="${label} 구조도">` +
    `<g>${lanes}</g><g>${links}</g><g>${cards}</g></svg></section>`
  );
}

function renderCard(
  node: ArchitectureNode,
  box: { x: number; y: number; width: number; height: number },
  changes: readonly DeltaChange[],
  panel: Panel,
): string {
  const x = r2(box.x + CANVAS_PAD_X);
  const y = r2(box.y + CANVAS_PAD_TOP);
  const { width: w, height: h } = box;
  const dk = displayKindOf(node);
  const chip = chipTextOverride(node) ?? NODE_KIND_SHORT[dk];
  // 이 카드에는 칩 아이콘이 없다. 레이아웃이 아이콘 몫까지 잰 폭은 이름 뒤 여백으로 남긴다
  const nameX = r2(x + NODE_TEXT_LEFT + textUnits(chip) * CHIP_CHAR + CHIP_GAP);
  const status = changes.length === 0 ? 'unchanged' : changes.map((c) => c.toLowerCase()).join(' ');
  const cls = ['dl-card', ...changes.map((c) => `c-${c.toLowerCase()}`)].join(' ');
  const inset = changes.includes('CHANGED')
    ? `<rect class="dl-inset" x="${x}" y="${y}" width="5" height="${h}" rx="2"/>`
    : '';
  let bx = x + w - BADGE_PAD;
  const badges = changes
    .filter((c) =>
      c === 'ADDED' ? panel === 'after' : c === 'REMOVED' ? panel === 'before' : true,
    )
    .slice()
    .reverse()
    .map((c) => {
      const bw = Math.ceil(textUnits(BADGE_TEXT[c]) * BADGE_CHAR + 12);
      bx -= bw;
      const out =
        `<g class="dl-badge-g b-${c.toLowerCase()}"><rect x="${r2(bx)}" y="${r2(y - BADGE_H / 2)}" width="${bw}" height="${BADGE_H}" rx="9"/>` +
        `<text x="${r2(bx + bw / 2)}" y="${r2(y + 4)}">${escapeHtml(BADGE_TEXT[c])}</text></g>`;
      bx -= BADGE_GAP;
      return out;
    })
    .join('');
  const name = nameOf(node);
  return (
    `<g class="dl-node" data-object-id="${escapeHtml(node.id)}" data-status="${escapeHtml(status)}">` +
    `<title>${escapeHtml(`${name} (${node.id})`)}</title>` +
    `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>${inset}` +
    `<text class="dl-chip" x="${r2(x + NODE_TEXT_LEFT)}" y="${r2(y + 25)}">${escapeHtml(chip)}</text>` +
    `<text class="dl-name" x="${nameX}" y="${r2(y + 25)}">${escapeHtml(name)}</text>` +
    `<text class="dl-id" x="${r2(x + NODE_TEXT_LEFT)}" y="${r2(y + 45)}">${escapeHtml(node.id)}</text>` +
    `${badges}</g>`
  );
}

function renderLedger(delta: ArchitectureDelta): string {
  const items = delta.ledger
    .map(
      (e) =>
        `<li data-change="${e.change}" data-target="${escapeHtml(e.target)}">` +
        `<span class="dl-word">${e.change}</span> <code>${escapeHtml(e.target)}</code>` +
        `<p>${escapeHtml(e.text)}</p></li>`,
    )
    .join('');
  return (
    '<section class="dl-ledger" aria-label="변경 목록">' +
    `<h2>변경 목록<span>${delta.ledger.length}건</span></h2>` +
    (items !== ''
      ? `<ol>${items}</ol>`
      : '<p class="dl-empty">이 사본에서 보이는 변경은 없어요.</p>') +
    '</section>'
  );
}

const DELTA_CSS = `* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 var(--font); -webkit-font-smoothing: antialiased; }
.dl-head { padding: 20px 24px 8px; }
.dl-head h1 { margin: 0; font-size: 18px; font-weight: 700; }
.dl-sum { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.dl-note { margin: 4px 0 0; color: var(--warn); font-size: 13px; }
.dl-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 12px 0 0; padding: 0; list-style: none; font-size: 12px; color: var(--muted); }
.dl-legend li { display: inline-flex; align-items: center; gap: 6px; }
.dl-badge { display: inline-block; padding: 0 7px; border-radius: 9px; font-size: 11px; line-height: 18px; color: var(--text); background: var(--surface); border: 1px solid var(--border-strong); }
.dl-badge.b-removed { border-style: dashed; }
.dl-scroll { overflow-x: auto; padding: 8px 24px 16px; }
.dl-scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.dl-grid { display: grid; gap: 16px; align-items: start; }
.dl-panel, .dl-ledger { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; min-width: 0; }
.dl-panel h2, .dl-ledger h2 { display: flex; align-items: baseline; gap: 8px; margin: 0; padding: 12px 16px; font-size: 14px; font-weight: 700; border-bottom: 1px solid var(--border); }
.dl-panel h2 span, .dl-ledger h2 span { font-size: 12px; font-weight: 400; color: var(--muted); }
.dl-svg { display: block; width: 100%; height: auto; }
.dl-lane { fill: var(--lane); stroke: var(--lane-line); stroke-width: 1; }
.dl-lane-t { fill: var(--muted); font-size: 12px; font-weight: 600; text-anchor: middle; }
.dl-edge { fill: none; stroke: var(--edge); stroke-linecap: round; }
.dl-edge.c-added { stroke: var(--edge-strong); }
.dl-edge.c-removed { opacity: 0.8; }
.dl-tip { fill: var(--edge); stroke: none; }
.dl-tip.c-removed { opacity: 0.8; }
.dl-mark circle { fill: var(--surface); stroke: var(--edge-strong); stroke-width: 1.25; }
.dl-mark text { fill: var(--text); font-size: 11px; font-weight: 700; text-anchor: middle; }
.dl-card { fill: var(--surface); stroke: var(--border-strong); stroke-width: 1; }
.dl-card.c-added { stroke: var(--edge-strong); stroke-width: 2.5; }
.dl-card.c-removed { fill: var(--surface-2); stroke: var(--edge-strong); stroke-width: 1.5; stroke-dasharray: 2 4; stroke-linecap: round; }
.dl-inset { fill: var(--edge-strong); }
.dl-chip { fill: var(--muted); font-size: 10.5px; font-weight: 600; }
.dl-name { fill: var(--text); font-size: 13px; font-weight: 650; }
.dl-id { fill: var(--muted); font: 11px var(--mono); }
.dl-badge-g rect { fill: var(--surface); stroke: var(--edge-strong); stroke-width: 1; }
.dl-badge-g.b-removed rect { stroke-dasharray: 3 2; }
.dl-badge-g text { fill: var(--text); font-size: 10.5px; font-weight: 650; text-anchor: middle; }
.dl-ledger ol { margin: 0; padding: 4px 0; list-style: none; }
.dl-ledger li { padding: 10px 16px; border-bottom: 1px solid var(--border); }
.dl-ledger li:last-child { border-bottom: 0; }
.dl-word { font-weight: 800; font-size: 12px; letter-spacing: 0.04em; color: var(--accent); }
.dl-ledger code { font: 12px var(--mono); color: var(--text); word-break: break-all; }
.dl-ledger p { margin: 4px 0 0; font-size: 13px; color: var(--text); overflow-wrap: anywhere; }
.dl-empty { margin: 0; padding: 12px 16px; font-size: 13px; color: var(--muted); }
.dl-hint { margin: 0 24px 16px; font-size: 12px; color: var(--muted); }`;
