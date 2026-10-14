import type {
  ArchitectureNode,
  ArchitectureProjection,
  Evidence,
  LineStyle,
  NodeColumn,
} from './types.js';

/** 그림 한 장의 예산. type-db-schema의 복잡도 예산(테이블 5, 테이블당 컬럼 8행, 외래 키 6)을 따른다 */
export const ER_BUDGET = { tables: 5, columns: 8, foreignKeys: 6 } as const;
export type ErCounts = Record<keyof typeof ER_BUDGET, number>;

const COUNT_TEXT: Record<keyof ErCounts, string> = {
  tables: '테이블',
  columns: '한 테이블의 컬럼',
  foreignKeys: '외래 키 선',
};

/** 테이블 하나에 보이는 컬럼 행 수. 넘는 몫은 접힘 행 하나로 묶는다 */
export const ER_ROWS_PER_TABLE = ER_BUDGET.columns;

export function erFoldText(n: number): string {
  return `컬럼 ${n}개 더`;
}

/** 테이블 상자의 행 하나. index는 노드 columns 배열 자리라 공유본에서 가린 컬럼 글자와 맞물린다 */
export type ErRow = { type: 'column'; index: number } | { type: 'fold'; indexes: number[] };

export interface ErTable {
  id: string;
  rows: ErRow[];
  /** 이 테이블에 적힌 컬럼 수. 접힌 것도 센다 */
  total: number;
}

export interface ErLink {
  /** `<테이블 id>:<컬럼 이름>`. 같은 테이블에 같은 이름의 컬럼은 스키마가 막는다 */
  id: string;
  from: string;
  fromIndex: number;
  to: string;
  /** 대상 컬럼 자리. 대상 컬럼을 모르거나 대상이 컬럼을 안 적었으면 없고 선은 테이블 머리에 붙는다 */
  toIndex?: number;
  lineStyle: LineStyle;
  /** 근거가 있는 외래 키만 선이 되니 여기 있으면 근거 있는 ON DELETE다 */
  onDelete?: string;
}

export interface ErModel {
  tables: ErTable[];
  links: ErLink[];
}

export interface ErSource {
  nodes: readonly ArchitectureNode[];
  drawableNodeIds: ReadonlySet<string>;
}

// 엣지 실선 판정(validator의 deriveLineStyle)과 같은 기준이다. validator가 이 파일을 불러 순환을 피하려고 따로 둔다
function columnLineStyle(evidence: readonly Evidence[]): LineStyle {
  return evidence.some((e) => e.type === 'code' || e.type === 'spec') ? 'solid' : 'dashed';
}

/** 근거가 하나도 없는 외래 키. 선을 긋지 않고 질문으로 돌린다 */
export function isUnconfirmedFk(column: NodeColumn): boolean {
  return column.references !== undefined && (column.evidence ?? []).length === 0;
}

/**
 * er 그림 모델. participants 중 그려지는 db_table만 테이블로 세우고 외래 키는 양 끝 테이블이 모두 그림에 있을 때만 선이 된다.
 * 컬럼이 행 수를 넘으면 PK와 외래 키에 걸린 컬럼을 먼저 남기고 나머지를 접는다. 선이 붙을 행이 접히지 않게 하려는 것이다
 */
export function deriveEr(projection: ArchitectureProjection, src: ErSource): ErModel {
  const byId = new Map(src.nodes.map((n) => [n.id, n]));
  const ids = [...new Set(projection.participants ?? [])].filter((id) => {
    const n = byId.get(id);
    return n !== undefined && n.kind === 'db_table' && src.drawableNodeIds.has(id);
  });
  const drawn = new Set(ids);
  const links: ErLink[] = [];
  for (const id of ids) {
    (byId.get(id)!.columns ?? []).forEach((c, fromIndex) => {
      const ref = c.references;
      if (ref === undefined || isUnconfirmedFk(c) || !drawn.has(ref.table)) return;
      const target = byId.get(ref.table)!;
      const toIndex =
        ref.column !== undefined
          ? (target.columns ?? []).findIndex((tc) => tc.name === ref.column)
          : -1;
      links.push({
        id: `${id}:${c.name}`,
        from: id,
        fromIndex,
        to: ref.table,
        ...(toIndex >= 0 ? { toIndex } : {}),
        lineStyle: columnLineStyle(c.evidence ?? []),
        ...(ref.onDelete !== undefined ? { onDelete: ref.onDelete } : {}),
      });
    });
  }
  const tables = ids.map((id) => {
    const columns = byId.get(id)!.columns ?? [];
    const keyed = new Set<number>();
    columns.forEach((c, i) => {
      if (c.pk === true) keyed.add(i);
    });
    for (const l of links) {
      if (l.from === id) keyed.add(l.fromIndex);
      if (l.to === id && l.toIndex !== undefined) keyed.add(l.toIndex);
    }
    const order = columns.map((_, i) => i);
    const picked = new Set(
      [...order.filter((i) => keyed.has(i)), ...order.filter((i) => !keyed.has(i))].slice(
        0,
        ER_ROWS_PER_TABLE,
      ),
    );
    const rows: ErRow[] = order
      .filter((i) => picked.has(i))
      .map((index) => ({ type: 'column', index }));
    const folded = order.filter((i) => !picked.has(i));
    if (folded.length > 0) rows.push({ type: 'fold', indexes: folded });
    return { id, rows, total: columns.length };
  });
  return { tables, links };
}

