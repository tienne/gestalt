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
  VIEW_CSS,
  DOC_CSS,
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
import { ALL_PACKS_VOCABULARY, irVocabulary, type Vocabulary } from './packs/index.js';
import { KNOWLEDGE_COVERAGE_KINDS, KNOWLEDGE_DOC_KINDS } from './packs/knowledge.js';
import { computeCompareLayout, type CompareLayout } from './compare-layout.js';
import { computeDataflowLayout, type DataflowLayout } from './dataflow-layout.js';
import { computeSequenceLayout, type SequenceLayout } from './sequence-layout.js';
import { computeServiceFacts, type ServiceFacts } from './service-facts.js';
import type {
  ArchitectureEdge,
  ArchitectureFlow,
  ArchitectureIr,
  ArchitectureNode,
  ArchitectureProjection,
  ProjectionMessage,
  SequenceBlockKind,
  EdgeKind,
  DisplayKind,
  Evidence,
  UnresolvedQuestion,
} from './types.js';
import { chipTextOverride, displayKindOf } from './types.js';
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
  knowledge: '지식 문서 지도',
  'knowledge-link': '지식과 아키텍처',
};

/** 하네스 레포는 화면이 없어 '화면별'이 틀린 말이 된다. 화면이 하나라도 있으면 웹 그림으로 친다 */
function viewTitle(ir: ArchitectureIr): string {
  if (ir.view !== 'screen-chain' || ir.nodes.some((n) => n.kind === 'screen')) {
    return VIEW_TITLES[ir.view];
  }
  if (ir.nodes.some((n) => n.kind === 'skill')) return '스킬별 호출 흐름';
  if (ir.nodes.some((n) => n.kind === 'endpoint' && n.protocol === 'mcp'))
    return 'MCP 도구 호출 흐름';
  // 팩을 적은 IR에서 web-product가 빠졌으면 화면도 호출도 없는 그림이다. 팩이 없는 옛 IR은 제목을 그대로 둔다
  if (ir.packs && !ir.packs.includes('web-product')) {
    return ir.nodes.length === 0 && (ir.flows?.length ?? 0) > 0 ? '업무 흐름' : '구성 요소 연결';
  }
  return VIEW_TITLES[ir.view];
}

// 페이지에 보이는 글자는 IR 식별자 대신 읽는 사람 말로 바꿔 보여준다
const NODE_KIND_TEXT = Object.fromEntries(
  Object.entries(ALL_PACKS_VOCABULARY.looks).map(([k, d]) => [k, d.text]),
) as Record<DisplayKind, string>;
const EDGE_KIND_TEXT = {
  ...Object.fromEntries(
    Object.entries(ALL_PACKS_VOCABULARY.edgeKinds).map(([k, d]) => [k, d.text]),
  ),
  contains: '포함',
} as Record<EdgeKind | 'contains', string>;
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

/** 기술 카드에 얹는 문서 한 줄. 본문 조각은 없고 경로와 제목, 수만 싣는다 */
interface DocOverlayEntry {
  id: string;
  path: string;
  title?: string;
  via: string;
  verified: boolean;
  gaps: number;
  unverified: number;
  broken: number;
  staleSince?: string;
}

/** 지식과 아키텍처 그림에서 기술 노드 id → 그 노드를 설명하는 문서. 다른 그림이면 undefined */
function docOverlayOf(
  ir: ArchitectureIr,
  drawable: ReadonlySet<string>,
): Record<string, DocOverlayEntry[]> | undefined {
  if (ir.view !== 'knowledge-link') return undefined;
  const docById = new Map(ir.nodes.map((n) => [n.id, n]));
  const out: Record<string, DocOverlayEntry[]> = {};
  for (const e of [...ir.edges].sort(byId)) {
    if (e.kind !== 'describes' || !drawable.has(e.to)) continue;
    const d = docById.get(e.from);
    if (d?.doc === undefined || !KNOWLEDGE_DOC_KINDS.includes(d.kind)) continue;
    const gaps = d.doc.gaps ?? [];
    (out[e.to] ??= []).push({
      id: d.id,
      path: d.doc.path,
      ...(d.displayName !== undefined ? { title: d.displayName } : {}),
      via: e.docLink?.via ?? 'session',
      verified: e.docLink?.refs.some((r) => r.verified) ?? false,
      gaps: gaps.filter((g) => g.kind === 'gap').length,
      unverified: gaps.filter((g) => g.kind === 'unverified').length,
      broken: d.doc.links?.broken ?? 0,
      ...(d.doc.staleSince !== undefined ? { staleSince: d.doc.staleSince } : {}),
    });
  }
  return out;
}

