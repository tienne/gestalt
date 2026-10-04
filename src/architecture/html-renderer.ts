import {
  BAND_LINE_X,
  BAND_LINE_Y,
  BAND_TITLE_HALF,
  BAND_TITLE_X,
  CANVAS_PAD_TOP,
  CANVAS_PAD_X,
  LANE_INSET_Y,
  routeCanvas,
} from './canvas-geometry.js';
import type { RoutedEdge } from './canvas-geometry.js';
import { flowCountByService, ROOT_LEVEL_ID, type DrillEdge, type Drilldown } from './drilldown.js';
import type { FlowLevel } from './flow-layout.js';
import { renderClientScript, THEME_BOOT_SCRIPT } from './html-client.js';
import {
  datastoreEngine,
  iconUse,
  PRODUCT_COLORS,
  renderCss,
  renderIconSprite,
} from './html-theme.js';
import {
  LANE_TITLES,
  flowBadgeText,
  MICRO_HOST_SHORT,
  NODE_KIND_SHORT,
  PLATFORM_CHIP_TEXT,
  PLATFORM_NAME,
  WEB_HOSTING_CHIP_TEXT,
  WEB_HOSTING_NAME,
  platformChipText,
  platformName,
} from './kind-text.js';
import {
  compareEnvironment,
  FLAT_BACKWARD_EDGE_KINDS,
  textUnits,
  type LayoutResult,
} from './layout.js';
import { indexMicroApps } from './micro-app.js';
import { computeServiceFacts, type ServiceFacts } from './service-facts.js';
import type {
  ArchitectureEdge,
  ArchitectureFlow,
  ArchitectureIr,
  ArchitectureNode,
  EdgeKind,
  DisplayKind,
  Evidence,
  UnresolvedQuestion,
} from './types.js';
import { displayKindOf } from './types.js';
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

/** 하네스 레포는 화면이 없어 '화면별'이 틀린 말이 된다. 화면이 하나라도 있으면 웹 그림으로 친다 */
function viewTitle(ir: ArchitectureIr): string {
  if (ir.view !== 'screen-chain' || ir.nodes.some((n) => n.kind === 'screen')) {
    return VIEW_TITLES[ir.view];
  }
  if (ir.nodes.some((n) => n.kind === 'skill')) return '스킬별 호출 흐름';
  if (ir.nodes.some((n) => n.kind === 'endpoint' && n.protocol === 'mcp'))
    return 'MCP 도구 호출 흐름';
  return VIEW_TITLES[ir.view];
}

// 페이지에 보이는 글자는 IR 식별자 대신 읽는 사람 말로 바꿔 보여준다
const NODE_KIND_TEXT: Record<DisplayKind, string> = {
  service: '서비스',
  micro_app: '마이크로 프론트엔드 앱',
  feature: '기능 영역',
  screen: '화면',
  gateway: '게이트웨이',
  endpoint: 'API',
  app_module: '서버',
  external_service: '호출 클라이언트',
  db_table: '테이블',
  datastore: '저장소 클러스터',
  workflow: '워크플로',
  build: '빌드',
  artifact: '산출물',
  deploy_target: '배포 대상',
  domain: '도메인',
  cdn: 'CDN 배포',
  bucket: '스토리지 버킷',
  cloud_account: '클라우드 계정',
  client: 'AI 클라이언트',
  skill: '스킬',
  agent: '에이전트',
  mcp_tool: 'MCP 도구',
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
  loads: '런타임 로드',
  spawns: '에이전트 실행',
  invokes: '스킬 호출',
  contains: '포함',
};
const EVIDENCE_TYPE_TEXT: Record<Evidence['type'], string> = {
  code: '코드',
  spec: '스펙',
  doc: '문서',
  user: '사용자 확인',
  live: '실제 조회',
};

