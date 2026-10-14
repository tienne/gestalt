import { buildGraph, handlersOf, isSurface, kindOf, moduleUses, type Graph } from './drilldown.js';
import { columnsOf, stepPathOf } from './flow-layout.js';
import type {
  ArchitectureEdge,
  ArchitectureFlow,
  ArchitectureNode,
  FlowStep,
  NodeKind,
} from './types.js';

export type BlueprintRow = 'customer' | 'frontstage' | 'backstage' | 'support';

export const BLUEPRINT_ROWS: readonly BlueprintRow[] = [
  'customer',
  'frontstage',
  'backstage',
  'support',
];

export const BLUEPRINT_ROW_TEXT: Record<BlueprintRow, string> = {
  customer: '고객 행동',
  frontstage: '프론트스테이지',
  backstage: '백스테이지',
  support: '지원',
};

export const BLUEPRINT_VISIBILITY_TEXT = '가시선';
export const BLUEPRINT_VISIBILITY_NOTE = '위는 고객에게 보이고 아래는 안 보여요';
/** 근거 있는 연결이 없는 칸에 찍는 글자. 비워 두면 그리다 빠뜨린 칸과 구분이 안 된다 */
export const BLUEPRINT_EMPTY_TEXT = '—';

/** 칸 하나에 놓는 것. step은 흐름 단계, node는 지도 노드다. 둘 다 누르면 기존 서랍이 열린다 */
export interface BlueprintItem {
  type: 'step' | 'node';
  id: string;
  /** 이 칸에 들어온 길이 모두 문서로만 확인됐으면 true. 카드 테두리를 점선으로 그린다 */
  docOnly: boolean;
}

export interface BlueprintColumn {
  /** 이 열에 선 정상 흐름 단계 id. 흐름에 적힌 순서다. 갈림길은 뺀다 */
  steps: string[];
  cells: Record<BlueprintRow, BlueprintItem[]>;
}

export interface BlueprintModel {
  flowId: string;
  /** 고객으로 본 행위자. actors의 첫 person이다. 없으면 고객 행동 층이 다 빈다 */
  customer?: string;
  columns: BlueprintColumn[];
  /** 칸을 채우려고 따라간 엣지. 따로 저장하는 그림 파일에 함께 싣는다 */
  edges: string[];
}

export interface BlueprintSource {
  nodes: readonly ArchitectureNode[];
  edges: readonly ArchitectureEdge[];
  drawableNodeIds: ReadonlySet<string>;
  drawableEdgeIds: ReadonlySet<string>;
  drawableStepIds: ReadonlySet<string>;
  drawableTransitionIds: ReadonlySet<string>;
}

export interface BlueprintCounts {
  stages: number;
}

/** 블루프린트 한 장의 예산. 단계 4~6열이 한눈에 읽히는 폭이라 넘으면 경고로 흐름을 나누라고 알린다 */
export const BLUEPRINT_BUDGET: BlueprintCounts = { stages: 6 };

/** 칸 하나에 보이는 카드 수. 넘는 몫은 +N으로 접는다 */
export const BLUEPRINT_CARDS_PER_CELL = 3;

const SUPPORT_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'db_table',
  'datastore',
  'external_service',
  'topic',
  'job',
]);

/** 단계가 가리킨 노드가 어느 층에 서는지. feature와 micro_app은 화면 여럿을 묶은 노드라 한 단계의 칸에 세우지 않고 뺀다 */
function refRow(n: ArchitectureNode): BlueprintRow | undefined {
  if (n.kind === 'screen' || n.kind === 'skill') return 'frontstage';
  if (n.kind === 'endpoint' || n.kind === 'agent') return 'backstage';
  if (n.kind === 'component') {
    const rc = n.renderClass ?? 'service';
    if (rc === 'client' || rc === 'actor') return 'frontstage';
    if (rc === 'queue' || rc === 'store' || rc === 'external') return 'support';
    return 'backstage';
  }
  return undefined;
}

