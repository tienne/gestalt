import { CANVAS_PAD_TOP, CANVAS_PAD_X, LANE_INSET_Y, routeCanvas } from './canvas-geometry.js';
import type { RoutedEdge } from './canvas-geometry.js';
import { ROOT_LEVEL_ID, type DrillEdge, type Drilldown } from './drilldown.js';
import { renderClientScript, THEME_BOOT_SCRIPT } from './html-client.js';
import { iconUse, renderCss, renderIconSprite } from './html-theme.js';
import { LANE_TITLES, NODE_KIND_SHORT, PLATFORM_CHIP_TEXT, PLATFORM_NAME } from './kind-text.js';
import { FLAT_BACKWARD_EDGE_KINDS, type LayoutResult } from './layout.js';
import { computeServiceFacts, type ServiceFacts } from './service-facts.js';
import type {
  ArchitectureEdge,
  ArchitectureIr,
  ArchitectureNode,
  EdgeKind,
  Evidence,
  NodeKind,
  UnresolvedQuestion,
} from './types.js';
import { maskSharedText, redactForSharing, type ValidatedIr } from './validator.js';

export type ArchitectureAudience = 'private' | 'shared';

export interface RenderArchitectureHtmlOptions {
  audience: ArchitectureAudience;
}

const DASHED_PATTERN = '6 4';
const INFERRED_BADGE = '추정';
const EMPTY_LEVEL_SIZE = { width: 560, height: 240 };

const VIEW_TITLES: Record<ArchitectureIr['view'], string> = {
  'screen-chain': '화면별 호출 흐름',
  'deploy-path': '배포 경로',
};

// 페이지에 보이는 글자는 IR 식별자 대신 읽는 사람 말로 바꿔 보여준다
const NODE_KIND_TEXT: Record<NodeKind, string> = {
  service: '서비스',
  feature: '기능 영역',
  screen: '화면',
  gateway: '게이트웨이',
  endpoint: 'API',
  app_module: '서버',
  external_service: '호출 클라이언트',
  db_table: '테이블',
  workflow: '워크플로',
  build: '빌드',
  artifact: '산출물',
  deploy_target: '배포 대상',
  domain: '도메인',
  cdn: 'CDN 배포',
  bucket: '스토리지 버킷',
  cloud_account: '클라우드 계정',
};
const EDGE_KIND_TEXT: Record<EdgeKind | 'contains', string> = {
  calls: '호출',
  handles: '처리',
  uses: '사용',
  reads_writes: '읽기와 쓰기',
  routes: '전달',
  navigates: '화면 이동',
  triggers: '실행',
  builds: '빌드',
  produces: '생성',
  deploys_to: '배포',
  resolves_to: '도메인 연결',
  origin: '원본',
  serves: '서빙',
  contains: '포함',
};
const EVIDENCE_TYPE_TEXT: Record<Evidence['type'], string> = {
  code: '코드',
  spec: '스펙',
  doc: '문서',
  user: '사용자 확인',
  live: '실제 조회',
};

const HINT_DRILL =
  '항목을 누르면 출처가 보여요. 더블클릭하거나 상세보기를 누르면 한 단계 안으로 들어가고 뒤로가기로 돌아와요. 전체 화면에서 Shift나 ⌘를 누른 채 두 항목을 고르면 그 사이 경로를 보여줘요.';
const HINT_FLAT =
  '항목을 누르면 출처가 보여요. 끌어서 옮기고 ⌘나 Ctrl을 누른 채 휠을 굴리면 크게 볼 수 있어요.';

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return compareStr(a.id, b.id);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 객체 키를 코드 유닛 순으로 정렬해 직렬화한다. undefined 값은 JSON.stringify처럼 빠진다 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort(compareStr)) {
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}

