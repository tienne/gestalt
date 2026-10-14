import { NODE_KIND_SHORT } from './kind-text.js';
import { assignStages } from './layout.js';
import { ALL_PACKS_VOCABULARY } from './packs/index.js';
import type { ArchitectureEdge, ArchitectureIr, ArchitectureNode, NodeColumn } from './types.js';
import { displayKindOf } from './types.js';

export type DeltaChange = 'ADDED' | 'REMOVED' | 'CHANGED' | 'MOVED' | 'REWIRED';

/** 원장 정렬 순서. 대상 id보다 먼저 본다 */
export const DELTA_CHANGES: readonly DeltaChange[] = [
  'ADDED',
  'REMOVED',
  'CHANGED',
  'MOVED',
  'REWIRED',
];

/** 그림 한 장의 한쪽. 그려지는 것만 비교해야 화면에 없던 노드가 "생겼다"로 잡히지 않는다 */
export interface DeltaSnapshot {
  ir: ArchitectureIr;
  nodeIds: ReadonlySet<string>;
  edgeIds: ReadonlySet<string>;
}

export interface DeltaNode {
  id: string;
  before?: ArchitectureNode;
  after?: ArchitectureNode;
  changes: DeltaChange[];
}

export interface DeltaEdge {
  /** 원장 대상 id. 다시 이은 엣지는 이번 쪽 id다 */
  id: string;
  before?: ArchitectureEdge;
  after?: ArchitectureEdge;
  changes: DeltaChange[];
}

export interface DeltaEntry {
  change: DeltaChange;
  target: string;
  object: 'node' | 'edge';
  /** 대문자 변경어 뒤에 붙는 설명 */
  text: string;
}

export interface ArchitectureDelta {
  before: DeltaSnapshot;
  after: DeltaSnapshot;
  /** 두 쪽 합집합. id 순 */
  nodes: DeltaNode[];
  edges: DeltaEdge[];
  ledger: DeltaEntry[];
}

/** 참고 자료의 한 장 예산. 남는 id는 한 번만 센다 */
export const DELTA_BUDGET = { components: 8, relationships: 10, ledger: 8 } as const;

export type DeltaCounts = Record<keyof typeof DELTA_BUDGET, number>;

const COUNT_TEXT: Record<keyof DeltaCounts, string> = {
  components: '구성 요소',
  relationships: '관계',
  ledger: '변경 목록',
};

type NodeAttr =
  | 'kind'
  | 'displayName'
  | 'description'
  | 'displayKind'
  | 'protocol'
  | 'mcpServer'
  | 'actions'
  | 'environment'
  | 'engine'
  | 'platforms';

// label은 병합 키라 바뀌면 다른 노드다. 여기 없는 필드는 그림의 구조를 바꾸지 않는다
const CHANGED_ATTRS: ReadonlyArray<[NodeAttr, string]> = [
  ['kind', '종류'],
  ['displayName', '표시 이름'],
  ['description', '설명'],
  ['displayKind', '종류 표시'],
  ['protocol', '프로토콜'],
  ['mcpServer', 'MCP 서버'],
  ['actions', '동작'],
  ['environment', '환경'],
  ['engine', '엔진'],
  ['platforms', '플랫폼'],
];

const VALUE_MAX = 28;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function nameOf(node: ArchitectureNode): string {
  return node.displayName ?? node.label;
}

function clip(text: string): string {
  const chars = [...text];
  return chars.length > VALUE_MAX ? `${chars.slice(0, VALUE_MAX - 1).join('')}…` : text;
}