/** 카드 배지에 쓰는 문서 수와 낡은 문서 수. 문서가 있어야 할 kind는 0개도 싣는다 */
function docCoverOf(
  nodes: readonly ArchitectureNode[],
  overlay: Record<string, DocOverlayEntry[]> | undefined,
): Record<string, DocCover> | undefined {
  if (overlay === undefined) return undefined;
  // 담당은 공유본에서 빠진다. 담당이 하나도 안 실린 그림에서 "담당 없음"을 달면 전부 비어 보이므로 그때는 안 단다
  const ownersKnown = nodes.some((n) => (n.owners ?? []).length > 0);
  const out: Record<string, DocCover> = {};
  for (const n of nodes) {
    const list = overlay[n.id] ?? [];
    const slot = KNOWLEDGE_COVERAGE_KINDS.includes(n.kind);
    if (list.length === 0 && !slot) continue;
    out[n.id] = {
      docs: list.length,
      stale: list.filter((d) => d.staleSince !== undefined).length,
      ...(ownersKnown && slot && (n.owners ?? []).length === 0 ? { unowned: true } : {}),
    };
  }
  return out;
}

function docCoverSpec(
  nodes: readonly ArchitectureNode[],
  overlay: Record<string, DocOverlayEntry[]> | undefined,
): { docCover?: Record<string, DocCover> } {
  const docCover = docCoverOf(nodes, overlay);
  return docCover !== undefined ? { docCover } : {};
}

function docCoverageOf(
  nodes: readonly ArchitectureNode[],
  overlay: Record<string, DocOverlayEntry[]> | undefined,
): { covered: number; total: number } | undefined {
  if (overlay === undefined) return undefined;
  const slots = nodes.filter((n) => KNOWLEDGE_COVERAGE_KINDS.includes(n.kind));
  return {
    covered: slots.filter((n) => (overlay[n.id] ?? []).length > 0).length,
    total: slots.length,
  };
}

interface DocCover {
  docs: number;
  stale: number;
  unowned?: true;
}