// script 블록 안에서 HTML 파서가 끝 태그나 주석 시작으로 읽을 수 있는 조각만 JSON 이스케이프로 바꾼다
function embedJson(json: string): string {
  return json.replace(/<\//g, '<\\/').replace(/<!--/g, '\\u003c!--');
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ir은 공유본이면 이미 가린 사본이다. 자동 질문은 검증기가 원본 이름으로 지었으므로 여기서 한 번 더 가린다
function openQuestions(
  ir: ArchitectureIr,
  validated: ValidatedIr,
  shared: boolean,
): UnresolvedQuestion[] {
  const fromIr = ir.unresolved.filter((q) => q.answer === undefined || q.answer === '');
  const auto = shared
    ? validated.autoUnresolved.map((q) => ({ ...q, question: maskSharedText(q.question) }))
    : validated.autoUnresolved;
  return [...fromIr, ...auto].sort(byId);
}

// 페이지가 실제로 쓰는 필드만 싣는다. repo root 같은 로컬 경로와 sourcesUsed 식별자가 공유본으로 새지 않게 한다
function buildPayload(ir: ArchitectureIr, validated: ValidatedIr, shared: boolean) {
  const nodes = ir.nodes.filter((n) => validated.drawableNodeIds.has(n.id)).sort(byId);
  const edges = ir.edges.filter((e) => validated.drawableEdgeIds.has(e.id)).sort(byId);
  const services = Object.fromEntries(computeServiceFacts(nodes, edges));
  return {
    schemaVersion: ir.schemaVersion,
    view: ir.view,
    generatedAt: ir.generatedAt,
    repos: ir.repos.map((r) => ({ id: r.id, name: r.name })).sort(byId),
    nodes,
    edges,
    services,
    unresolved: openQuestions(ir, validated, shared),
  };
}

/** 양 끝 노드가 서로 다른 계정에 속하면 계정을 넘는 선이다. 한쪽이라도 계정을 모르면 넘는다고 하지 않는다 */
function crossesAccount(
  nodeById: Map<string, ArchitectureNode>,
  edge: Pick<CanvasEdge, 'from' | 'to'>,
): boolean {
  const a = nodeById.get(edge.from)?.account;
  const b = nodeById.get(edge.to)?.account;
  return a !== undefined && b !== undefined && a !== b;
}

function nodeName(node: Pick<ArchitectureNode, 'label' | 'displayName'>): string {
  return node.displayName ?? node.label;
}

function isGuess(node: ArchitectureNode): boolean {
  return node.displayName !== undefined && node.displayNameInferred === true;
}

/** 묶음 선 굵기. 건수의 제곱근을 따라야 수백 건짜리 선이 화면을 덮지 않는다 */
function edgeWidth(count: number): number {
  return round2(Math.min(8, Math.max(1.5, 1.5 + (Math.sqrt(Math.max(count, 1)) - 1) * 1.1)));
}

/** 레벨에 그리는 선. 평면 그림의 IR 엣지도 건수 1짜리로 맞춰 같은 함수로 그린다 */
type CanvasEdge = Pick<DrillEdge, 'id' | 'from' | 'to' | 'count' | 'lineStyle' | 'kind'> & {
  backward?: boolean;
};

function asCanvasEdge(edge: ArchitectureEdge): CanvasEdge {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    count: 1,
    lineStyle: edge.lineStyle,
    ...(FLAT_BACKWARD_EDGE_KINDS.has(edge.kind) ? { backward: true } : {}),
  };
}

function platformChips(facts: ServiceFacts | undefined): string {
  if (!facts) return '';
  return facts.platforms
    .map(
      (p) =>
        `<span class="pf pf-${p}" role="img" aria-label="${PLATFORM_NAME[p]}" title="${PLATFORM_NAME[p]}">` +
        `${iconUse(`p-${p}`)}${PLATFORM_CHIP_TEXT[p]}</span>`,
    )
    .join('');
}

function renderCard(
  node: ArchitectureNode,
  box: LayoutResult['nodes'][number],
  enterable: boolean,
  focus: boolean,
  facts: ServiceFacts | undefined,
): string {
  const name = nodeName(node);
  const guess = isGuess(node);
  const platforms = facts?.platforms.map((p) => PLATFORM_NAME[p]) ?? [];
  const cls = ['node', `k-${node.kind}`];
  if (enterable) cls.push('enterable');
  if (focus) cls.push('is-focus');
  const aria =
    `${name}, ${NODE_KIND_TEXT[node.kind]}${guess ? `, ${INFERRED_BADGE} 이름` : ''}` +
    (platforms.length > 0 ? `, ${platforms.join(', ')}` : '');
  const tooltip =
    (node.displayName === undefined
      ? node.label
      : `${node.displayName}${guess ? ` (${INFERRED_BADGE})` : ''}\n${node.label}`) +
    (facts?.prodDomain !== undefined ? `\n${facts.prodDomain}` : '');
  const second =
    facts?.prodDomain !== undefined
      ? `<span class="tc dom">${escapeHtml(facts.prodDomain)}</span>`
      : node.displayName !== undefined
        ? `<span class="tc">${escapeHtml(node.label)}</span>`
        : '';
  const x = round2(box.x + CANVAS_PAD_X);
  const y = round2(box.y + CANVAS_PAD_TOP);
  return (
    `<div class="${cls.join(' ')}" data-node-id="${escapeHtml(node.id)}" role="button" tabindex="0" ` +
    `aria-label="${escapeHtml(aria)}" title="${escapeHtml(tooltip)}" ` +
    `style="left:${x}px;top:${y}px;width:${box.width}px;height:${box.height}px">` +
    `<span class="kc">${iconUse(`i-${node.kind}`)}${escapeHtml(NODE_KIND_SHORT[node.kind])}</span>` +
    `<span class="nm"><span class="t">${escapeHtml(name)}</span>${guess ? `<span class="guess">${INFERRED_BADGE}</span>` : ''}${platformChips(facts)}</span>` +
    second +
    (enterable ? '<span class="go" aria-hidden="true">›</span>' : '') +
    `</div>`
  );
}

function renderPill(count: number, at: { x: number; y: number }): string {
  const text = String(count);
  const w = 14 + text.length * 7;
  return (
    `<g class="pill" transform="translate(${at.x},${at.y})">` +
    `<rect x="${round2(-w / 2)}" y="-9" width="${w}" height="18" rx="9"/><text>${text}</text></g>`
  );
}

function renderLink(
  edge: CanvasEdge,
  route: RoutedEdge,
  labelOf: (id: string) => string,
  crossAccount: boolean,
): string {
  const width = edgeWidth(edge.count);
  const dash = edge.lineStyle === 'dashed' ? ` stroke-dasharray="${DASHED_PATTERN}"` : '';
  const ends = `data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}"`;
  const xa = crossAccount ? ' x-account' : '';
  const xaText = crossAccount ? ' (계정을 넘는 연결)' : '';
  const hit = `<path class="hit" d="${route.d}" stroke-width="${Math.max(12, width + 8)}"/>`;
  const tip = `<path class="tip" d="${route.tip}"/>`;
  if (edge.kind === 'bundle') {
    const name = `${labelOf(edge.from)} → ${labelOf(edge.to)} ${edge.count}개${xaText}`;
    return (
      `<g class="link bundle${xa}" data-bundle-id="${escapeHtml(edge.id)}" ${ends} tabindex="0" role="button" aria-label="${escapeHtml(name)}">` +
      `<title>${escapeHtml(name)}</title>${hit}` +
      `<path class="edge" d="${route.d}" stroke-width="${width}"${dash}/>${tip}` +
      `${renderPill(edge.count, route.mid)}</g>`
    );
  }
  const name = `${EDGE_KIND_TEXT[edge.kind]}: ${labelOf(edge.from)} → ${labelOf(edge.to)}${xaText}`;
  return (
    `<g class="link e-${edge.kind}${xa}" ${ends}><title>${escapeHtml(name)}</title>${hit}` +
    `<path class="edge" data-edge-id="${escapeHtml(edge.id)}" d="${route.d}" stroke-width="${width}"${dash}/>${tip}</g>`
  );
}

interface CanvasSpec {
  levelId: string;
  svgId: string;
  title: string;
  nodes: ArchitectureNode[];
  edges: CanvasEdge[];
  layout: LayoutResult;
  enter: Record<string, string>;
  focusId?: string;
  hidden: boolean;
  services: Record<string, ServiceFacts>;
}

/** 레벨 하나. 레인 띠와 선은 SVG, 카드는 그 위에 겹친 HTML이다. 좌표는 전부 서버가 박는다 */
function renderLevelSection(spec: CanvasSpec): string {
  const open = `<section class="level" data-level-id="${escapeHtml(spec.levelId)}" aria-label="${escapeHtml(spec.title)}"`;
  const hidden = spec.hidden ? ' hidden' : '';
  if (spec.nodes.length === 0) {
    const { width, height } = EMPTY_LEVEL_SIZE;
    return (
      `${open} data-w="${width}" data-h="${height}" style="width:${width}px;height:${height}px"${hidden}>` +
      `<p class="empty-state">여기는 보여줄 항목이 없어요.</p></section>`
    );
  }
  const nodeById = new Map(spec.nodes.map((n) => [n.id, n]));
  const labelOf = (id: string): string => {
    const node = nodeById.get(id);
    return node ? nodeName(node) : id;
  };
  const layout: LayoutResult = {
    ...spec.layout,
    nodes: [...spec.layout.nodes].sort(byId),
    edges: [...spec.layout.edges].sort(byId),
  };
  const edges = [...spec.edges].sort(byId);
  const canvas = routeCanvas(
    layout,
    edges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      width: edgeWidth(e.count),
      ...(e.backward ? { backward: true } : {}),
    })),
  );
  const { width, height } = canvas;
  const laneRects = layout.lanes
    .map(
      (l) =>
        `<rect class="lane" x="${round2(l.x + CANVAS_PAD_X)}" y="${LANE_INSET_Y}" width="${l.width}" ` +
        `height="${round2(height - LANE_INSET_Y * 2)}" rx="14"/>`,
    )
    .join('');
  const laneTitles = layout.lanes
    .map(
      (l) =>
        `<div class="lane-title" style="left:${round2(l.x + CANVAS_PAD_X)}px;top:${LANE_INSET_Y + 10}px;width:${l.width}px">` +
        `${escapeHtml(LANE_TITLES[l.id])}<span class="n">${l.count}</span></div>`,
    )
    .join('');
  const links = edges
    .map((e) => {
      const route = canvas.edges.get(e.id);
      return route ? renderLink(e, route, labelOf, crossesAccount(nodeById, e)) : '';
    })
    .join('');
  const boxes = new Map(layout.nodes.map((n) => [n.id, n]));
  const cards = spec.nodes
    .map((n) => {
      const box = boxes.get(n.id);
      if (!box) return '';
      const target = spec.enter[n.id];
      return renderCard(
        n,
        box,
        target !== undefined && target !== spec.levelId,
        n.id === spec.focusId,
        spec.services[n.id],
      );
    })
    .join('');
  return (
    `${open} data-w="${width}" data-h="${height}" style="width:${width}px;height:${height}px"${hidden}>` +
    `<svg class="links" id="${spec.svgId}" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="group" aria-label="${escapeHtml(`${spec.title} 연결`)}">` +
    `<g class="lanes">${laneRects}</g><g class="edges">${links}</g></svg>` +
    `${laneTitles}${cards}</section>`
  );
}