const FLOW_TEXT = {
  step: '흐름 단계',
  transition: '상태 전이',
  main: '정상 흐름',
  side: '옆 흐름',
  back: '앞 단계로 되돌아감',
  end: '흐름 끝',
  person: '사람',
  system: '시스템',
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
  const apps = indexMicroApps(nodes, edges);
  // 호스트 칩 글자를 클라이언트가 새로 그리는 카드에도 달아야 해서 싣는다. 앱이 없는 IR은 키 자체를 안 넣어 바이트가 그대로다
  const microHosts = [...apps.hosts].sort(compareStr);
  return {
    schemaVersion: ir.schemaVersion,
    view: ir.view,
    generatedAt: ir.generatedAt,
    repos: ir.repos.map((r) => ({ id: r.id, name: r.name })).sort(byId),
    nodes,
    edges,
    services,
    ...(microHosts.length > 0 ? { microHosts } : {}),
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
        `<span class="pf pf-${p}" role="img" aria-label="${platformName(p, facts.webHosting)}" title="${platformName(p, facts.webHosting)}">` +
        `${iconUse(`p-${p}`, p === 'web' ? '' : `brand b-${p}`)}${platformChipText(p, facts.webHosting)}</span>`,
    )
    .join('');
}

function renderCard(
  node: ArchitectureNode,
  box: LayoutResult['nodes'][number],
  enterable: boolean,
  focus: boolean,
  facts: ServiceFacts | undefined,
  band: number | undefined,
  micro: { host: boolean; frame?: string },
  flows = 0,
  products: readonly string[] = [],
  productIds: readonly number[] = [],
): string {
  const name = nodeName(node);
  const guess = isGuess(node);
  const platforms = facts?.platforms.map((p) => platformName(p, facts.webHosting)) ?? [];
  const dk = displayKindOf(node);
  const cls = ['node', `k-${dk}`];
  if (products.length > 1) cls.push('shared');
  if (enterable) cls.push('enterable');
  if (focus) cls.push('is-focus');
  const aria =
    `${name}, ${NODE_KIND_TEXT[dk]}${guess ? `, ${INFERRED_BADGE} 이름` : ''}` +
    (platforms.length > 0 ? `, ${platforms.join(', ')}` : '') +
    (flows > 0 ? `, 사용자 흐름 ${flows}개` : '') +
    (products.length > 1 ? `, 같이 쓰는 제품 ${products.join(', ')}` : '');
  const tooltip =
    (node.displayName === undefined
      ? node.label
      : `${node.displayName}${guess ? ` (${INFERRED_BADGE})` : ''}\n${node.label}`) +
    (facts?.prodDomain !== undefined ? `\n${facts.prodDomain}` : '');
  const subText =
    facts?.prodDomain !== undefined
      ? `<span class="tc dom">${escapeHtml(facts.prodDomain)}</span>`
      : node.displayName !== undefined
        ? `<span class="tc">${escapeHtml(node.label)}</span>`
        : '';
  const chips = platformChips(facts);
  const second = chips === '' ? subText : `<span class="l2">${subText}${chips}</span>`;
  const engine = datastoreEngine(node);
  const x = round2(box.x + CANVAS_PAD_X);
  const y = round2(box.y + CANVAS_PAD_TOP);
  return (
    `<div class="${cls.join(' ')}" data-node-id="${escapeHtml(node.id)}"${band !== undefined ? ` data-band="${band}"` : ''}` +
    `${productIds.length > 1 ? ` data-products="${productIds.join(' ')}"` : ''}` +
    `${node.environment !== undefined ? ` data-env="${escapeHtml(node.environment)}"` : ''}` +
    `${micro.frame !== undefined ? ` data-frame="${escapeHtml(micro.frame)}"` : ''} role="button" tabindex="0" ` +
    `aria-label="${escapeHtml(aria)}" title="${escapeHtml(tooltip)}" ` +
    `style="left:${x}px;top:${y}px;width:${box.width}px;height:${box.height}px">` +
    `<span class="kc">${engine !== undefined ? iconUse(`e-${engine}`, `brand b-${engine}`) : iconUse(`i-${dk}`)}${escapeHtml(micro.host ? MICRO_HOST_SHORT : NODE_KIND_SHORT[dk])}</span>` +
    `<span class="nm"><span class="t">${escapeHtml(name)}</span>${guess ? `<span class="guess">${INFERRED_BADGE}</span>` : ''}` +
    (flows > 0
      ? `<span class="flow-badge" title="사용자 흐름 보기">${iconUse('u-flow')}${escapeHtml(flowBadgeText(flows))}</span>`
      : '') +
    `</span>` +
    second +
    (enterable ? '<span class="go" aria-hidden="true">›</span>' : '') +
    (products.length > 1 ? renderProductBricks(products, productIds, box.width) : '') +
    `</div>`
  );
}