function valueText(v: unknown): string {
  if (v === undefined || v === '') return '없음';
  if (Array.isArray(v)) return v.length === 0 ? '없음' : clip(v.join(', '));
  return `"${clip(String(v))}"`;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * 컬럼은 이름으로 맞춘다. 원장 한 줄이 길어지지 않게 생긴 것과 빠진 것, 바뀐 것을 이름만 적는다.
 * 근거만 달라진 건 그림의 구조가 아니라서 세지 않는다. 다만 외래 키 근거가 생기거나 사라지면 선이 바뀌니 센다
 */
function columnDiffs(b: ArchitectureNode, a: ArchitectureNode): string[] {
  const shape = (c: NodeColumn): string =>
    JSON.stringify([
      c.type ?? null,
      c.pk ?? null,
      c.nullable ?? null,
      c.unique ?? null,
      c.references?.table ?? null,
      c.references?.column ?? null,
      c.references?.onDelete ?? null,
      c.references !== undefined && (c.evidence ?? []).length > 0,
    ]);
  const before = new Map((b.columns ?? []).map((c) => [c.name, c]));
  const after = new Map((a.columns ?? []).map((c) => [c.name, c]));
  const added = [...after.keys()].filter((n) => !before.has(n));
  const removed = [...before.keys()].filter((n) => !after.has(n));
  const changed = [...after.keys()].filter(
    (n) => before.has(n) && shape(before.get(n)!) !== shape(after.get(n)!),
  );
  const list = (names: string[]): string => clip(names.join(', '));
  return [
    ...(added.length > 0 ? [`컬럼 ${list(added)} 생김`] : []),
    ...(removed.length > 0 ? [`컬럼 ${list(removed)} 빠짐`] : []),
    ...(changed.length > 0 ? [`컬럼 ${list(changed)} 바뀜`] : []),
  ];
}

function kindShort(node: ArchitectureNode): string {
  return node.kind === 'component' && node.displayKind !== undefined
    ? node.displayKind
    : NODE_KIND_SHORT[displayKindOf(node)];
}

function edgeKindText(kind: string): string {
  return ALL_PACKS_VOCABULARY.edgeKinds[kind]?.text ?? kind;
}

function drawnNodes(s: DeltaSnapshot): Map<string, ArchitectureNode> {
  return new Map(s.ir.nodes.filter((n) => s.nodeIds.has(n.id)).map((n) => [n.id, n]));
}

function drawnEdges(s: DeltaSnapshot): Map<string, ArchitectureEdge> {
  return new Map(s.ir.edges.filter((e) => s.edgeIds.has(e.id)).map((e) => [e.id, e]));
}

/**
 * 이전 그림과 이번 그림을 id로 맞춰 바뀐 것을 뽑는다.
 * render가 병합으로 이전 id를 물려준 뒤라 같은 것은 같은 id다. label이 병합 키라 이름을 바꾸면 빠짐과 생김 두 건이 된다.
 */
export function computeArchitectureDelta(
  before: DeltaSnapshot,
  after: DeltaSnapshot,
): ArchitectureDelta {
  const bNodes = drawnNodes(before);
  const aNodes = drawnNodes(after);
  const bEdges = drawnEdges(before);
  const aEdges = drawnEdges(after);
  const bStages = stageLabels(before.ir);
  const aStages = stageLabels(after.ir);
  const nameIn = (nodes: Map<string, ArchitectureNode>, ir: ArchitectureIr) => {
    const all = new Map(ir.nodes.map((x) => [x.id, x]));
    return (id: string | undefined): string => {
      if (id === undefined) return '없음';
      const n = nodes.get(id) ?? all.get(id);
      return `"${clip(n !== undefined ? nameOf(n) : id)}"`;
    };
  };
  const bName = nameIn(bNodes, before.ir);
  const aName = nameIn(aNodes, after.ir);

  const ledger: DeltaEntry[] = [];
  const nodes: DeltaNode[] = [];
  for (const id of [...new Set([...bNodes.keys(), ...aNodes.keys()])].sort(cmp)) {
    const b = bNodes.get(id);
    const a = aNodes.get(id);
    const changes: DeltaChange[] = [];
    if (b === undefined && a !== undefined) {
      changes.push('ADDED');
      ledger.push({
        change: 'ADDED',
        target: id,
        object: 'node',
        text: `${kindShort(a)} "${nameOf(a)}" 생김`,
      });
    } else if (a === undefined && b !== undefined) {
      changes.push('REMOVED');
      ledger.push({
        change: 'REMOVED',
        target: id,
        object: 'node',
        text: `${kindShort(b)} "${nameOf(b)}" 빠짐`,
      });
    } else if (a !== undefined && b !== undefined) {
      const diffs = [
        ...CHANGED_ATTRS.filter(([k]) => !sameValue(b[k], a[k])).map(
          ([k, text]) => `${text} ${valueText(b[k])} → ${valueText(a[k])}`,
        ),
        ...columnDiffs(b, a),
      ];
      if (diffs.length > 0) {
        changes.push('CHANGED');
        ledger.push({
          change: 'CHANGED',
          target: id,
          object: 'node',
          text: `"${nameOf(a)}" ${diffs.join(', ')}`,
        });
      }
      const moves: string[] = [];
      if (b.parent !== a.parent) moves.push(`부모 ${bName(b.parent)} → ${aName(a.parent)}`);
      if (b.account !== a.account) moves.push(`계정 ${bName(b.account)} → ${aName(a.account)}`);
      const bStage = bStages.get(id);
      const aStage = aStages.get(id);
      if (bStage !== undefined && aStage !== undefined && bStage !== aStage) {
        moves.push(`구간 "${bStage}" → "${aStage}"`);
      }
      if (moves.length > 0) {
        changes.push('MOVED');
        ledger.push({
          change: 'MOVED',
          target: id,
          object: 'node',
          text: `"${nameOf(a)}" ${moves.join(', ')}`,
        });
      }
    }
    nodes.push({ id, ...(b ? { before: b } : {}), ...(a ? { after: a } : {}), changes });
  }

  const edges = diffEdges(bEdges, aEdges);
  for (const e of edges) {
    const b = e.before;
    const a = e.after;
    const kindText = edgeKindText((a ?? b)!.kind);
    const span = (edge: ArchitectureEdge, name: (id: string) => string): string =>
      `${name(edge.from)} → ${name(edge.to)}`;
    for (const change of e.changes) {
      let text: string;
      if (change === 'ADDED') text = `${kindText} 연결 ${span(a!, aName)} 생김`;
      else if (change === 'REMOVED') text = `${kindText} 연결 ${span(b!, bName)} 빠짐`;
      else if (change === 'REWIRED')
        text = `${kindText} 연결 ${span(b!, bName)} 대신 ${span(a!, aName)}`;
      else {
        const diffs: string[] = [];
        if (b!.kind !== a!.kind) diffs.push(`종류 ${edgeKindText(b!.kind)} → ${kindText}`);
        if (!sameValue(b!.actions, a!.actions))
          diffs.push(`동작 ${valueText(b!.actions)} → ${valueText(a!.actions)}`);
        text = `연결 ${span(a!, aName)} ${diffs.join(', ')}`;
      }
      ledger.push({ change, target: e.id, object: 'edge', text });
    }
  }

  ledger.sort(
    (x, y) =>
      DELTA_CHANGES.indexOf(x.change) - DELTA_CHANGES.indexOf(y.change) ||
      (x.object === y.object ? 0 : x.object === 'node' ? -1 : 1) ||
      cmp(x.target, y.target),
  );
  return { before, after, nodes, edges, ledger };
}

function stageLabels(ir: ArchitectureIr): Map<string, string> {
  const staged = assignStages(ir);
  const out = new Map<string, string>();
  if (staged === undefined) return out;
  for (const [id, i] of staged.indexOf) out.set(id, staged.labels[i]!);
  return out;
}

/**
 * 엣지는 병합이 (from, to, kind)로 id를 물려주므로 끝점이 바뀐 엣지는 보통 id가 다르다.
 * 같은 kind의 빠진 엣지와 생긴 엣지가 한쪽 끝을 같은 자리에서 공유하고 서로 하나씩만 맞으면 다시 이은 것으로 본다.
 * 짝이 여럿이면 어느 선이 어디로 갔는지 단정할 수 없어 빠짐과 생김으로 둔다
 */
function diffEdges(
  bEdges: Map<string, ArchitectureEdge>,
  aEdges: Map<string, ArchitectureEdge>,
): DeltaEdge[] {
  const out: DeltaEdge[] = [];
  const removed: ArchitectureEdge[] = [];
  const added: ArchitectureEdge[] = [];
  for (const id of [...new Set([...bEdges.keys(), ...aEdges.keys()])].sort(cmp)) {
    const b = bEdges.get(id);
    const a = aEdges.get(id);
    if (b === undefined) {
      added.push(a!);
      continue;
    }
    if (a === undefined) {
      removed.push(b);
      continue;
    }
    const changes: DeltaChange[] = [];
    if (b.kind !== a.kind || !sameValue(b.actions, a.actions)) changes.push('CHANGED');
    // 다음 실행이 우연히 같은 id를 다른 선에 매기면 id는 남고 끝점만 바뀐다
    if (b.from !== a.from || b.to !== a.to) changes.push('REWIRED');
    out.push({ id, before: b, after: a, changes });
  }
  const removedIx = indexEnds(removed);
  const addedIx = indexEnds(added);
  const pairedRemoved = new Set<string>();
  const pairedAdded = new Set<string>();
  for (const a of added) {
    const cands = sharingOne(removedIx, a);
    if (cands.length !== 1) continue;
    const r = cands[0]!;
    if (sharingOne(addedIx, r).length !== 1) continue;
    pairedRemoved.add(r.id);
    pairedAdded.add(a.id);
    const changes: DeltaChange[] = sameValue(r.actions, a.actions)
      ? ['REWIRED']
      : ['CHANGED', 'REWIRED'];
    out.push({ id: a.id, before: r, after: a, changes });
  }
  for (const r of removed) {
    if (!pairedRemoved.has(r.id)) out.push({ id: r.id, before: r, changes: ['REMOVED'] });
  }
  for (const a of added) {
    if (!pairedAdded.has(a.id)) out.push({ id: a.id, after: a, changes: ['ADDED'] });
  }
  return out.sort((x, y) => cmp(x.id, y.id));
}

interface EndIndex {
  byFrom: Map<string, ArchitectureEdge[]>;
  byTo: Map<string, ArchitectureEdge[]>;
}

function indexEnds(edges: ArchitectureEdge[]): EndIndex {
  const byFrom = new Map<string, ArchitectureEdge[]>();
  const byTo = new Map<string, ArchitectureEdge[]>();
  const put = (m: Map<string, ArchitectureEdge[]>, key: string, e: ArchitectureEdge): void => {
    const list = m.get(key);
    if (list === undefined) m.set(key, [e]);
    else list.push(e);
  };
  for (const e of edges) {
    put(byFrom, `${e.kind}|${e.from}`, e);
    put(byTo, `${e.kind}|${e.to}`, e);
  }
  return { byFrom, byTo };
}

/** 같은 kind에서 from과 to 중 정확히 한쪽 끝만 e와 같은 엣지 */
function sharingOne(ix: EndIndex, e: ArchitectureEdge): ArchitectureEdge[] {
  const sameFrom = (ix.byFrom.get(`${e.kind}|${e.from}`) ?? []).filter((x) => x.to !== e.to);
  const sameTo = (ix.byTo.get(`${e.kind}|${e.to}`) ?? []).filter((x) => x.from !== e.from);
  return [...sameFrom, ...sameTo];
}

export interface DeltaScope {
  nodeIds: Set<string>;
  /** DeltaEdge id */
  edgeIds: Set<string>;
  /** 전체가 예산을 넘어 바뀐 노드와 그 이웃만 남겼으면 true */
  scoped: boolean;
  /** 좁히기 전 합집합 크기 */
  total: { components: number; relationships: number };
}

/**
 * 그릴 범위. 합집합이 예산 안이면 전부 그린다. 넘으면 바뀐 노드와 바뀐 엣지의 끝, 그 1홉 이웃만 남긴다.
 * 바뀌지 않은 먼 노드까지 그리면 큰 그림에서 변경이 묻힌다
 */
export function deltaScope(delta: ArchitectureDelta): DeltaScope {
  const all = new Set(delta.nodes.map((n) => n.id));
  const total = { components: all.size, relationships: delta.edges.length };
  if (
    total.components <= DELTA_BUDGET.components &&
    total.relationships <= DELTA_BUDGET.relationships
  ) {
    return { nodeIds: all, edgeIds: new Set(delta.edges.map((e) => e.id)), scoped: false, total };
  }
  const core = new Set(delta.nodes.filter((n) => n.changes.length > 0).map((n) => n.id));
  for (const e of delta.edges) {
    if (e.changes.length === 0) continue;
    for (const end of endsOf(e)) core.add(end);
  }
  const keep = new Set(core);
  for (const e of delta.edges) {
    const ends = endsOf(e);
    if (ends.some((id) => core.has(id))) for (const id of ends) keep.add(id);
  }
  const edgeIds = new Set(
    delta.edges.filter((e) => endsOf(e).every((id) => keep.has(id))).map((e) => e.id),
  );
  return { nodeIds: keep, edgeIds, scoped: true, total };
}

function endsOf(e: DeltaEdge): string[] {
  return [
    ...new Set([
      ...(e.before ? [e.before.from, e.before.to] : []),
      ...(e.after ? [e.after.from, e.after.to] : []),
    ]),
  ];
}

export function deltaCounts(delta: ArchitectureDelta, scope: DeltaScope): DeltaCounts {
  return {
    components: scope.nodeIds.size,
    relationships: scope.edgeIds.size,
    ledger: delta.ledger.length,
  };
}

export function deltaOverBudget(counts: DeltaCounts): string[] {
  return (Object.keys(DELTA_BUDGET) as (keyof DeltaCounts)[])
    .filter((k) => counts[k] > DELTA_BUDGET[k])
    .map((k) => `${COUNT_TEXT[k]} ${counts[k]}개 (예산 ${DELTA_BUDGET[k]})`);
}
