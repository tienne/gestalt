import { HARNESS_PACK } from './harness.js';
import type {
  DrilldownStrategy,
  EdgeKindDef,
  KindLook,
  LaneDef,
  NodeKindDef,
  VocabularyPack,
} from './types.js';
import { WEB_PRODUCT_PACK } from './web-product.js';

export * from './types.js';

/** 내장 팩. 이 순서로 표를 합친다. 새 팩은 뒤에 붙여야 기존 팩 표의 순서가 안 바뀐다 */
export const BUILTIN_PACKS = [WEB_PRODUCT_PACK, HARNESS_PACK] as const;

type BuiltinPack = (typeof BUILTIN_PACKS)[number];
type KeysOf<P, F extends 'nodeKinds' | 'edgeKinds' | 'lanes' | 'displayKinds'> = P extends {
  [K in F]: infer R;
}
  ? keyof R & string
  : never;
export type PackNodeKind = KeysOf<BuiltinPack, 'nodeKinds'>;
export type PackEdgeKind = KeysOf<BuiltinPack, 'edgeKinds'>;
export type PackLaneId = KeysOf<BuiltinPack, 'lanes'>;
export type PackDisplayKind = KeysOf<BuiltinPack, 'displayKinds'>;
export type PackId = BuiltinPack['id'];

/** packs를 안 적은 IR이 쓰는 팩. 팩을 나누기 전 어휘 전부라 옛 IR이 그대로 읽힌다 */
export const LEGACY_PACK_IDS: readonly PackId[] = ['web-product', 'harness'];

const PACK_BY_ID: ReadonlyMap<string, VocabularyPack> = new Map(
  BUILTIN_PACKS.map((p) => [p.id, p as VocabularyPack]),
);

export function packById(id: string): VocabularyPack | undefined {
  return PACK_BY_ID.get(id);
}

/** 팩 여럿을 합친 어휘. 표의 키 순서는 BUILTIN_PACKS 순서, 그 안에서는 팩에 적은 순서다 */
export interface Vocabulary {
  /** 해석한 팩 id. requires까지 펼친 BUILTIN_PACKS 순서다 */
  packIds: string[];
  nodeKinds: Record<string, NodeKindDef>;
  displayKinds: Record<string, KindLook>;
  /** nodeKinds와 displayKinds를 팩 순서대로 섞은 것. 칩과 범례, 색, 아이콘이 이걸 본다 */
  looks: Record<string, KindLook>;
  lanes: Record<string, LaneDef>;
  edgeKinds: Record<string, EdgeKindDef>;
  /** 쓰는 팩 중 web-product 드릴다운이 하나라도 있으면 web-product, 아니면 첫 팩 것이다 */
  drilldown: DrilldownStrategy;
  matchers: string[];
}

/** 모르는 팩 id는 건너뛴다. 검증은 validator가 따로 한다 */
export function resolvePackIds(ids: readonly string[]): string[] {
  const want = new Set<string>();
  const visit = (id: string): void => {
    const p = PACK_BY_ID.get(id);
    if (p === undefined || want.has(id)) return;
    want.add(id);
    for (const r of p.requires ?? []) visit(r);
  };
  for (const id of ids) visit(id);
  return BUILTIN_PACKS.map((p) => p.id as string).filter((id) => want.has(id));
}

const cache = new Map<string, Vocabulary>();

export function vocabularyOf(ids: readonly string[] = LEGACY_PACK_IDS): Vocabulary {
  const packIds = resolvePackIds(ids);
  const key = packIds.join(',');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const v: Vocabulary = {
    packIds,
    nodeKinds: {},
    displayKinds: {},
    looks: {},
    lanes: {},
    edgeKinds: {},
    drilldown: 'none',
    matchers: [],
  };
  const strategies: DrilldownStrategy[] = [];
  for (const id of packIds) {
    const p = PACK_BY_ID.get(id)!;
    Object.assign(v.nodeKinds, p.nodeKinds);
    Object.assign(v.looks, p.nodeKinds);
    Object.assign(v.displayKinds, p.displayKinds ?? {});
    Object.assign(v.looks, p.displayKinds ?? {});
    Object.assign(v.lanes, p.lanes);
    Object.assign(v.edgeKinds, p.edgeKinds);
    strategies.push(p.drilldown);
    for (const m of p.matchers) if (!v.matchers.includes(m)) v.matchers.push(m);
  }
  v.drilldown = strategies.includes('web-product') ? 'web-product' : (strategies[0] ?? 'none');
  cache.set(key, v);
  return v;
}

/** 내장 팩 전부. kind 목록과 레인, 열 순위처럼 IR마다 안 갈리는 표가 이걸 쓴다 */
export const ALL_PACKS_VOCABULARY: Vocabulary = vocabularyOf(BUILTIN_PACKS.map((p) => p.id));