// 제품 브릭 폭 어림값. 카드 폭처럼 글자 수로 재야 서버 결과가 폰트에 안 흔들린다
const BRICK_PAD = 12;
const BRICK_UNIT = 5.6;
const BRICK_GAP = 2;
const BRICK_ROW_INSET = 16;
const BRICK_MORE = 30;

/**
 * 같이 쓰는 카드 위에 꽂는 제품 브릭 한 줄. 카드 폭에 들어가는 만큼만 꽂고 남은 수는 +N 버튼에 적는다.
 * +N을 누르면 스크립트가 그 카드를 같이 쓰는 제품 전부를 드롭다운으로 띄운다
 */
function renderProductBricks(
  names: readonly string[],
  ids: readonly number[],
  cardWidth: number,
): string {
  const room = cardWidth - BRICK_ROW_INSET;
  let used = 0;
  let shown = 0;
  for (let i = 0; i < names.length; i++) {
    const w = BRICK_PAD + textUnits(names[i]!) * BRICK_UNIT;
    const reserve = i < names.length - 1 ? BRICK_MORE : 0;
    if (used + w + reserve > room) break;
    used += w + BRICK_GAP;
    shown += 1;
  }
  const bricks = names
    .slice(0, shown)
    .map((n, i) => `<span class="pb p-${ids[i]! % PRODUCT_COLORS}">${escapeHtml(n)}</span>`)
    .join('');
  const rest = names.length - shown;
  const more =
    rest > 0
      ? `<button type="button" class="pb more" aria-haspopup="true" aria-expanded="false" ` +
        `aria-label="${escapeHtml(`같이 쓰는 제품 ${names.length}개 모두 보기`)}">+${rest}</button>`
      : '';
  return `<span class="pbricks" aria-hidden="${rest > 0 ? 'false' : 'true'}">${bricks}${more}</span>`;
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
  microHosts: ReadonlySet<string>;
  /** 서비스 id → 흐름 수. 드릴다운 그림에만 있다 */
  flows?: Record<string, number>;
}

function productNames(layout: LayoutResult, id: string): string[] {
  const regions = layout.regions;
  return (regions?.productsOf[id] ?? []).map((i) => regions!.groups[i]!.name);
}

/** 맨 위 같이 쓰는 띠와 제품마다 전용 띠. 띠마다 머리에 점선 구분선과 이름을 단다 */
function renderBands(
  layout: LayoutResult,
  width: number,
): { regionRects: string; regionTitles: string } {
  const regions = layout.regions;
  if (!regions) return { regionRects: '', regionTitles: '' };
  const lines = regions.bands.map((b) => {
    const y = round2(b.y + CANVAS_PAD_TOP + BAND_LINE_Y);
    return `<line class="band-line" x1="${BAND_LINE_X}" y1="${y}" x2="${round2(width - BAND_LINE_X)}" y2="${y}"/>`;
  });
  const titles = regions.bands.map((b) => {
    const top = round2(b.y + CANVAS_PAD_TOP + BAND_LINE_Y - BAND_TITLE_HALF);
    const name =
      b.band === 0
        ? '같이 쓰는 카드'
        : `<i class="sw p-${(b.band - 1) % PRODUCT_COLORS}"></i>${escapeHtml(regions.groups[b.band - 1]!.name)} 전용`;
    return `<div class="band-title" data-band="${b.band}" style="left:${BAND_TITLE_X}px;top:${top}px">${name}</div>`;
  });
  return { regionRects: lines.join(''), regionTitles: titles.join('') };
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
  const frameOf = new Map<string, string>();
  for (const f of layout.frames ?? []) frameOf.set(f.id, f.id);
  const frameRects = (layout.frames ?? [])
    .map(
      (f) =>
        `<rect class="frame" data-frame-id="${escapeHtml(f.id)}" x="${round2(f.x + CANVAS_PAD_X)}" y="${round2(f.y + CANVAS_PAD_TOP)}" ` +
        `width="${f.width}" height="${f.height}" rx="14"/>`,
    )
    .join('');
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
        `${escapeHtml(l.title)}<span class="n">${l.count}</span></div>`,
    )
    .join('');
  const { regionRects, regionTitles } = renderBands(layout, width);
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
        layout.regions?.bandOf[n.id],
        {
          host: n.kind === 'micro_app' && spec.microHosts.has(n.id),
          ...(frameOf.has(n.id) || frameOf.has(n.parent ?? '')
            ? { frame: frameOf.get(n.id) ?? frameOf.get(n.parent!)! }
            : {}),
        },
        spec.flows?.[n.id] ?? 0,
        productNames(layout, n.id),
        layout.regions?.productsOf[n.id] ?? [],
      );
    })
    .join('');
  // 포커스 화면이 띠 이름을 다시 달 때, +N 드롭다운이 제품 이름을 띄울 때 읽는다
  const regionNames = layout.regions
    ? ` data-regions="${escapeHtml(JSON.stringify(layout.regions.groups.map((r) => r.name)))}"`
    : '';
  return (
    `${open} data-w="${width}" data-h="${height}"${regionNames} style="width:${width}px;height:${height}px"${hidden}>` +
    `<svg class="links" id="${spec.svgId}" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="group" aria-label="${escapeHtml(`${spec.title} 연결`)}">` +
    `<g class="lanes">${laneRects}</g><g class="regions">${regionRects}</g>` +
    `${frameRects !== '' ? `<g class="frames">${frameRects}</g>` : ''}<g class="edges">${links}</g></svg>` +
    `${laneTitles}${regionTitles}${cards}</section>`
  );
}