export function erCounts(model: ErModel): ErCounts {
  return {
    tables: model.tables.length,
    columns: Math.max(0, ...model.tables.map((t) => t.total)),
    foreignKeys: model.links.length,
  };
}

export function erOverBudget(counts: ErCounts): string[] {
  return (Object.keys(ER_BUDGET) as (keyof ErCounts)[])
    .filter((k) => counts[k] > ER_BUDGET[k])
    .map((k) => `${COUNT_TEXT[k]} ${counts[k]}개 (예산 ${ER_BUDGET[k]})`);
}

// 상자 폭과 행 높이는 글자와 무관하게 고정이다. 선이 붙는 자리를 행 번호만으로 정하고 공유본에서 가린 글자 폭에 그림이 흔들리지 않게 하려고다
export const ER_TABLE_W = 280;
export const ER_HEAD_H = 40;
export const ER_ROW_H = 24;
const PAD_B = 6;
const LAYER_GAP = 220;
const TABLE_GAP = 36;
const CHANNEL_STEP = 10;
// 통로 세로 토막을 도착 쪽 변에서 이만큼 띄운다. 출발 쪽 가로 토막을 길게 남겨 ON DELETE 글자가 세로 토막에 안 걸리게 한다
const CHANNEL_IN = 40;
const SAME_OUT = 22;
const TOP_LANE = 24;
const TOP_STEP = 10;
const ARROW = 8;
const LABEL_GAP = 6;

export interface ErTableBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ErRoute {
  id: string;
  /** 꺾은선 꼭짓점. 첫 점은 출발 컬럼 행, 끝 점은 대상 행이나 머리의 상자 가장자리다 */
  points: { x: number; y: number }[];
  /** 화살촉 세 점. 끝점, 날개 둘 */
  tip: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  label?: { x: number; y: number; anchor: 'start' | 'end' };
}

export interface ErLayout {
  width: number;
  height: number;
  tables: ErTableBox[];
  routes: ErRoute[];
}

export function erTableHeight(t: ErTable): number {
  return ER_HEAD_H + Math.max(1, t.rows.length) * ER_ROW_H + PAD_B;
}

function rowOf(t: ErTable, index: number | undefined): number | undefined {
  if (index === undefined) return undefined;
  const at = t.rows.findIndex((r) =>
    r.type === 'column' ? r.index === index : r.indexes.includes(index),
  );
  return at >= 0 ? at : undefined;
}

/**
 * 층은 참조되는 쪽이 왼쪽이다. 외래 키가 가리키는 테이블보다 한 층 오른쪽에 선다.
 * 순환은 먼저 들어간 쪽에서 끊어 같은 입력이면 같은 층이 나온다
 */
function layersOf(model: ErModel): Map<string, number> {
  const targets = new Map<string, string[]>();
  for (const l of model.links) {
    if (l.from === l.to) continue;
    const list = targets.get(l.from) ?? [];
    list.push(l.to);
    targets.set(l.from, list);
  }
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let v = 0;
    for (const to of targets.get(id) ?? []) v = Math.max(v, visit(to) + 1);
    visiting.delete(id);
    layer.set(id, v);
    return v;
  };
  for (const t of model.tables) visit(t.id);
  return layer;
}