function renderLegend(
  nodes: ArchitectureNode[],
  edges: ArchitectureEdge[],
  drill: boolean,
  generatedAt: string,
  nodeCount: number,
  edgeCount: number,
): string {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const line = (extra: string): string =>
    `<svg width="36" height="12" aria-hidden="true"><line x1="3" y1="6" x2="33" y2="6" ${extra}/></svg>`;
  const kinds = [...new Set(nodes.map((n) => n.kind))]
    .sort(compareStr)
    .map(
      (k) =>
        `<li><span class="swatch k-${k}">${iconUse(`i-${k}`)}</span><span class="kc k-${k}">${escapeHtml(NODE_KIND_SHORT[k])}</span>${escapeHtml(NODE_KIND_TEXT[k])}</li>`,
    )
    .join('');
  return (
    `<div id="legend" class="pop" role="dialog" aria-label="범례" tabindex="-1" hidden>` +
    `<h3>선</h3><ul class="legend-lines">` +
    `<li>${line('stroke-width="2"')}실선: 코드나 스펙으로 확인한 연결</li>` +
    `<li>${line(`stroke-width="2" stroke-dasharray="${DASHED_PATTERN}"`)}점선: 문서나 사람 말, 실제 조회로만 확인한 연결</li>` +
    (edges.some((e) => crossesAccount(nodeById, e))
      ? `<li>${line('stroke-width="2" class="x-account-line"')}색 선: 클라우드 계정을 넘는 연결</li>`
      : '') +
    (drill
      ? `<li>${line('stroke-width="6"')}굵은 선: 여러 연결을 묶은 선이에요. 올리면 묶인 수가 보여요</li>`
      : '') +
    `</ul>` +
    (kinds ? `<h3>항목</h3><ul class="legend-kinds">${kinds}</ul>` : '') +
    `<p class="foot">만든 시각 ${escapeHtml(generatedAt)}<br>항목 ${nodeCount}개, 연결 ${edgeCount}개</p></div>`
  );
}