function isSupport(n: ArchitectureNode | undefined): boolean {
  if (n === undefined) return false;
  if (SUPPORT_KINDS.has(n.kind)) return true;
  return (
    n.kind === 'component' &&
    (n.renderClass === 'queue' || n.renderClass === 'store' || n.renderClass === 'external')
  );
}

const docOnlyStep = (s: FlowStep): boolean =>
  s.evidence.every((ev) => ev.type !== 'code' && ev.type !== 'spec');

/** 칸 하나를 모은다. 같은 것이 여러 길로 들어오면 하나로 두고 실선 길이 하나라도 있으면 실선으로 본다 */
class Cell {
  private readonly byId = new Map<string, BlueprintItem>();
  add(type: BlueprintItem['type'], id: string, docOnly: boolean): void {
    const key = `${type}\u0000${id}`;
    const prev = this.byId.get(key);
    if (prev === undefined) this.byId.set(key, { type, id, docOnly });
    else if (!docOnly) prev.docOnly = false;
  }
  list(): BlueprintItem[] {
    return [...this.byId.values()];
  }
}

/**
 * 흐름 하나를 블루프린트 칸으로 나눈다. 열은 정상 흐름 단계의 열이고 행은 층이다.
 * 노드 칸은 단계 refs와 그려지는 엣지만 따라 채운다. 근거 있는 연결이 없으면 칸은 빈다
 */
export function deriveBlueprint(flow: ArchitectureFlow, src: BlueprintSource): BlueprintModel {
  const steps = flow.steps.filter((s) => src.drawableStepIds.has(s.id));
  const stepIds = new Set(steps.map((s) => s.id));
  const transitions = flow.transitions.filter(
    (t) => src.drawableTransitionIds.has(t.id) && stepIds.has(t.from) && stepIds.has(t.to),
  );
  const pathOf = stepPathOf(transitions);
  const { column } = columnsOf(steps, transitions, (id) => pathOf(id) === 'main');
  const kept = steps.filter((s) => s.kind !== 'decision' && pathOf(s.id) === 'main');
  const order = [...new Set(kept.map((s) => column.get(s.id)!))].sort((a, b) => a - b);

  const actorKind = new Map(flow.actors.map((a) => [a.id, a.kind]));
  const customer = flow.actors.find((a) => a.kind === 'person')?.id;
  const g: Graph = buildGraph({
    ir: { nodes: [...src.nodes], edges: [...src.edges] },
    drawableNodeIds: src.drawableNodeIds,
    drawableEdgeIds: src.drawableEdgeIds,
  });
  const walked = new Set<string>();
  const engines = moduleUses(g);

  const columns = order.map((col) => {
    const colSteps = kept.filter((s) => column.get(s.id) === col);
    const cells: Record<BlueprintRow, Cell> = {
      customer: new Cell(),
      frontstage: new Cell(),
      backstage: new Cell(),
      support: new Cell(),
    };
    for (const s of colSteps) {
      const doc = docOnlyStep(s);
      if (s.actor === customer) cells.customer.add('step', s.id, doc);
      else if (actorKind.get(s.actor) === 'person') cells.frontstage.add('step', s.id, doc);
      else cells.backstage.add('step', s.id, doc);
      for (const id of s.refs ?? []) {
        const n = g.nodeById.get(id);
        if (n === undefined) continue;
        const row = refRow(n);
        if (row !== undefined) cells[row].add('node', id, doc);
      }
    }
    const nodeItems = (row: BlueprintRow): BlueprintItem[] =>
      cells[row].list().filter((it) => it.type === 'node');
    const viaEdge = (from: BlueprintItem, e: ArchitectureEdge): boolean =>
      from.docOnly || e.lineStyle === 'dashed';

    // 화면과 스킬, 에이전트가 부르는 API와 MCP 도구는 고객이 못 보는 쪽이다
    for (const from of [...nodeItems('frontstage'), ...nodeItems('backstage')]) {
      if (!isSurface(g, from.id) && kindOf(g, from.id) !== 'agent') continue;
      for (const e of g.edges) {
        if (e.kind !== 'calls' || e.from !== from.id || kindOf(g, e.to) !== 'endpoint') continue;
        cells.backstage.add('node', e.to, viaEdge(from, e));
        walked.add(e.id);
      }
    }

    // 지원은 백스테이지가 기대는 것이다. 엔드포인트를 처리하는 모듈과 그 모듈이 같은 프로세스에서 쓰는 모듈에서 저장소, 외부 서비스, 큐와 잡으로 나간다
    const modules = new Map<string, boolean>();
    const reachModule = (id: string, docOnly: boolean): boolean => {
      const prev = modules.get(id);
      if (prev !== undefined && (prev === false || docOnly)) return false;
      modules.set(id, docOnly);
      return true;
    };
    const queue: string[] = [];
    const sources: BlueprintItem[] = [];
    for (const it of nodeItems('backstage')) {
      if (kindOf(g, it.id) === 'endpoint') {
        for (const h of handlersOf(g, it.id)) {
          walked.add(h.id);
          if (reachModule(h.to, viaEdge(it, h))) queue.push(h.to);
        }
      } else if (kindOf(g, it.id) === 'component') {
        sources.push(it);
      }
    }
    while (queue.length > 0) {
      const at = queue.shift()!;
      const doc = modules.get(at)!;
      for (const u of engines) {
        if (u.from !== at) continue;
        walked.add(u.id);
        if (reachModule(u.to, doc || u.lineStyle === 'dashed')) queue.push(u.to);
      }
    }
    for (const [id, docOnly] of [...modules].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      sources.push({ type: 'node', id, docOnly });
    }
    for (const from of sources) {
      for (const e of g.edges) {
        if (e.from !== from.id || !isSupport(g.nodeById.get(e.to))) continue;
        cells.support.add('node', e.to, viaEdge(from, e));
        walked.add(e.id);
      }
    }
    return {
      steps: colSteps.map((s) => s.id),
      cells: {
        customer: cells.customer.list(),
        frontstage: cells.frontstage.list(),
        backstage: cells.backstage.list(),
        support: cells.support.list(),
      },
    };
  });
  return {
    flowId: flow.id,
    ...(customer !== undefined ? { customer } : {}),
    columns,
    edges: [...walked].sort(),
  };
}