const FLOW_PAD = 24;

function pathD(points: readonly { x: number; y: number }[]): string {
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${round2(p.x + FLOW_PAD)} ${round2(p.y + FLOW_PAD)}`)
    .join(' ');
}

const BACK_CORNER = 12;

/** 되돌아가는 선은 모서리를 둥글린다. 앞으로 가는 직각 선들 사이에서 뒤로 가는 선이 모양만으로 갈린다 */
function roundedPathD(points: readonly { x: number; y: number }[]): string {
  const at = (p: { x: number; y: number }): string =>
    `${round2(p.x + FLOW_PAD)} ${round2(p.y + FLOW_PAD)}`;
  let d = `M${at(points[0]!)}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i - 1]!;
    const c = points[i]!;
    const n = points[i + 1]!;
    const r = Math.min(
      BACK_CORNER,
      Math.hypot(c.x - p.x, c.y - p.y) / 2,
      Math.hypot(n.x - c.x, n.y - c.y) / 2,
    );
    const toward = (q: { x: number; y: number }) => {
      const len = Math.hypot(q.x - c.x, q.y - c.y) || 1;
      return { x: c.x + ((q.x - c.x) / len) * r, y: c.y + ((q.y - c.y) / len) * r };
    };
    d += ` L${at(toward(p))} Q${at(c)} ${at(toward(n))}`;
  }
  return `${d} L${at(points[points.length - 1]!)}`;
}

/**
 * 흐름 레벨 하나. 행위자마다 가로줄을 깔고 단계 카드를 왼쪽에서 오른쪽으로 놓는다.
 * 카드는 노드 카드와 같은 .node라 강조와 검색, 질문 이동을 그대로 탄다. data-node-id 자리에 단계 id가 들어간다
 */