function renderQuestions(
  questions: UnresolvedQuestion[],
  nodeById: Map<string, ArchitectureNode>,
  allEdges: ArchitectureEdge[],
): string {
  const edgeById = new Map(allEdges.map((e) => [e.id, e]));
  const nameOr = (id: string): string => {
    const node = nodeById.get(id);
    return node ? nodeName(node) : id;
  };
  const items = questions
    .map((q) => {
      let subject: string | undefined;
      let target: string | undefined;
      const { nodeId, edgeId } = q.subject;
      if (nodeId !== undefined) {
        subject = nameOr(nodeId);
        if (nodeById.has(nodeId)) target = nodeId;
      } else if (edgeId !== undefined) {
        const edge = edgeById.get(edgeId);
        if (edge) {
          subject = `${nameOr(edge.from)} → ${nameOr(edge.to)}`;
          target = nodeById.has(edge.from)
            ? edge.from
            : nodeById.has(edge.to)
              ? edge.to
              : undefined;
        } else {
          subject = edgeId;
        }
      }
      const attr = target !== undefined ? ` data-node-id="${escapeHtml(target)}"` : ' disabled';
      return (
        `<li><button type="button" class="q"${attr}>` +
        (subject !== undefined ? `<span class="q-subj">${escapeHtml(subject)}</span>` : '') +
        `<span class="q-text">${escapeHtml(q.question)}</span></button></li>`
      );
    })
    .join('');
  const body =
    questions.length > 0
      ? `<ul class="q-list">${items}</ul>`
      : '<p class="empty">지금은 확인할 질문이 없어요.</p>';
  return (
    `<div id="questions" class="pop" role="dialog" aria-label="확인할 질문" tabindex="-1" hidden>` +
    `<h3>확인할 질문 ${questions.length}개</h3>${body}</div>`
  );
}