export function blueprintCounts(model: BlueprintModel): BlueprintCounts {
  return { stages: model.columns.length };
}

/** 예산을 넘은 항목을 사람이 읽는 글로. 안 넘었으면 빈 배열이다 */
export function blueprintOverBudget(counts: BlueprintCounts): string[] {
  return counts.stages > BLUEPRINT_BUDGET.stages
    ? [`단계 ${counts.stages}열 (예산 ${BLUEPRINT_BUDGET.stages})`]
    : [];
}

/**
 * 열 머리 글자. 단계에 상태가 있으면 그 상태 이름, 없으면 첫 단계 이름이다.
 * 공유본에서는 가린 흐름을 넘겨 가린 글자가 찍힌다
 */
export function blueprintStageTitle(flow: ArchitectureFlow, col: BlueprintColumn): string {
  const byId = new Map(flow.steps.map((s) => [s.id, s]));
  const steps = col.steps.map((id) => byId.get(id)).filter((s): s is FlowStep => !!s);
  const withState = [...steps].reverse().find((s) => s.state !== undefined);
  if (withState !== undefined) return flow.stateLabels?.[withState.state!] ?? withState.state!;
  return steps[0]?.label ?? '';
}

// 칸 크기는 글자 길이와 무관하게 고정이다. 공유본에서 가린 글자 폭 때문에 그림이 움직이지 않게 하려고다
export const BLUEPRINT_HEAD_W = 120;
export const BLUEPRINT_COL_W = 216;
const COL_GAP = 12;
const STAGE_H = 48;
export const BLUEPRINT_CARD_H = 44;
const CARD_GAP = 8;
const CARD_INSET = 10;
const ROW_PAD = 14;
const MORE_H = 20;
const EMPTY_H = 28;
const LINE_GAP = 16;
const VISIBILITY_GAP = 40;