// 페이지가 실제로 쓰는 필드만 싣는다. repo root 같은 로컬 경로와 sourcesUsed 식별자가 공유본으로 새지 않게 한다
function buildPayload(ir: ArchitectureIr, validated: ValidatedIr, shared: boolean) {
  const nodes = ir.nodes.filter((n) => validated.drawableNodeIds.has(n.id)).sort(byId);
  const edges = ir.edges.filter((e) => validated.drawableEdgeIds.has(e.id)).sort(byId);
  const services = Object.fromEntries(computeServiceFacts(nodes, edges));
  const apps = indexMicroApps(nodes, edges);
  // 호스트 칩 글자를 클라이언트가 새로 그리는 카드에도 달아야 해서 싣는다. 앱이 없는 IR은 키 자체를 안 넣어 바이트가 그대로다
  const microHosts = [...apps.hosts].sort(compareStr);
  const docOverlay = docOverlayOf(ir, validated.drawableNodeIds);
  return {
    schemaVersion: ir.schemaVersion,
    view: ir.view,
    generatedAt: ir.generatedAt,
    repos: ir.repos.map((r) => ({ id: r.id, name: r.name })).sort(byId),
    nodes,
    edges,
    services,
    ...(microHosts.length > 0 ? { microHosts } : {}),
    ...(docOverlay !== undefined ? { docOverlay } : {}),
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
type CanvasEdge = Pick<
  DrillEdge,
  'id' | 'from' | 'to' | 'count' | 'lineStyle' | 'kind' | 'inferred'
> & {
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

/** 문서 카드의 열린 구멍 수와 깨진 근거 링크 수. 문서가 아닌 카드에는 아무것도 안 붙인다 */
function docBadges(node: ArchitectureNode): string {
  const doc = node.doc;
  if (doc === undefined) return '';
  const gaps = doc.gaps?.length ?? 0;
  const broken = doc.links?.broken ?? 0;
  return (
    (gaps > 0 ? `<span class="doc-badge" title="열린 구멍 ${gaps}개">구멍 ${gaps}</span>` : '') +
    (broken > 0
      ? `<span class="doc-badge broken" title="깨진 근거 링크 ${broken}개">깨짐 ${broken}</span>`
      : '') +
    (doc.orphan
      ? '<span class="doc-badge none" title="README나 SKILL 같은 진입 문서에서 링크를 따라가도 안 닿아요">고립</span>'
      : '')
  );
}

/** 지식과 아키텍처 그림의 기술 카드 배지. 문서가 없으면 "문서 없음"을 단다. 있으면 수와 낡은 수를 단다 */
function docCoverBadge(cover: DocCover | undefined): string {
  if (cover === undefined) return '';
  const owner = cover.unowned
    ? '<span class="doc-badge none" title="CODEOWNERS에 이 자리를 맡은 담당이 없어요">담당 없음</span>'
    : '';
  if (cover.docs === 0)
    return (
      '<span class="doc-badge none" title="이 자리를 설명하는 문서가 없어요">문서 없음</span>' +
      owner
    );
  return (
    `<span class="doc-badge cover" title="설명하는 문서 ${cover.docs}개">문서 ${cover.docs}</span>` +
    (cover.stale > 0
      ? `<span class="doc-badge stale" title="코드가 문서보다 늦게 바뀐 문서 ${cover.stale}개">낡음 ${cover.stale}</span>`
      : '') +
    owner
  );
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
  cover?: DocCover,
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
    `${name}, ${chipTextOverride(node) ?? NODE_KIND_TEXT[dk]}${guess ? `, ${INFERRED_BADGE} 이름` : ''}` +
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
    `<span class="kc">${engine !== undefined ? iconUse(`e-${engine}`, `brand b-${engine}`) : iconUse(`i-${dk}`)}${escapeHtml(micro.host ? MICRO_HOST_SHORT : (chipTextOverride(node) ?? NODE_KIND_SHORT[dk]))}</span>` +
    `<span class="nm"><span class="t">${escapeHtml(name)}</span>${guess ? `<span class="guess">${INFERRED_BADGE}</span>` : ''}` +
    (flows > 0
      ? `<span class="flow-badge" title="사용자 흐름 보기">${iconUse('u-flow')}${escapeHtml(flowBadgeText(flows))}</span>`
      : '') +
    docBadges(node) +
    docCoverBadge(cover) +
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

// 근거가 섞인 묶음의 배지는 테두리를 점선으로 둔다. 공용 CSS를 고치면 섞인 묶음이 없는 그림까지 바이트가 바뀌어 속성으로 단다
const MIXED_PILL = ` stroke-dasharray="3 2"`;

/** 묶음 이름 뒤에 붙는 말. 코드로 확인된 고리와 문서나 사용자 근거뿐인 고리가 섞였을 때만 붙는다 */
export function inferredNote(inferred: number | undefined): string {
  return inferred !== undefined ? ` (문서 근거만 있는 연결 ${inferred}개 포함)` : '';
}

function renderPill(count: number, at: { x: number; y: number }, mixed = false): string {
  const text = String(count);
  const w = 14 + text.length * 7;
  return (
    `<g class="pill" transform="translate(${at.x},${at.y})">` +
    `<rect x="${round2(-w / 2)}" y="-9" width="${w}" height="18" rx="9"${mixed ? MIXED_PILL : ''}/><text>${text}</text></g>`
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
    const name = `${labelOf(edge.from)} → ${labelOf(edge.to)} ${edge.count}개${inferredNote(edge.inferred)}${xaText}`;
    return (
      `<g class="link bundle${xa}" data-bundle-id="${escapeHtml(edge.id)}" ${ends} tabindex="0" role="button" aria-label="${escapeHtml(name)}">` +
      `<title>${escapeHtml(name)}</title>${hit}` +
      `<path class="edge" d="${route.d}" stroke-width="${width}"${dash}/>${tip}` +
      `${renderPill(edge.count, route.mid, edge.inferred !== undefined)}</g>`
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
  /** 지식과 아키텍처 그림만. 노드 id → 문서 수 */
  docCover?: Record<string, DocCover>;
  /** 서비스 id → 흐름 수. 드릴다운 그림에만 있다 */
  flows?: Record<string, number>;
  /** 카드가 없는 레벨에서 대신 보여줄 흐름 링크. 서비스 없는 흐름만 있는 그림의 전체 레벨이 그렇다 */
  emptyLinks?: { level: string; title: string }[];
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

// 스타일을 인라인으로 두는 건 공용 CSS에 규칙을 더하면 기존 그림의 바이트가 바뀌어서다
function emptyFlowLinks(links: { level: string; title: string }[]): string {
  const items = links
    .map(
      (l) =>
        `<li><a href="#/level/${encodeURIComponent(l.level)}" style="color:var(--text)">${escapeHtml(l.title)}</a></li>`,
    )
    .join('');
  return (
    `<div class="empty-state"><div><p style="margin:0 0 8px">이 그림은 흐름만 있어요. 볼 흐름을 고르세요.</p>` +
    `<ul style="margin:0;padding-left:18px;line-height:1.8">${items}</ul></div></div>`
  );
}

/** 레벨 하나. 레인 띠와 선은 SVG, 카드는 그 위에 겹친 HTML이다. 좌표는 전부 서버가 박는다 */
function renderLevelSection(spec: CanvasSpec): string {
  const open = `<section class="level" data-level-id="${escapeHtml(spec.levelId)}" aria-label="${escapeHtml(spec.title)}"`;
  const hidden = spec.hidden ? ' hidden' : '';
  if (spec.nodes.length === 0) {
    const { width, height } = EMPTY_LEVEL_SIZE;
    return (
      `${open} data-w="${width}" data-h="${height}" style="width:${width}px;height:${height}px"${hidden}>` +
      `${spec.emptyLinks?.length ? emptyFlowLinks(spec.emptyLinks) : '<p class="empty-state">여기는 보여줄 항목이 없어요.</p>'}</section>`
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
        spec.docCover?.[n.id],
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

/** 투영 레벨 id 앞머리. 흐름 레벨의 flow:처럼 지도 레벨 id와 안 겹치게 한다 */
const VIEW_LEVEL_PREFIX = 'view:';

/** 서랍이 메시지를 누를 때 쓰는 데이터. 그린 메시지만 싣고 걸린 질문 문장을 붙인다 */
function messagePayload(
  views: readonly { projection: ArchitectureProjection }[],
  drawn: ReadonlySet<string>,
  questions: readonly UnresolvedQuestion[],
  edges: readonly ArchitectureEdge[],
): Record<string, unknown> {
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const out: Record<string, unknown> = {};
  for (const { projection } of views) {
    const blockLabel = new Map(
      (projection.blocks ?? []).map((b) => [b.id, `${SEQUENCE_BLOCK_TEXT[b.kind]} [${b.label}]`]),
    );
    for (const m of projection.messages) {
      if (!drawn.has(m.id)) continue;
      const asked = questions.filter((q) => q.subject.messageId === m.id).map((q) => q.question);
      out[m.id] = {
        id: m.id,
        view: projection.title,
        from: m.from,
        to: m.to,
        label: m.label,
        lineStyle: m.lineStyle,
        evidence: [
          ...m.evidence,
          ...(m.edge !== undefined ? (edgeById.get(m.edge)?.evidence ?? []) : []),
        ],
        ...(projection.shape === 'dataflow' ? { shape: 'dataflow' } : {}),
        ...(m.edge !== undefined ? { edge: m.edge } : {}),
        ...(m.reply ? { reply: true } : {}),
        ...(m.block !== undefined ? { block: blockLabel.get(m.block) } : {}),
        ...(m.branch !== undefined ? { branch: m.branch } : {}),
        ...(asked.length > 0 ? { questions: asked } : {}),
      };
    }
  }
  return out;
}

const SEQUENCE_BLOCK_TEXT: Record<SequenceBlockKind, string> = {
  alt: '분기',
  opt: '조건',
  loop: '반복',
  par: '동시',
};
const ARROW = 8;

/** 투영 그림의 카드. 지도 카드를 그대로 써서 누르면 같은 서랍이 열린다 */
function viewCards(
  boxes: readonly { id: string; x: number; y: number; width: number; height: number }[],
  nodeById: ReadonlyMap<string, ArchitectureNode>,
  services: Record<string, ServiceFacts>,
): string {
  return boxes
    .map((b) =>
      renderCard(
        nodeById.get(b.id)!,
        {
          id: b.id,
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
        } as LayoutResult['nodes'][number],
        false,
        false,
        services[b.id],
        undefined,
        { host: false },
      ),
    )
    .join('');
}

const VIEW_SVG_LABEL: Record<ArchitectureProjection['shape'], string> = {
  sequence: '메시지',
  dataflow: '데이터 이동',
  compare: '견주기',
};

/** 투영 레벨 하나. 맨 위에 답하는 질문을 적고 그 아래 모양별 선과 카드를 얹는다 */
function viewSection(
  levelId: string,
  projection: ArchitectureProjection,
  width: number,
  height: number,
  under: string,
  links: string,
  cards: string,
): string {
  return (
    `<section class="level view-level" data-level-id="${escapeHtml(levelId)}" aria-label="${escapeHtml(projection.title)}" ` +
    `data-w="${width}" data-h="${height}" style="width:${width}px;height:${height}px" hidden>` +
    `<p class="view-q" style="left:${CANVAS_PAD_X}px">${escapeHtml(projection.question)}</p>` +
    `<svg class="links" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
    `role="group" aria-label="${escapeHtml(`${projection.title} ${VIEW_SVG_LABEL[projection.shape]}`)}"><g class="lanes">${under}</g><g class="edges">${links}</g></svg>` +
    `${cards}</section>`
  );
}

/** 질문 하나에 답하는 sequence 그림. 머리 카드는 지도 카드를 그대로 써서 누르면 같은 서랍이 열린다 */
function renderSequenceSection(
  levelId: string,
  projection: ArchitectureProjection,
  layout: SequenceLayout,
  nodeById: ReadonlyMap<string, ArchitectureNode>,
  services: Record<string, ServiceFacts>,
): string {
  const px = (x: number): number => round2(x + CANVAS_PAD_X);
  const py = (y: number): number => round2(y + CANVAS_PAD_TOP);
  const width = round2(layout.width + CANVAS_PAD_X * 2);
  const height = round2(layout.height + CANVAS_PAD_TOP);
  const messageById = new Map(projection.messages.map((m) => [m.id, m]));
  const nameOf = (id: string): string => {
    const n = nodeById.get(id);
    return n ? nodeName(n) : id;
  };
  const lifelines = layout.lifelines
    .map(
      (l) =>
        `<line class="lifeline" x1="${px(l.x)}" x2="${px(l.x)}" y1="${py(l.y1)}" y2="${py(l.y2)}"/>`,
    )
    .join('');
  const blocks = layout.blocks
    .map((b) => {
      const tag = SEQUENCE_BLOCK_TEXT[b.kind];
      const tagW = textUnits(tag) * 7 + 16;
      const branches = b.branches
        .map(
          (br) =>
            `<line class="b-branch" x1="${px(b.x)}" x2="${px(b.x + b.width)}" y1="${py(br.y)}" y2="${py(br.y)}"/>` +
            (br.label !== ''
              ? `<text class="b-label" x="${px(b.x + 10)}" y="${py(br.y + 16)}">[${escapeHtml(br.label)}]</text>`
              : ''),
        )
        .join('');
      return (
        `<g class="seq-block b-${b.kind}"><rect x="${px(b.x)}" y="${py(b.y)}" width="${b.width}" height="${b.height}" rx="6"/>` +
        `<path class="b-tab" d="M${px(b.x)} ${py(b.y + 20)}H${px(b.x + tagW)}L${px(b.x + tagW + 8)} ${py(b.y + 12)}V${py(b.y)}"/>` +
        `<text class="b-kind" x="${px(b.x + 8)}" y="${py(b.y + 14)}">${tag}</text>` +
        `<text class="b-label" x="${px(b.x + tagW + 16)}" y="${py(b.y + 14)}">[${escapeHtml(b.label)}]</text>` +
        `${branches}</g>`
      );
    })
    .join('');
  const links = layout.messages
    .map((box) => {
      const m = messageById.get(box.id)!;
      const dash = m.lineStyle === 'dashed' ? ` stroke-dasharray="${DASHED_PATTERN}"` : '';
      const y = py(box.y);
      let d: string;
      let tip: [string, string, string];
      let labelX: number;
      let anchor = 'middle';
      if (box.self) {
        const x = px(box.x1);
        const yb = round2(y + 10);
        d = `M${x} ${round2(y - 10)}H${round2(x + 36)}V${yb}H${x}`;
        tip = [
          `${x},${yb}`,
          `${round2(x + ARROW)},${round2(yb - ARROW / 2)}`,
          `${round2(x + ARROW)},${round2(yb + ARROW / 2)}`,
        ];
        labelX = round2(x + 44);
        anchor = 'start';
      } else {
        const x1 = px(box.x1);
        const x2 = px(box.x2);
        const back = round2(x2 - (x2 > x1 ? 1 : -1) * ARROW);
        d = `M${x1} ${y}H${x2}`;
        tip = [
          `${x2},${y}`,
          `${back},${round2(y - ARROW / 2)}`,
          `${back},${round2(y + ARROW / 2)}`,
        ];
        labelX = round2((x1 + x2) / 2);
      }
      const name =
        `${box.n}. ${nameOf(m.from)} → ${nameOf(m.to)}: ${m.label}` +
        (m.reply ? ', 응답' : '') +
        (m.lineStyle === 'dashed' ? ', 문서로만 확인' : '');
      // 응답은 열린 화살촉으로 그린다. 요청과 응답이 같은 두 줄 사이를 오갈 때 방향만으로는 구분이 안 된다
      const head = m.reply
        ? `<polyline class="tip open" points="${tip[1]} ${tip[0]} ${tip[2]}"/>`
        : `<polygon class="tip" points="${tip.join(' ')}"/>`;
      return (
        `<g class="link seq-m${m.reply ? ' reply' : ''}" data-from="${escapeHtml(m.from)}" data-to="${escapeHtml(m.to)}" ` +
        `data-message-id="${escapeHtml(m.id)}" tabindex="0" role="button" aria-label="${escapeHtml(name)}">` +
        `<title>${escapeHtml(name)}</title><path class="hit" d="${d}" stroke-width="12"/>` +
        `<path class="edge" d="${d}" stroke-width="1.6"${dash}/>${head}` +
        `<text class="m-label" x="${labelX}" y="${round2(y - 7)}" text-anchor="${anchor}"><tspan class="m-n">${box.n}.</tspan> ${escapeHtml(m.label)}</text></g>`
      );
    })
    .join('');
  return viewSection(
    levelId,
    projection,
    width,
    height,
    `${lifelines}${blocks}`,
    links,
    viewCards(layout.heads, nodeById, services),
  );
}

/** 데이터가 어디서 어디로 옮겨 가는지. 선 라벨이 옮겨 가는 데이터 이름이다 */
function renderDataflowSection(
  levelId: string,
  projection: ArchitectureProjection,
  layout: DataflowLayout,
  nodeById: ReadonlyMap<string, ArchitectureNode>,
  services: Record<string, ServiceFacts>,
): string {
  const px = (x: number): number => round2(x + CANVAS_PAD_X);
  const py = (y: number): number => round2(y + CANVAS_PAD_TOP);
  const shift = (d: string): string =>
    d.replace(
      /(-?[\d.]+) (-?[\d.]+)/g,
      (_, x: string, y: string) => `${px(Number(x))} ${py(Number(y))}`,
    );
  const shiftPt = (p: string): string => {
    const [x, y] = p.split(',');
    return `${px(Number(x))},${py(Number(y))}`;
  };
  const width = round2(layout.width + CANVAS_PAD_X * 2);
  const height = round2(layout.height + CANVAS_PAD_TOP);
  const messageById = new Map(projection.messages.map((m) => [m.id, m]));
  const nameOf = (id: string): string => {
    const n = nodeById.get(id);
    return n ? nodeName(n) : id;
  };
  const links = layout.edges
    .map((e) => {
      const m = messageById.get(e.id)!;
      const dash = m.lineStyle === 'dashed' ? ` stroke-dasharray="${DASHED_PATTERN}"` : '';
      const d = shift(e.d);
      const name =
        `${nameOf(m.from)} → ${nameOf(m.to)}: ${m.label}` +
        (m.lineStyle === 'dashed' ? ', 문서로만 확인' : '');
      return (
        `<g class="link seq-m df-m" data-from="${escapeHtml(m.from)}" data-to="${escapeHtml(m.to)}" ` +
        `data-message-id="${escapeHtml(m.id)}" tabindex="0" role="button" aria-label="${escapeHtml(name)}">` +
        `<title>${escapeHtml(name)}</title><path class="hit" d="${d}" stroke-width="12"/>` +
        `<path class="edge" d="${d}" stroke-width="1.6"${dash}/><polygon class="tip" points="${e.tip.map(shiftPt).join(' ')}"/>` +
        `<text class="m-label" x="${px(e.labelX)}" y="${py(e.labelY)}" text-anchor="middle">${escapeHtml(m.label)}</text></g>`
      );
    })
    .join('');
  return viewSection(
    levelId,
    projection,
    width,
    height,
    '',
    links,
    viewCards(layout.cards, nodeById, services),
  );
}

/** 두 묶음 견주기. 왼쪽에만, 둘 다, 오른쪽에만 세 열로 세운다 */
function renderCompareSection(
  levelId: string,
  projection: ArchitectureProjection,
  layout: CompareLayout,
  nodeById: ReadonlyMap<string, ArchitectureNode>,
  services: Record<string, ServiceFacts>,
): string {
  const px = (x: number): number => round2(x + CANVAS_PAD_X);
  const py = (y: number): number => round2(y + CANVAS_PAD_TOP);
  const width = round2(layout.width + CANVAS_PAD_X * 2);
  const height = round2(layout.height + CANVAS_PAD_TOP);
  const columns = layout.columns
    .map(
      (c) =>
        `<g class="cmp-col cmp-${c.key}"><rect x="${px(c.x)}" y="${py(0)}" width="${c.width}" height="${c.height}" rx="10"/>` +
        `<text class="cmp-head" x="${px(c.x + 16)}" y="${py(25)}">${escapeHtml(c.title)}<tspan class="cmp-n" dx="8">${c.count}</tspan></text>` +
        (c.count === 0
          ? `<text class="cmp-empty" x="${px(c.x + c.width / 2)}" y="${py(66)}" text-anchor="middle">없음</text>`
          : '') +
        '</g>',
    )
    .join('');
  return viewSection(
    levelId,
    projection,
    width,
    height,
    columns,
    '',
    viewCards(layout.cards, nodeById, services),
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
      ...(f.service !== undefined ? { service: f.service } : {}),
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
  messages: readonly ProjectionMessage[] = [],
): string {
  const edgeById = new Map(allEdges.map((e) => [e.id, e]));
  const messageById = new Map(messages.map((m) => [m.id, m]));
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
      const { nodeId, edgeId, stepId, transitionId, messageId } = q.subject;
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
      } else if (messageId !== undefined) {
        const m = messageById.get(messageId);
        subject = m ? `${nameOr(m.from)} → ${nameOr(m.to)}: ${m.label}` : messageId;
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
  hasViews = false,
  docCoverage?: { covered: number; total: number },
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
    (hasViews
      ? `<button type="button" class="btn" id="views-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="views" ` +
        `title="질문 하나에 답하는 그림 보기">${iconUse('u-flow')}<span class="label">질문별 그림</span></button>`
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
    `<span class="meta" title="만든 시각 ${escapeHtml(generatedAt)}"><span>항목 ${nodeCount}</span><span>연결 ${edgeCount}</span>` +
    (docCoverage !== undefined
      ? `<span title="문서가 붙은 서비스, 앱, 모듈, 기능, 화면">문서 있음 ${docCoverage.covered}/${docCoverage.total}</span>`
      : '') +
    `</span>` +
    `</header>`
  );
}

const clientScripts = new Map<string, string>();

/** 칩 글자와 설명, 레인 제목은 IR이 쓰는 팩 것만 싣는다. 팩을 더해도 그 팩을 안 쓰는 그림의 바이트가 그대로다 */
function clientScriptFor(
  vocab: Vocabulary,
  rootFlows: boolean,
  views: boolean,
  mixedBundles: boolean,
): string {
  const key = `${vocab.packIds.join(',')}|${rootFlows}|${views}|${mixedBundles}`;
  const hit = clientScripts.get(key);
  if (hit !== undefined) return hit;
  const pick = <T>(table: Record<string, T>, keys: Iterable<string>): Record<string, T> =>
    Object.fromEntries([...keys].map((k) => [k, table[k]!]));
  const script = renderClientScript({
    kindShort: pick(NODE_KIND_SHORT, Object.keys(vocab.looks)),
    hostShort: MICRO_HOST_SHORT,
    kindText: {
      ...pick(NODE_KIND_TEXT, Object.keys(vocab.looks)),
      ...pick(EDGE_KIND_TEXT, [...Object.keys(vocab.edgeKinds), 'contains']),
    },
    evidenceText: EVIDENCE_TYPE_TEXT,
    laneTitles: pick(LANE_TITLES, Object.keys(vocab.lanes)) as typeof LANE_TITLES,
    inferredBadge: INFERRED_BADGE,
    platformChip: PLATFORM_CHIP_TEXT,
    platformName: PLATFORM_NAME,
    webHostingChip: WEB_HOSTING_CHIP_TEXT,
    webHostingName: WEB_HOSTING_NAME,
    backwardKinds: [...FLAT_BACKWARD_EDGE_KINDS]
      .filter((k) => k in vocab.edgeKinds)
      .sort(compareStr),
    components: 'component' in vocab.nodeKinds,
    rootFlows,
    views,
    mixedBundles,
    docs: vocab.packIds.includes('knowledge'),
  });
  clientScripts.set(key, script);
  return script;
}

/** 그림 단추가 여는 목록. 링크라서 주소 해시로 바로 그 레벨로 간다 */
function renderViewsPop(views: { level: string; projection: ArchitectureProjection }[]): string {
  const items = views
    .map(
      (v) =>
        `<li><a href="#/level/${encodeURIComponent(v.level)}"><b>${escapeHtml(v.projection.title)}</b>` +
        `<span>${escapeHtml(v.projection.question)}</span></a></li>`,
    )
    .join('');
  return `<div id="views" class="pop" role="dialog" aria-label="질문별 그림" tabindex="-1" hidden><h3>질문별 그림</h3><ul class="flow-list view-list">${items}</ul></div>`;
}

interface PageSpec {
  ir: ArchitectureIr;
  payload: ReturnType<typeof buildPayload> & Record<string, unknown>;
  sections: string;
  drill: boolean;
  /** 그린 흐름. 공유본이면 가린 사본이다 */
  flows?: { flows: ArchitectureFlow[]; drawnSteps: Set<string> };
  /** 그린 투영. 있을 때만 그림 단추와 메시지 서랍 코드를 싣는다 */
  views?: { level: string; projection: ArchitectureProjection }[];
  /** 근거가 섞인 묶음 선이 있으면 true. 그때만 그 표시 코드를 싣는다 */
  mixedBundles?: boolean;
}

function renderPage({
  ir,
  payload,
  sections,
  drill,
  flows,
  views,
  mixedBundles = false,
}: PageSpec): string {
  const title = viewTitle(ir);
  const vocab = irVocabulary(ir);
  const nodeById = new Map(payload.nodes.map((n) => [n.id, n]));
  const hasFlows = flows !== undefined && flows.flows.length > 0;
  const hasViews = views !== undefined && views.length > 0;
  return [
    '<!doctype html>',
    '<html lang="ko">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<script>${THEME_BOOT_SCRIPT}</script>`,
    `<style>${renderCss(vocab)}${hasViews ? `\n${VIEW_CSS}` : ''}${vocab.packIds.includes('knowledge') ? `\n${DOC_CSS}` : ''}</style>`,
    '</head>',
    '<body>',
    renderIconSprite(vocab),
    renderBar(
      title,
      drill,
      ir.generatedAt,
      payload.nodes.length,
      payload.edges.length,
      payload.unresolved.length,
      environmentsOf(payload.nodes),
      hasFlows,
      hasViews,
      docCoverageOf(payload.nodes, payload.docOverlay),
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
      views?.flatMap((v) => v.projection.messages),
    ),
    (hasFlows
      ? '<div id="flow-pop" class="pop" role="dialog" aria-label="흐름 고르기" tabindex="-1" hidden><h3>흐름</h3><ul class="flow-list"></ul></div>'
      : '') + (hasViews ? `\n${renderViewsPop(views)}` : ''),
    `<script id="ir" type="application/json">${embedJson(stableStringify(payload))}</script>`,
    `<script>${clientScriptFor(vocab, hasFlows && flows.flows.some((f) => f.service === undefined), hasViews, mixedBundles)}</script>`,
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
    ...docCoverSpec(payload.nodes, payload.docOverlay),
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
  const docCover = docCoverSpec(base.nodes, base.docOverlay);
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
  const drawnMessages = validated.drawableMessageIds ?? new Set<string>();
  const drawnViews = validated.drawableProjectionIds ?? new Set<string>();
  const views = (ir.projections ?? [])
    .filter((p) => drawnViews.has(p.id))
    .map((projection) => ({ level: `${VIEW_LEVEL_PREFIX}${projection.id}`, projection }));
  if (views.length > 0) {
    Object.assign(payload, {
      levels: [
        ...(payload as { levels: unknown[] }).levels,
        ...views.map((v) => ({
          id: v.level,
          kind: 'view',
          title: v.projection.title,
          trail: [ROOT_LEVEL_ID, v.level],
          edges: [],
        })),
      ],
      messages: messagePayload(views, drawnMessages, base.unresolved, ir.edges),
    });
  }
  const rootFlowLinks = flowLevels
    .filter(({ flow }) => flow.service === undefined)
    .map(({ level, flow }) => ({ level: level.id, title: flow.title }))
    .concat(views.map((v) => ({ level: v.level, title: v.projection.title })));
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
        ...docCover,
        flows: flowCount,
        ...(l.id === ROOT_LEVEL_ID && l.nodeIds.length === 0 && rootFlowLinks.length > 0
          ? { emptyLinks: rootFlowLinks }
          : {}),
      }),
    )
    .concat(
      flowLevels.map(({ level, flow }) =>
        renderFlowSection(level, flow, questionCount, drawableNodes),
      ),
    )
    .concat(
      views.map((v) => {
        const p = v.projection;
        if (p.shape === 'dataflow') {
          const layout = computeDataflowLayout(p, drawnMessages, nodeById);
          return renderDataflowSection(v.level, p, layout, nodeById, base.services);
        }
        if (p.shape === 'compare') {
          const layout = computeCompareLayout(p, drawableNodes, nodeById);
          return renderCompareSection(v.level, p, layout, nodeById, base.services);
        }
        const layout = computeSequenceLayout(p, drawnMessages, nodeById);
        return renderSequenceSection(v.level, p, layout, nodeById, base.services);
      }),
    )
    .join('\n');
  return renderPage({
    ir,
    payload,
    sections,
    drill: true,
    ...(flowLevels.length > 0 ? { flows: { flows: drawnFlows, drawnSteps } } : {}),
    ...(views.length > 0 ? { views } : {}),
    mixedBundles: levels.some((l) => l.edges.some((e) => e.inferred !== undefined)),
  });
}