function renderBar(
  title: string,
  drill: boolean,
  generatedAt: string,
  nodeCount: number,
  edgeCount: number,
  questionCount: number,
): string {
  const qClass = questionCount > 0 ? 'n warn' : 'n';
  return (
    `<header class="bar">` +
    `<h1>${escapeHtml(title)}</h1>` +
    `<nav id="crumbs" class="crumbs" aria-label="위치"${drill ? '' : ' hidden'}><span class="here" aria-current="page">전체</span></nav>` +
    `<span id="focus-chip" class="focus-chip" hidden>${iconUse('u-focus')}<span>포커스:</span><b id="focus-name"></b>` +
    `<button type="button" id="focus-clear" aria-label="포커스 해제" title="포커스 해제 (Esc)">${iconUse('u-close')}</button></span>` +
    `<div class="spacer"></div>` +
    `<button type="button" class="btn" id="focus-btn" hidden title="고른 항목과 이어진 것만 보기 (F)">${iconUse('u-focus')}<span class="label">포커스</span></button>` +
    `<label class="search">${iconUse('u-search')}<input id="search" type="search" placeholder="이름으로 찾기" aria-label="이름으로 찾기" autocomplete="off" spellcheck="false"><span id="search-count" class="count" aria-live="polite"></span></label>` +
    `<div class="seg" role="group" aria-label="크기">` +
    `<button type="button" class="btn icon" id="zoom-out" aria-label="작게 보기" title="작게 보기 (-)">${iconUse('u-minus')}</button>` +
    `<span id="zoom-level" class="zoom-level" aria-live="polite">100%</span>` +
    `<button type="button" class="btn icon" id="zoom-in" aria-label="크게 보기" title="크게 보기 (+)">${iconUse('u-plus')}</button></div>` +
    `<button type="button" class="btn" id="zoom-fit" title="화면에 맞추기 (0)">${iconUse('u-fit')}<span class="label">맞춤</span></button>` +
    `<button type="button" class="btn" id="legend-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="legend">${iconUse('u-legend')}<span class="label">범례</span></button>` +
    `<button type="button" class="btn" id="q-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="questions">${iconUse('u-question')}<span class="label">확인할 질문</span><span class="${qClass}">${questionCount}</span></button>` +
    `<button type="button" class="btn icon" id="theme-btn" aria-label="테마 바꾸기">${iconUse('u-moon', 'moon')}${iconUse('u-sun', 'sun')}</button>` +
    `<span class="meta" title="만든 시각 ${escapeHtml(generatedAt)}"><span>항목 ${nodeCount}</span><span>연결 ${edgeCount}</span></span>` +
    `</header>`
  );
}