function renderFlowSection(
  level: FlowLevel,
  flow: ArchitectureFlow,
  questionCount: ReadonlyMap<string, number>,
  drawableNodes: ReadonlySet<string>,
): string {
  const { layout } = level;
  const width = round2(layout.width + FLOW_PAD * 2);
  const height = round2(layout.height + FLOW_PAD * 2);
  const stepById = new Map(flow.steps.map((st) => [st.id, st]));
  const actorById = new Map(flow.actors.map((a) => [a.id, a]));
  const stateText = (state: string): string => flow.stateLabels?.[state] ?? state;
  // 이름이 붙은 상태는 코드 값이 아니라서 고정폭 글꼴을 안 쓴다
  const named = (state: string): string =>
    flow.stateLabels?.[state] !== undefined ? ' named' : '';
  const lanes = layout.lanes
    .map(
      (l, i) =>
        `<rect class="flane${i % 2 === 1 ? ' alt' : ''}" x="${FLOW_PAD}" y="${round2(l.y + FLOW_PAD)}" width="${layout.width}" height="${l.height}" rx="12"/>`,
    )
    .join('');
  // 구간 경계는 행위자 줄 위에 세로 점선으로 긋는다. 첫 구간 왼쪽은 머리 칸과 맞닿아 따로 안 긋는다
  const laneTop = layout.lanes[0]?.y ?? 0;
  const laneBottom = layout.lanes.reduce((n, l) => Math.max(n, l.y + l.height), 0);
  const dividers = layout.stages
    .slice(1)
    .map(
      (st) =>
        `<line class="fstage-line${st.side ? ' side' : ''}" x1="${round2(st.x + FLOW_PAD)}" x2="${round2(st.x + FLOW_PAD)}" ` +
        `y1="${round2(laneTop + FLOW_PAD)}" y2="${round2(laneBottom + FLOW_PAD)}"/>`,
    )
    .join('');
  const stageHeads = layout.stages
    .map(
      (st) =>
        `<div class="fstage${st.side ? ' side' : named(st.label)}" style="left:${round2(st.x + FLOW_PAD + 8)}px;top:${FLOW_PAD}px;width:${round2(st.width - 16)}px" ` +
        `title="${escapeHtml(st.side ? st.label : stateText(st.label))}"><span>${escapeHtml(st.side ? st.label : stateText(st.label))}</span></div>`,
    )
    .join('');
  const heads = layout.lanes
    .map(
      (l) =>
        `<div class="flane-title a-${l.actor.kind}" style="left:${FLOW_PAD + 12}px;top:${round2(l.y + FLOW_PAD + 12)}px">` +
        `${iconUse(l.actor.kind === 'person' ? 'u-person' : l.actor.kind === 'agent' ? 'i-agent' : 'u-system')}<span>${escapeHtml(l.actor.label)}</span></div>`,
    )
    .join('');
  const labelOf = (id: string): string => stepById.get(id)?.label ?? id;
  const links = layout.transitions
    .map((r) => {
      const t = flow.transitions.find((x) => x.id === r.id)!;
      const dash = t.lineStyle === 'dashed' ? ` stroke-dasharray="${DASHED_PATTERN}"` : '';
      const d = r.back ? roundedPathD(r.points) : pathD(r.points);
      const tip = r.tip.map((p) => `${round2(p.x + FLOW_PAD)},${round2(p.y + FLOW_PAD)}`).join(' ');
      const actorNames = (t.actors ?? []).map((id) => actorById.get(id)?.label ?? id);
      const who = actorNames.join(', ');
      // 선 위에는 괄호 앞 이름만 싣는다. "고객 (앱, QR, 알림톡 웹)"을 다 쓰면 선 글자가 카드 폭을 넘는다
      const whoShort = actorNames.map((n) => n.replace(/\s*\([^)]*\)\s*$/, '')).join(', ');
      const name =
        `${FLOW_TEXT[r.path]}${r.back ? `, ${FLOW_TEXT.back}` : ''}: ${labelOf(r.from)} → ${labelOf(r.to)}` +
        (t.label !== undefined ? ` (${t.label})` : '') +
        (who !== '' ? `, 누가 ${who}` : '');
      const text = r.labelAt
        ? `<text class="t-label" x="${round2(r.labelAt.x + FLOW_PAD)}" y="${round2(r.labelAt.y + FLOW_PAD - 5)}">` +
          (r.back ? '<tspan class="t-back">↩ </tspan>' : '') +
          (t.label !== undefined ? escapeHtml(t.label) : '') +
          (whoShort !== ''
            ? `<tspan class="t-who">${t.label !== undefined ? ' · ' : ''}${escapeHtml(whoShort)}</tspan>`
            : '') +
          `</text>`
        : '';
      return (
        `<g class="link flow-t p-${r.path}${r.back ? ' back' : ''}" data-from="${escapeHtml(r.from)}" data-to="${escapeHtml(r.to)}" ` +
        `data-transition-id="${escapeHtml(r.id)}" tabindex="0" role="button" aria-label="${escapeHtml(name)}">` +
        `<title>${escapeHtml(name)}</title><path class="hit" d="${d}" stroke-width="12"/>` +
        `<path class="edge" d="${d}" stroke-width="2"${dash}/><polygon class="tip" points="${tip}"/>${text}</g>`
      );
    })
    .join('');
  const cards = layout.steps
    .map((b) => {
      const st = stepById.get(b.id)!;
      const actor = actorById.get(st.actor);
      const refs = (st.refs ?? []).filter((id) => drawableNodes.has(id));
      const qs = questionCount.get(st.id) ?? 0;
      const dashed = st.evidence.every((ev) => ev.type !== 'code' && ev.type !== 'spec');
      const cls = ['node', 'flow-step', `p-${b.path}`];
      if (dashed) cls.push('doc-only');
      const aria =
        `${st.label}, ${FLOW_TEXT.step}, ${actor?.label ?? st.actor}` +
        (st.state !== undefined ? `, 상태 ${stateText(st.state)}` : '') +
        (st.terminal ? `, ${FLOW_TEXT.end}` : '') +
        (dashed ? ', 문서로만 확인' : '');
      return (
        `<div class="${cls.join(' ')}" data-node-id="${escapeHtml(st.id)}" role="button" tabindex="0" ` +
        `aria-label="${escapeHtml(aria)}" title="${escapeHtml(st.description ?? st.label)}" ` +
        `style="left:${round2(b.x + FLOW_PAD)}px;top:${round2(b.y + FLOW_PAD)}px;width:${b.width}px;height:${b.height}px">` +
        `<span class="nm"><span class="t">${escapeHtml(st.label)}</span></span>` +
        `<span class="l2">` +
        (st.state !== undefined
          ? `<span class="st${named(st.state)}" title="${escapeHtml(st.state)}">${escapeHtml(stateText(st.state))}</span>`
          : '') +
        (st.terminal ? `<span class="end" title="${FLOW_TEXT.end}">끝</span>` : '') +
        (refs.length > 0
          ? `<span class="refs" title="이어진 화면과 API">${iconUse('u-link')}${refs.length}</span>`
          : '') +
        (qs > 0
          ? `<span class="qb" title="확인할 질문">${iconUse('u-question')}${qs}</span>`
          : '') +
        `</span></div>`
      );
    })
    .join('');
  return (
    `<section class="level flow-level" data-level-id="${escapeHtml(level.id)}" data-flow-id="${escapeHtml(level.flowId)}" ` +
    `aria-label="${escapeHtml(flow.title)}" data-w="${width}" data-h="${height}" style="width:${width}px;height:${height}px" hidden>` +
    `<svg class="links" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
    `role="group" aria-label="${escapeHtml(`${flow.title} 전이`)}"><g class="lanes">${lanes}${dividers}</g><g class="edges">${links}</g></svg>` +
    `${stageHeads}${heads}${cards}</section>`
  );
}

/** 흐름 단계와 전이마다 열린 질문 수. 카드 배지에 쓴다. 전이 질문은 출발 단계에 센다 */
function flowQuestionCount(
  questions: readonly UnresolvedQuestion[],
  flows: readonly ArchitectureFlow[],
): Map<string, number> {
  const fromOf = new Map(flows.flatMap((f) => f.transitions.map((t) => [t.id, t.from] as const)));
  const out = new Map<string, number>();
  for (const q of questions) {
    const at =
      q.subject.stepId ??
      (q.subject.transitionId !== undefined ? fromOf.get(q.subject.transitionId) : undefined);
    if (at !== undefined) out.set(at, (out.get(at) ?? 0) + 1);
  }
  return out;
}

/** 클라이언트가 서랍과 흐름 버튼에 쓰는 흐름 데이터. 그린 단계와 전이만 싣는다 */
function flowPayload(
  levels: readonly FlowLevel[],
  flows: readonly ArchitectureFlow[],
  questions: readonly UnresolvedQuestion[],
) {
  const byId = new Map(flows.map((f) => [f.id, f]));
  // 패널에서 그 단계나 전이에 걸린 질문을 바로 보여주려고 문장만 붙인다. 배지 숫자만으로는 무엇을 물어야 하는지 모른다
  const asked = new Map<string, string[]>();
  const ask = (key: string, text: string): void => {
    asked.set(key, [...(asked.get(key) ?? []), text]);
  };
  for (const q of questions) {
    if (q.subject.stepId !== undefined) ask(`s:${q.subject.stepId}`, q.question);
    else if (q.subject.transitionId !== undefined) ask(`t:${q.subject.transitionId}`, q.question);
  }
  const withQuestions = <T extends { id: string }>(prefix: string, item: T) => {
    const list = asked.get(`${prefix}:${item.id}`);
    return list ? { ...item, questions: list } : item;
  };
  return levels.map((l) => {
    const f = byId.get(l.flowId)!;
    const drawnSteps = new Set(l.layout.steps.map((b) => b.id));
    const pathOf = new Map(l.layout.steps.map((b) => [b.id, b.path]));
    const drawnTransitions = new Set(l.layout.transitions.map((r) => r.id));
    return {
      level: l.id,
      id: f.id,
      service: f.service,
      title: f.title,
      ...(f.description !== undefined ? { description: f.description } : {}),
      ...(f.stateLabels !== undefined ? { stateLabels: f.stateLabels } : {}),
      actors: f.actors,
      steps: f.steps
        .filter((st) => drawnSteps.has(st.id))
        .map((st) => withQuestions('s', { ...st, path: pathOf.get(st.id)! })),
      transitions: f.transitions
        .filter((t) => drawnTransitions.has(t.id))
        .map((t) => withQuestions('t', t)),
    };
  });
}

function renderLegend(
  nodes: ArchitectureNode[],
  edges: ArchitectureEdge[],
  drill: boolean,
  generatedAt: string,
  nodeCount: number,
  edgeCount: number,
  hasFlows = false,
): string {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const line = (extra: string): string =>
    `<svg width="36" height="12" aria-hidden="true"><line x1="3" y1="6" x2="33" y2="6" ${extra}/></svg>`;
  const kinds = [...new Set(nodes.map(displayKindOf))]
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
    (hasFlows
      ? `<li>${line('stroke-width="2" class="side-line"')}주황 선: 흐름에서 정상 흐름을 벗어나는 옆 흐름</li>` +
        `<li><span class="swatch-step"></span>점선 테두리 카드: 기획 문서로만 확인한 흐름 단계</li>`
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
  flows: readonly ArchitectureFlow[],
  drawnSteps: ReadonlySet<string>,
): string {
  const edgeById = new Map(allEdges.map((e) => [e.id, e]));
  const stepById = new Map(flows.flatMap((f) => f.steps.map((st) => [st.id, st] as const)));
  const transitionById = new Map(
    flows.flatMap((f) => f.transitions.map((t) => [t.id, t] as const)),
  );
  const stepName = (id: string): string => stepById.get(id)?.label ?? id;
  const nameOr = (id: string): string => {
    const node = nodeById.get(id);
    return node ? nodeName(node) : id;
  };
  const items = questions
    .map((q) => {
      let subject: string | undefined;
      let target: string | undefined;
      const { nodeId, edgeId, stepId, transitionId } = q.subject;
      // 전이 질문은 출발 단계로 데려간다. 선은 카드처럼 고를 자리가 없어서다
      if (stepId !== undefined) {
        subject = stepName(stepId);
        if (drawnSteps.has(stepId)) target = stepId;
      } else if (transitionId !== undefined) {
        const t = transitionById.get(transitionId);
        if (t) {
          subject = `${stepName(t.from)} → ${stepName(t.to)}`;
          target = drawnSteps.has(t.from) ? t.from : drawnSteps.has(t.to) ? t.to : undefined;
        } else {
          subject = transitionId;
        }
      } else if (nodeId !== undefined) {
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

/** 그림에 나오는 환경. 둘 이상일 때만 고르는 버튼을 단다 */
function environmentsOf(nodes: readonly ArchitectureNode[]): string[] {
  const envs = new Set<string>();
  for (const n of nodes) if (n.environment !== undefined) envs.add(n.environment);
  return [...envs].sort((a, b) => compareEnvironment(a, b));
}

// 처음엔 prod만 켠다. 장애나 배포 경로를 볼 때 사람이 먼저 찾는 게 prod라서다. prod가 없으면 맨 앞 환경을 켠다
function renderEnvPicker(envs: readonly string[]): string {
  if (envs.length < 2) return '';
  const on = envs.includes('prod') ? 'prod' : envs[0]!;
  const buttons = envs
    .map(
      (e) =>
        `<button type="button" class="btn" data-env="${escapeHtml(e)}" aria-pressed="${e === on}">${escapeHtml(e)}</button>`,
    )
    .join('');
  return `<div id="env-picker" class="seg env-picker" role="group" aria-label="보일 환경" title="보일 환경 고르기">${buttons}</div>`;
}

function renderBar(
  title: string,
  drill: boolean,
  generatedAt: string,
  nodeCount: number,
  edgeCount: number,
  questionCount: number,
  envs: readonly string[],
  hasFlows: boolean,
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
    (hasFlows
      ? `<button type="button" class="btn" id="flow-btn" hidden aria-haspopup="dialog" aria-expanded="false" aria-controls="flow-pop" ` +
        `title="이 서비스를 쓰는 사람 쪽 흐름 보기">${iconUse('u-flow')}<span class="label">흐름</span></button>`
      : '') +
    renderEnvPicker(envs) +
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
  hostShort: MICRO_HOST_SHORT,
  kindText: { ...NODE_KIND_TEXT, ...EDGE_KIND_TEXT },
  evidenceText: EVIDENCE_TYPE_TEXT,
  laneTitles: LANE_TITLES,
  inferredBadge: INFERRED_BADGE,
  platformChip: PLATFORM_CHIP_TEXT,
  platformName: PLATFORM_NAME,
  webHostingChip: WEB_HOSTING_CHIP_TEXT,
  webHostingName: WEB_HOSTING_NAME,
  backwardKinds: [...FLAT_BACKWARD_EDGE_KINDS].sort(compareStr),
});

interface PageSpec {
  ir: ArchitectureIr;
  payload: ReturnType<typeof buildPayload> & Record<string, unknown>;
  sections: string;
  drill: boolean;
  /** 그린 흐름. 공유본이면 가린 사본이다 */
  flows?: { flows: ArchitectureFlow[]; drawnSteps: Set<string> };
}

function renderPage({ ir, payload, sections, drill, flows }: PageSpec): string {
  const title = viewTitle(ir);
  const nodeById = new Map(payload.nodes.map((n) => [n.id, n]));
  const hasFlows = flows !== undefined && flows.flows.length > 0;
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
      environmentsOf(payload.nodes),
      hasFlows,
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
      hasFlows,
    ),
    renderQuestions(
      payload.unresolved,
      nodeById,
      ir.edges,
      flows?.flows ?? [],
      flows?.drawnSteps ?? new Set(),
    ),
    hasFlows
      ? '<div id="flow-pop" class="pop" role="dialog" aria-label="흐름 고르기" tabindex="-1" hidden><h3>흐름</h3><ul class="flow-list"></ul></div>'
      : '',
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
    title: viewTitle(ir),
    nodes: payload.nodes,
    edges: payload.edges.map(asCanvasEdge),
    layout,
    enter: {},
    hidden: false,
    services: payload.services,
    microHosts: new Set(payload.microHosts ?? []),
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
  // 좌표는 원본으로 냈고 글자만 공유본에서 가린다. 단계 id는 가리지 않아 그대로 맞물린다
  const flowById = new Map((ir.flows ?? []).map((f) => [f.id, f]));
  const flowLevels = drilldown.flows.map((l) => ({ level: l, flow: flowById.get(l.flowId)! }));
  const drawnFlows = flowLevels.map((x) => x.flow);
  const drawnSteps = new Set(drilldown.flows.flatMap((l) => l.layout.steps.map((b) => b.id)));
  const questionCount = flowQuestionCount(base.unresolved, drawnFlows);
  const drawableNodes = new Set(base.nodes.map((n) => n.id));
  const flowCount = flowCountByService(drilldown.flows);
  if (flowLevels.length > 0) {
    Object.assign(payload, {
      levels: [
        ...payload.levels,
        ...flowLevels.map(({ level, flow }) => ({
          id: level.id,
          kind: 'flow',
          title: flow.title,
          trail: level.trail,
          edges: [],
        })),
      ],
      flows: flowPayload(drilldown.flows, drawnFlows, base.unresolved),
    });
  }
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
        microHosts: new Set(base.microHosts ?? []),
        flows: flowCount,
      }),
    )
    .concat(
      flowLevels.map(({ level, flow }) =>
        renderFlowSection(level, flow, questionCount, drawableNodes),
      ),
    )
    .join('\n');
  return renderPage({
    ir,
    payload,
    sections,
    drill: true,
    ...(flowLevels.length > 0 ? { flows: { flows: drawnFlows, drawnSteps } } : {}),
  });
}