export function computeErLayout(model: ErModel): ErLayout {
  const layer = layersOf(model);
  const byLayer = new Map<number, ErTable[]>();
  for (const t of model.tables) {
    const l = layer.get(t.id)!;
    const list = byLayer.get(l) ?? [];
    list.push(t);
    byLayer.set(l, list);
  }
  const tableById = new Map(model.tables.map((t) => [t.id, t]));
  const layerOf = (id: string): number => layer.get(id)!;
  // 층을 건너뛰는 선은 사이 층 상자를 가로지르지 않게 그림 위 통로로 돌린다. 그 통로 자리를 먼저 비워 둔다
  const skips = model.links.filter((l) => Math.abs(layerOf(l.from) - layerOf(l.to)) > 1);
  const top = skips.length > 0 ? TOP_LANE + (skips.length - 1) * TOP_STEP : 0;
  const boxes = new Map<string, ErTableBox>();
  let width = 0;
  let height = top;
  for (const l of [...byLayer.keys()].sort((a, b) => a - b)) {
    let y = top;
    const x = l * (ER_TABLE_W + LAYER_GAP);
    for (const t of byLayer.get(l)!) {
      const h = erTableHeight(t);
      boxes.set(t.id, { id: t.id, x, y, width: ER_TABLE_W, height: h });
      y += h + TABLE_GAP;
    }
    width = Math.max(width, x + ER_TABLE_W);
    height = Math.max(height, y - TABLE_GAP);
  }

  const anchorY = (id: string, index: number | undefined): number => {
    const b = boxes.get(id)!;
    const row = rowOf(tableById.get(id)!, index);
    return row === undefined
      ? b.y + ER_HEAD_H / 2
      : b.y + ER_HEAD_H + row * ER_ROW_H + ER_ROW_H / 2;
  };
  // 한 행에 선 여럿이 붙으면 한 점에 모이지 않게 행 안에서 위아래로 나눈다
  const endKey = (l: ErLink): string =>
    `${l.to}\u0000${rowOf(tableById.get(l.to)!, l.toIndex) ?? 'head'}`;
  const endCount = new Map<string, number>();
  for (const l of model.links) endCount.set(endKey(l), (endCount.get(endKey(l)) ?? 0) + 1);
  const endSeen = new Map<string, number>();
  const endShift = (l: ErLink): number => {
    const key = endKey(l);
    const n = endCount.get(key)!;
    const k = endSeen.get(key) ?? 0;
    endSeen.set(key, k + 1);
    if (n === 1) return 0;
    const span = Math.min(ER_ROW_H - 8, (n - 1) * 6);
    return -span / 2 + (span * k) / (n - 1);
  };
  const sameSeen = new Map<number, number>();
  const ysOf = model.links.map((l) => anchorY(l.from, l.fromIndex));
  const ytOf = model.links.map((l) => anchorY(l.to, l.toIndex) + endShift(l));
  let skipSeen = 0;
  const laneOf = model.links.map((l) =>
    Math.abs(layerOf(l.from) - layerOf(l.to)) > 1 ? top - TOP_LANE / 2 - skipSeen++ * TOP_STEP : 0,
  );
  // 통로마다 세로 토막 자리를 먼저 나눈다. 출발 쪽에 가까운 자리부터 위로 가는 선은 출발 행이 위인 순,
  // 아래로 가는 선은 출발 행이 아래인 순으로 주면 가로 토막과 세로 토막이 엇갈리지 않는다
  const uses = new Map<string, { i: number; ys: number; yt: number }[]>();
  const use = (gap: number, toLeft: boolean, i: number, ys: number, yt: number): void => {
    const key = `${gap}:${toLeft ? 'l' : 'r'}`;
    const list = uses.get(key) ?? [];
    list.push({ i, ys, yt });
    uses.set(key, list);
  };
  model.links.forEach((l, i) => {
    const ls = layerOf(l.from);
    const lt = layerOf(l.to);
    if (ls === lt) return;
    const toLeft = ls > lt;
    if (Math.abs(ls - lt) === 1) {
      use(Math.min(ls, lt), toLeft, i, ysOf[i]!, ytOf[i]!);
      return;
    }
    use(toLeft ? ls - 1 : ls, toLeft, i, ysOf[i]!, laneOf[i]!);
    use(toLeft ? lt : lt - 1, toLeft, i, laneOf[i]!, ytOf[i]!);
  });
  const cxOf = new Map<string, number>();
  for (const [key, list] of uses) {
    const [gapText, side] = key.split(':') as [string, string];
    const left = Number(gapText) * (ER_TABLE_W + LAYER_GAP) + ER_TABLE_W;
    const up = list.filter((u) => u.yt < u.ys).sort((a, b) => a.ys - b.ys);
    const down = list.filter((u) => u.yt >= u.ys).sort((a, b) => b.ys - a.ys);
    const ordered = [...up, ...down];
    const n = ordered.length;
    const step = n > 1 ? Math.min(CHANNEL_STEP, (LAYER_GAP - 2 * CHANNEL_IN) / (n - 1)) : 0;
    ordered.forEach((u, k) => {
      const fromTarget = CHANNEL_IN + (n - 1 - k) * step;
      cxOf.set(`${key}:${u.i}`, side === 'l' ? left + fromTarget : left + LAYER_GAP - fromTarget);
    });
  }
  const cx = (gap: number, toLeft: boolean, i: number): number =>
    cxOf.get(`${gap}:${toLeft ? 'l' : 'r'}:${i}`)!;

  const routes: ErRoute[] = model.links.map((l, i) => {
    const s = boxes.get(l.from)!;
    const t = boxes.get(l.to)!;
    const ys = ysOf[i]!;
    const yt = ytOf[i]!;
    const ls = layerOf(l.from);
    const lt = layerOf(l.to);
    let points: { x: number; y: number }[];
    let dir: 1 | -1;
    let label: ErRoute['label'];
    if (ls === lt) {
      // 같은 층(자기 참조 포함)은 오른쪽으로 나갔다가 대상 상자 오른쪽으로 들어온다
      const k = sameSeen.get(ls) ?? 0;
      sameSeen.set(ls, k + 1);
      const ox = Math.max(s.x, t.x) + ER_TABLE_W + SAME_OUT + k * CHANNEL_STEP;
      points = [
        { x: s.x + ER_TABLE_W, y: ys },
        { x: ox, y: ys },
        { x: ox, y: yt },
        { x: t.x + ER_TABLE_W, y: yt },
      ];
      dir = -1;
      label = { x: s.x + ER_TABLE_W + LABEL_GAP, y: ys - LABEL_GAP, anchor: 'start' };
    } else if (ls > lt) {
      // 자식이 오른쪽, 부모가 왼쪽이다. 자식 왼쪽 변에서 나가 부모 오른쪽 변으로 들어간다
      const sx = s.x;
      const tx = t.x + ER_TABLE_W;
      if (ls - lt === 1) {
        const c = cx(lt, true, i);
        points = [
          { x: sx, y: ys },
          { x: c, y: ys },
          { x: c, y: yt },
          { x: tx, y: yt },
        ];
      } else {
        const lane = laneOf[i]!;
        const c1 = cx(ls - 1, true, i);
        const c2 = cx(lt, true, i);
        points = [
          { x: sx, y: ys },
          { x: c1, y: ys },
          { x: c1, y: lane },
          { x: c2, y: lane },
          { x: c2, y: yt },
          { x: tx, y: yt },
        ];
      }
      dir = -1;
      label = { x: sx - LABEL_GAP, y: ys - LABEL_GAP, anchor: 'end' };
    } else {
      // 순환을 끊은 쪽이라 자식이 왼쪽에 선다. 자식 오른쪽 변에서 나가 부모 왼쪽 변으로 들어간다
      const sx = s.x + ER_TABLE_W;
      const tx = t.x;
      if (lt - ls === 1) {
        const c = cx(ls, false, i);
        points = [
          { x: sx, y: ys },
          { x: c, y: ys },
          { x: c, y: yt },
          { x: tx, y: yt },
        ];
      } else {
        const lane = laneOf[i]!;
        const c1 = cx(ls, false, i);
        const c2 = cx(lt - 1, false, i);
        points = [
          { x: sx, y: ys },
          { x: c1, y: ys },
          { x: c1, y: lane },
          { x: c2, y: lane },
          { x: c2, y: yt },
          { x: tx, y: yt },
        ];
      }
      dir = 1;
      label = { x: sx + LABEL_GAP, y: ys - LABEL_GAP, anchor: 'start' };
    }
    const end = points[points.length - 1]!;
    const tip: ErRoute['tip'] = [
      { x: end.x, y: end.y },
      { x: end.x - dir * ARROW, y: end.y - ARROW / 2 },
      { x: end.x - dir * ARROW, y: end.y + ARROW / 2 },
    ];
    return {
      id: l.id,
      points,
      tip,
      ...(l.onDelete !== undefined ? { label } : {}),
    };
  });
  // 같은 층 선은 상자 오른쪽으로 나가므로 그만큼 폭을 늘린다
  const rightmost = Math.max(width, ...routes.flatMap((r) => r.points.map((p) => p.x)));
  return {
    width: rightmost + (rightmost > width ? 16 : 0),
    height,
    tables: [...boxes.values()],
    routes,
  };
}