const CLIENT_SCRIPT = renderClientScript({
  kindShort: NODE_KIND_SHORT,
  kindText: { ...NODE_KIND_TEXT, ...EDGE_KIND_TEXT },
  evidenceText: EVIDENCE_TYPE_TEXT,
  laneTitles: LANE_TITLES,
  inferredBadge: INFERRED_BADGE,
  platformChip: PLATFORM_CHIP_TEXT,
  platformName: PLATFORM_NAME,
  backwardKinds: [...FLAT_BACKWARD_EDGE_KINDS].sort(compareStr),
});

interface PageSpec {
  ir: ArchitectureIr;
  payload: ReturnType<typeof buildPayload> & Record<string, unknown>;
  sections: string;
  drill: boolean;
}

function renderPage({ ir, payload, sections, drill }: PageSpec): string {
  const title = VIEW_TITLES[ir.view];
  const nodeById = new Map(payload.nodes.map((n) => [n.id, n]));
  return [
    '<!doctype html>',
    '<html lang="ko">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<script>${THEME_BOOT_SCRIPT}</script>`,
    `<style>${renderCss()}</style>`,
    '</head>',
    '<body>',
    renderIconSprite(),
    renderBar(
      title,
      drill,
      ir.generatedAt,
      payload.nodes.length,
      payload.edges.length,
      payload.unresolved.length,
    ),
    '<div class="main">',
    '<div id="stage" class="stage" aria-label="구조도">',
    '<div id="viewport" class="viewport">',
    sections,
    '<section id="pair" class="level pair" aria-live="polite" hidden></section>',
    '<section id="focus" class="level focus-view" aria-live="polite" hidden></section>',
    '</div>',
    '</div>',
    `<p id="hint" class="hint"><span>${drill ? HINT_DRILL : HINT_FLAT}</span>` +
      `<button type="button" id="hint-close" aria-label="안내 닫기">${iconUse('u-close')}</button></p>`,
    '<details id="sheet" class="sheet" hidden><summary id="sheet-title">세부 연결</summary><div id="sheet-body" class="scroll"></div></details>',
    '<aside id="drawer" class="drawer" role="dialog" aria-modal="false" aria-labelledby="drawer-title" aria-hidden="true" inert>' +
      `<button type="button" id="drawer-close" class="btn icon dr-close" aria-label="닫기">${iconUse('u-close')}</button>` +
      '<div id="panel" class="panel" aria-live="polite"></div></aside>',
    '</div>',
    renderLegend(
      payload.nodes,
      payload.edges,
      drill,
      ir.generatedAt,
      payload.nodes.length,
      payload.edges.length,
    ),
    renderQuestions(payload.unresolved, nodeById, ir.edges),
    `<script id="ir" type="application/json">${embedJson(stableStringify(payload))}</script>`,
    `<script>${CLIENT_SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * 검증된 IR과 서버 레이아웃으로 외부 의존 없는 단일 HTML을 만든다.
 * 같은 입력이면 같은 바이트가 나온다. shared면 private 근거를 가린 사본으로 그린다.
 */
export function renderArchitectureHtml(
  validated: ValidatedIr,
  layout: LayoutResult,
  opts: RenderArchitectureHtmlOptions,
): string {
  const shared = opts.audience === 'shared';
  const ir = shared ? redactForSharing(validated.ir) : validated.ir;
  const payload = buildPayload(ir, validated, shared);
  const section = renderLevelSection({
    levelId: ROOT_LEVEL_ID,
    svgId: 'canvas',
    title: VIEW_TITLES[ir.view],
    nodes: payload.nodes,
    edges: payload.edges.map(asCanvasEdge),
    layout,
    enter: {},
    hidden: false,
    services: payload.services,
  });
  return renderPage({ ir, payload, sections: section, drill: false });
}

/**
 * 드릴다운 HTML. 레벨마다 미리 그린 캔버스를 한 파일에 넣고 하나만 보이게 한다.
 * 같은 입력이면 같은 바이트가 나온다. shared면 private 근거를 가린 사본으로 그린다.
 */
export function renderDrilldownHtml(
  validated: ValidatedIr,
  drilldown: Drilldown,
  opts: RenderArchitectureHtmlOptions,
): string {
  const shared = opts.audience === 'shared';
  const ir = shared ? redactForSharing(validated.ir) : validated.ir;
  const base = buildPayload(ir, validated, shared);
  const nodeById = new Map(base.nodes.map((n) => [n.id, n]));
  // 레벨 제목은 원본 이름으로 지었으므로 공유본에서는 노드 이름과 같이 가린다
  const levels = drilldown.levels.map((l) =>
    shared ? { ...l, title: maskSharedText(l.title) } : l,
  );
  const payload = {
    ...base,
    levels: levels.map((l) => ({
      id: l.id,
      kind: l.kind,
      ...(l.focusId !== undefined ? { focusId: l.focusId } : {}),
      title: l.title,
      trail: l.trail,
      edges: l.edges,
    })),
    enter: drilldown.enter,
  };
  const sections = levels
    .map((l, i) =>
      renderLevelSection({
        levelId: l.id,
        svgId: `canvas-${i}`,
        title: l.title,
        nodes: l.nodeIds.map((id) => nodeById.get(id)).filter((n): n is ArchitectureNode => !!n),
        edges: l.edges,
        layout: l.layout,
        enter: drilldown.enter,
        ...(l.focusId !== undefined ? { focusId: l.focusId } : {}),
        hidden: l.id !== ROOT_LEVEL_ID,
        services: base.services,
      }),
    )
    .join('\n');
  return renderPage({ ir, payload, sections, drill: true });
}