export type BlueprintLineRole = 'interaction' | 'visibility' | 'internal';

export interface BlueprintCardBox {
  item: BlueprintItem;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BlueprintCellBox {
  row: BlueprintRow;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
  cards: BlueprintCardBox[];
  /** 접은 카드. 접은 것이 없으면 빈 배열이다 */
  hidden: BlueprintItem[];
  moreAt?: { x: number; y: number };
}

export interface BlueprintLayout {
  width: number;
  height: number;
  stages: { x: number; y: number; width: number; height: number }[];
  rows: { row: BlueprintRow; y: number; height: number }[];
  lines: { role: BlueprintLineRole; y: number }[];
  cells: BlueprintCellBox[];
}

function cellContent(items: number): number {
  if (items === 0) return EMPTY_H;
  const shown = Math.min(items, BLUEPRINT_CARDS_PER_CELL);
  return (
    shown * BLUEPRINT_CARD_H +
    (shown - 1) * CARD_GAP +
    (items > BLUEPRINT_CARDS_PER_CELL ? CARD_GAP + MORE_H : 0)
  );
}

/** 격자 좌표. 열은 같은 폭, 행 높이는 그 행에서 가장 많이 찬 칸에 맞춘다 */
export function computeBlueprintLayout(model: BlueprintModel): BlueprintLayout {
  const n = model.columns.length;
  const colX = (i: number): number => BLUEPRINT_HEAD_W + i * (BLUEPRINT_COL_W + COL_GAP);
  const width = BLUEPRINT_HEAD_W + n * BLUEPRINT_COL_W + Math.max(0, n - 1) * COL_GAP;
  const stages = model.columns.map((_, i) => ({
    x: colX(i),
    y: 0,
    width: BLUEPRINT_COL_W,
    height: STAGE_H,
  }));
  const rows: BlueprintLayout['rows'] = [];
  const lines: BlueprintLayout['lines'] = [];
  const cells: BlueprintCellBox[] = [];
  const gapAfter: Partial<Record<BlueprintRow, { role: BlueprintLineRole; gap: number }>> = {
    customer: { role: 'interaction', gap: LINE_GAP },
    frontstage: { role: 'visibility', gap: VISIBILITY_GAP },
    backstage: { role: 'internal', gap: LINE_GAP },
  };
  let y = STAGE_H + 8;
  for (const row of BLUEPRINT_ROWS) {
    const content = Math.max(
      EMPTY_H,
      ...model.columns.map((c) => cellContent(c.cells[row].length)),
    );
    const height = content + ROW_PAD * 2;
    rows.push({ row, y, height });
    model.columns.forEach((c, i) => {
      const items = c.cells[row];
      const x = colX(i);
      const shown = items.slice(0, BLUEPRINT_CARDS_PER_CELL);
      const hidden = items.slice(BLUEPRINT_CARDS_PER_CELL);
      const cards = shown.map((item, k) => ({
        item,
        x: x + CARD_INSET,
        y: y + ROW_PAD + k * (BLUEPRINT_CARD_H + CARD_GAP),
        width: BLUEPRINT_COL_W - CARD_INSET * 2,
        height: BLUEPRINT_CARD_H,
      }));
      cells.push({
        row,
        column: i,
        x,
        y,
        width: BLUEPRINT_COL_W,
        height,
        cards,
        hidden,
        ...(hidden.length > 0
          ? {
              moreAt: {
                x: x + CARD_INSET,
                y: y + ROW_PAD + shown.length * (BLUEPRINT_CARD_H + CARD_GAP),
              },
            }
          : {}),
      });
    });
    y += height;
    const after = gapAfter[row];
    if (after !== undefined) {
      lines.push({ role: after.role, y: y + after.gap / 2 });
      y += after.gap;
    }
  }
  return { width, height: y, stages, rows, lines, cells };
}
