import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonOrQuarantine, writeJsonAtomic } from '../core/json-file.js';
import { deriveBlueprint } from './blueprint-layout.js';
import { parseArchitectureIr } from './ir-schema.js';
import { maskIrSecrets } from './secret-mask.js';
import {
  FLOW_REF_KINDS,
  hasCardDescription,
  type ArchitectureEdge,
  type ArchitectureIr,
  type ArchitectureNode,
  type ArchitectureFlow,
  type ArchitectureProjection,
  type ArchitectureView,
  type ContextSource,
  type Evidence,
  type UnresolvedQuestion,
} from './types.js';
import {
  erNonTableParticipants,
  flowHasNothingToDraw,
  idCarriesCloudId,
  stripPrivateExcerpts,
} from './validator.js';

export interface PreviousRunSummary {
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
  unresolvedOpen: number;
  sourcesUsed: ContextSource[];
}

/** `<repoRoot>/.gestalt/architecture/` 아래 뷰별 IR과 HTML을 읽고 쓴다 */
export class ArchitectureStore {
  private readonly dir: string;

  constructor(repoRoot: string) {
    this.dir = join(repoRoot, '.gestalt', 'architecture');
  }

  irPath(view: ArchitectureView): string {
    return join(this.dir, `${view}.json`);
  }

  htmlPath(view: ArchitectureView, audience: 'private' | 'shared'): string {
    return join(this.dir, audience === 'shared' ? `${view}.shared.html` : `${view}.html`);
  }

  /** 없으면 null. 깨졌거나 스키마에 안 맞으면 `.corrupt-*`로 옮기고 null */
  load(view: ArchitectureView): ArchitectureIr | null {
    const raw = readJsonOrQuarantine(this.irPath(view), (value) => parseArchitectureIr(value).ok);
    if (raw === undefined) return null;
    const parsed = parseArchitectureIr(raw);
    return parsed.ok ? parsed.value : null;
  }

  /** load와 같지만 깨졌거나 스키마에 안 맞아도 파일을 옮기지 않고 null만 돌려준다. 라이브 서버의 질문 확인처럼 읽기만 하는 자리에서 쓴다 */
  peek(view: ArchitectureView): ArchitectureIr | null {
    const raw = readJsonOrQuarantine(this.irPath(view), (value) => parseArchitectureIr(value).ok, {
      quarantine: false,
    });
    if (raw === undefined) return null;
    const parsed = parseArchitectureIr(raw);
    return parsed.ok ? parsed.value : null;
  }

  /** private 근거의 excerpt와 글자 칸의 비밀값은 디스크에 남기지 않는다. 저장한 경로를 돌려준다 */
  save(ir: ArchitectureIr): string {
    const path = this.irPath(ir.view);
    writeJsonAtomic(path, forDisk(ir));
    return path;
  }

  viewPath(view: ArchitectureView, projectionId: string): string {
    return join(this.dir, 'views', `${view}.${projectionId}.json`);
  }

  /**
   * 투영 하나를 `views/<그림>.<투영 id>.json`에 따로 쌓는다. 질문 하나로 그림을 다시 열거나 남에게 넘길 때
   * 전체 IR 없이 읽히게 투영이 가리키는 노드와 엣지, 그 메시지에 걸린 질문만 함께 담는다.
   * 이번 IR에 없는 같은 그림의 옛 파일은 지운다. 저장한 경로를 돌려준다
   */
  saveViews(ir: ArchitectureIr): string[] {
    const stripped = forDisk(ir);
    const paths = (stripped.projections ?? []).map((pr) => {
      const path = this.viewPath(ir.view, pr.id);
      writeJsonAtomic(path, projectionSlice(stripped, pr));
      return path;
    });
    const dir = join(this.dir, 'views');
    if (!existsSync(dir)) return paths;
    const keep = new Set(paths);
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${ir.view}.`) || !name.endsWith('.json')) continue;
      const path = join(dir, name);
      if (!keep.has(path)) unlinkSync(path);
    }
    return paths;
  }

  saveHtml(view: ArchitectureView, audience: 'private' | 'shared', html: string): string {
    const path = this.htmlPath(view, audience);
    writeTextAtomic(path, html);
    return path;
  }

  /** 이전 실행과 이번 실행의 구조 변경 그림. 메인 그림과 따로 둬야 메인 HTML 바이트가 그대로다 */
  deltaHtmlPath(view: ArchitectureView, audience: 'private' | 'shared'): string {
    return join(
      this.dir,
      audience === 'shared' ? `${view}.delta.shared.html` : `${view}.delta.html`,
    );
  }

  saveDeltaHtml(view: ArchitectureView, audience: 'private' | 'shared', html: string): string {
    const path = this.deltaHtmlPath(view, audience);
    writeTextAtomic(path, html);
    return path;
  }
}

function forDisk(ir: ArchitectureIr): ArchitectureIr {
  return maskIrSecrets(stripPrivateExcerpts(ir)).ir;
}

export interface ProjectionSlice {
  schemaVersion: string;
  view: ArchitectureView;
  generatedAt: string;
  projection: ArchitectureProjection;
  /** lifecycle과 blueprint가 가리킨 흐름. 이 파일 하나로 그 그림을 다시 그릴 수 있게 함께 싣는다 */
  flow?: ArchitectureFlow;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  unresolved: UnresolvedQuestion[];
}

/** blueprint 칸에 선 노드와 칸을 채우려 따라간 엣지. 저장 시점엔 검증 결과가 없어 근거가 있는 엣지와 모든 노드를 그릴 수 있다고 본다 */
function blueprintChain(
  ir: ArchitectureIr,
  flow: ArchitectureFlow,
): { nodes: string[]; edges: string[] } {
  const model = deriveBlueprint(flow, {
    nodes: ir.nodes,
    edges: ir.edges,
    drawableNodeIds: new Set(ir.nodes.map((n) => n.id)),
    drawableEdgeIds: new Set(ir.edges.filter((e) => e.evidence.length > 0).map((e) => e.id)),
    drawableStepIds: new Set(flow.steps.map((st) => st.id)),
    drawableTransitionIds: new Set(flow.transitions.map((t) => t.id)),
  });
  // 따라간 엣지의 양 끝도 싣는다. 칸에 안 서는 처리 모듈을 빼면 엣지가 없는 노드를 가리킨다
  const edgeById = new Map(ir.edges.map((e) => [e.id, e]));
  const nodes = [
    ...model.columns.flatMap((c) =>
      Object.values(c.cells).flatMap((items) =>
        items.filter((it) => it.type === 'node').map((it) => it.id),
      ),
    ),
    ...model.edges.flatMap((id) => {
      const e = edgeById.get(id);
      return e !== undefined ? [e.from, e.to] : [];
    }),
  ];
  return { nodes, edges: model.edges };
}

function projectionSlice(ir: ArchitectureIr, pr: ArchitectureProjection): ProjectionSlice {
  const flow = pr.flow !== undefined ? (ir.flows ?? []).find((f) => f.id === pr.flow) : undefined;
  const chain =
    pr.shape === 'blueprint' && flow !== undefined ? blueprintChain(ir, flow) : undefined;
  // er 테이블이 가리키는 외래 키 대상도 싣는다. 그림 밖 테이블이어도 컬럼의 references가 없는 노드를 가리키지 않게 하려고다
  const tables = pr.shape === 'er' ? new Set(pr.participants ?? []) : new Set<string>();
  const fkTargets = ir.nodes
    .filter((n) => tables.has(n.id))
    .flatMap((n) => (n.columns ?? []).flatMap((c) => (c.references ? [c.references.table] : [])));
  const nodeIds = new Set([
    ...(chain?.nodes ?? []),
    ...fkTargets,
    ...(pr.participants ?? []),
    ...(pr.sides ?? []).flatMap((side) => side.nodes),
    ...pr.messages.flatMap((m) => [m.from, m.to]),
    ...(flow?.steps ?? []).flatMap((st) => st.refs ?? []),
  ]);
  const edgeIds = new Set([
    ...pr.messages.flatMap((m) => (m.edge !== undefined ? [m.edge] : [])),
    ...(chain?.edges ?? []),
  ]);
  const messageIds = new Set(pr.messages.map((m) => m.id));
  const stepIds = new Set(flow?.steps.map((st) => st.id) ?? []);
  const transitionIds = new Set(flow?.transitions.map((t) => t.id) ?? []);
  return {
    schemaVersion: ir.schemaVersion,
    view: ir.view,
    generatedAt: ir.generatedAt,
    projection: pr,
    ...(flow !== undefined ? { flow } : {}),
    nodes: ir.nodes.filter((n) => nodeIds.has(n.id)),
    edges: ir.edges.filter((e) => edgeIds.has(e.id)),
    unresolved: ir.unresolved.filter(
      (q) =>
        (q.subject.messageId !== undefined && messageIds.has(q.subject.messageId)) ||
        (q.id.startsWith('auto:fk:') &&
          q.subject.nodeId !== undefined &&
          tables.has(q.subject.nodeId)) ||
        (q.subject.stepId !== undefined && stepIds.has(q.subject.stepId)) ||
        (q.subject.transitionId !== undefined && transitionIds.has(q.subject.transitionId)),
    ),
  };
}

// 브라우저가 열어둔 HTML을 새로고침할 때 반쯤 쓰인 파일을 보지 않게 json과 같은 방식으로 갈아 끼운다
export function writeTextAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 이미 없으면 됐다
    }
    throw e;
  }
}

/** 같은 노드를 알아보는 키. 재실행 병합과 분석 합치기가 같은 기준을 쓴다 */
export function nodeKey(node: Pick<ArchitectureNode, 'kind' | 'repo' | 'label'>): string {
  const label = normalizeLabel(node.label);
  // 호스트 분석은 리모트를 자기 레포 노드로 적고 리모트 분석은 리모트 레포로 적는다. Module Federation 이름은 런타임에서 하나라 레포를 빼야 둘이 만난다
  if (node.kind === 'micro_app') return `${node.kind}\u0000\u0000${label}`;
  return `${node.kind}\u0000${node.repo}\u0000${label}`;
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** nodeKey에서 label만 뺀 자리. 2차 매칭은 이 자리 안에서만 짝을 찾는다 */
function slotKey(node: Pick<ArchitectureNode, 'kind' | 'repo'>): string {
  return node.kind === 'micro_app' ? `${node.kind}\u0000` : `${node.kind}\u0000${node.repo}`;
}

function keyText(node: Pick<ArchitectureNode, 'kind' | 'repo' | 'label'>): string {
  return `${node.kind}/${node.kind === 'micro_app' ? '*' : node.repo}/${normalizeLabel(node.label)}`;
}

function codeFiles(node: ArchitectureNode): Set<string> {
  return new Set(
    node.evidence
      .filter((ev) => ev.type === 'code')
      .map((ev) => ev.location.replace(/:\d+(?:-\d+)?$/, '')),
  );
}

// 라우터 파일 하나에 화면 여럿이 걸리듯 같은 자리의 다른 노드도 근거로 댄 파일은 그 노드만의 표지가 아니다.
// 이런 파일로 짝을 지으면 지운 화면의 id와 답이 새 화면으로 넘어간다
function sharedCodeFiles(ir: ArchitectureIr): Set<string> {
  const count = new Map<string, number>();
  for (const node of ir.nodes) {
    for (const file of codeFiles(node)) {
      const key = `${slotKey(node)}\u0001${file}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  return new Set([...count].flatMap(([key, n]) => (n > 1 ? [key] : [])));
}

// 줄 번호는 코드가 조금만 밀려도 바뀐다. 같은 노드인지는 어느 파일을 근거로 댔는지로 본다
function codeFileSignature(
  node: ArchitectureNode,
  shared: ReadonlySet<string>,
): string | undefined {
  const slot = slotKey(node);
  const files = [...codeFiles(node)].filter((file) => !shared.has(`${slot}\u0001${file}`));
  if (files.length === 0) return undefined;
  return files.sort().join('\n');
}

function evidenceOverlapOf(
  prevNode: ArchitectureNode,
  node: ArchitectureNode,
): { evidenceOverlap?: boolean } {
  const prevFiles = codeFiles(prevNode);
  const files = codeFiles(node);
  if (prevFiles.size === 0 || files.size === 0) return {};
  return { evidenceOverlap: [...files].some((file) => prevFiles.has(file)) };
}

function edgeKey(edge: Pick<ArchitectureEdge, 'from' | 'to' | 'kind'>): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
}

function isAnswered(q: UnresolvedQuestion): boolean {
  return q.answer !== undefined && q.answer.trim() !== '';
}

export type MergeWarning =
  | {
      code: 'LABEL_CHANGED_ID_LOST';
      previousId: string;
      previousLabel: string;
      kind: string;
      repo: string;
      /** 같은 kind와 repo 자리에서 짝을 못 찾은 이번 실행 노드 id */
      candidates: string[];
      message: string;
    }
  | {
      code: 'FLOW_DROPPED';
      flowId: string;
      /**
       * node_gone: 가리키던 노드가 이번 IR에 없다. no_refs: 노드를 하나도 안 가리킨다.
       * evidence_stale: 단계나 전이의 code 근거 파일이 없거나 줄이 범위 밖이다. id_conflict: 이번 흐름과 단계나 전이 id가 겹친다
       */
      reason: FlowDropReason;
      /** reason이 node_gone일 때 이번 IR에서 사라진 노드 id */
      missingNodeIds: string[];
      message: string;
    }
  | {
      code: 'PROJECTION_DROPPED';
      projectionId: string;
      /** evidence_stale: 메시지의 code 근거 파일이 없거나 줄이 범위 밖이다 */
      reason: 'evidence_stale';
      message: string;
    }
  | {
      code: 'MERGE_KEY_DUPLICATE';
      /** kind/repo/정규화 label. micro_app은 repo 자리에 `*`를 쓴다 */
      key: string;
      nodeIds: string[];
      message: string;
    };

export interface MergeRelabel {
  id: string;
  previousLabel: string;
  label: string;
  matchedBy: 'id' | 'evidence';
  /** matchedBy가 id일 때만 온다. 지난 노드와 이번 노드의 code 근거 파일이 하나라도 겹치는지다. 어느 쪽이든 code 근거가 없으면 빠진다 */
  evidenceOverlap?: boolean;
}

export interface MergeWithPreviousOptions {
  /**
   * 이어 실을 지난 흐름과 투영의 근거가 지금 코드에서도 맞는지 본다. false면 그 흐름이나 투영을 버린다.
   * 병합은 파일을 읽지 않는다. 파일 검사를 하는 render만 넘긴다
   */
  evidenceOk?: (evidence: readonly Evidence[]) => boolean;
}

export interface PreviousMergeReport {
  /** 지난 실행의 description을 이어받은 노드 id */
  descriptionCarried: string[];
  /** 지난 실행의 summary를 이어받은 노드 id */
  summaryCarried: string[];
  /** 지난 실행에서 이어받은 IR 최상위 칸 */
  topLevelCarried: Array<'summary' | 'note'>;
  relabeled: MergeRelabel[];
  /** 이번 실행에 없어 지난 실행에서 이어 실은 흐름 id */
  flowsCarried: string[];
  /** 이번 실행에 없고 이어 싣지도 못해 사라진 지난 흐름 id. 이유는 같은 id의 FLOW_DROPPED 경고에 있다 */
  flowsDropped: string[];
  /** 근거가 낡아 이어 싣지 못한 지난 투영 id. 같은 id의 PROJECTION_DROPPED 경고가 함께 온다 */
  projectionsDropped: string[];
  warnings: MergeWarning[];
}

export interface PreviousMergeResult {
  ir: ArchitectureIr;
  report: PreviousMergeReport;
}

/**
 * 재실행 IR(next)이 이전 IR(prev)의 id를 물려받게 맞춘다.
 * 입력은 바꾸지 않는다. 무엇을 이어받았는지 알릴 필요가 없으면 이 함수를, 알려야 하면 mergeWithPreviousDetailed를 쓴다.
 */
export function mergeWithPrevious(
  prev: ArchitectureIr,
  next: ArchitectureIr,
  options: MergeWithPreviousOptions = {},
): ArchitectureIr {
  return mergeWithPreviousDetailed(prev, next, options).ir;
}

/**
 * 재실행 IR(next)이 이전 IR(prev)의 id를 물려받게 맞추고 무엇을 이어받았는지 함께 돌려준다.
 *
 * 생성할 때마다 id가 새로 매겨지면 사람이 단 답이나 화면 위치 기억이 전부 끊긴다.
 * 노드는 kind, repo, 정규화한 label이 같으면 같은 것으로 본다. 이걸로 못 찾으면 같은 kind와 repo 자리 안에서
 * 같은 id가 있는지, 그다음 code 근거 파일 집합이 1:1로 하나뿐인 짝이 있는지 본다. label만 바꿔 쓴 노드를 놓치지 않으려고다.
 * 엣지는 바뀐 노드 id 기준 (from, to, kind)가 같으면 같은 것으로 본다. next의 다른 id와 부딪히면 바꾸지 않는다.
 * 짝지은 노드의 description과 summary, IR 최상위 summary와 note가 next에 없으면 prev 것을 잇는다.
 * 빈 문자열은 지운 것이라 그대로 둔다.
 * prev에서 답이 달린 질문과 이번에 안 나온 흐름, 투영은 가리키는 대상이 merge 결과에 남아 있을 때만 이어 붙인다.
 * 입력은 바꾸지 않는다.
 */
export function mergeWithPreviousDetailed(
  prev: ArchitectureIr,
  next: ArchitectureIr,
  options: MergeWithPreviousOptions = {},
): PreviousMergeResult {
  const prevNodeByKey = new Map<string, ArchitectureNode>();
  for (const node of prev.nodes) {
    const key = nodeKey(node);
    if (!prevNodeByKey.has(key)) prevNodeByKey.set(key, node);
  }

  const nodeIdMap = new Map<string, string>();
  const mapNodeId = (id: string): string => nodeIdMap.get(id) ?? id;
  // 비워진 옛 id를 다시 쓰지 않는다. 연쇄로 바꾸다 보면 한 바퀴 돌아 id가 겹칠 수 있다
  const takenNodeIds = new Set(next.nodes.map((n) => n.id));
  // next 노드 자리 번호 → 짝지은 prev 노드. id를 못 물려받아도 같은 노드로 본 짝은 남겨 description을 잇는다
  const pairOf = new Map<number, ArchitectureNode>();
  const usedPrev = new Set<ArchitectureNode>();
  const relabeled: MergeRelabel[] = [];

  const link = (index: number, prevNode: ArchitectureNode): void => {
    const node = next.nodes[index]!;
    pairOf.set(index, prevNode);
    usedPrev.add(prevNode);
    const prevId = prevNode.id;
    if (prevId === node.id || takenNodeIds.has(prevId) || nodeIdMap.has(node.id)) return;
    // 지난 실행이 계정 ID나 배포 ID를 id에 박았으면 물려받지 않는다. 지금 검증기가 그런 id를 거부한다
    if (idCarriesCloudId(prevId, node.kind)) return;
    takenNodeIds.add(prevId);
    nodeIdMap.set(node.id, prevId);
  };
  const relink = (index: number, prevNode: ArchitectureNode, matchedBy: 'id' | 'evidence') => {
    link(index, prevNode);
    const node = next.nodes[index]!;
    if (prevNode.label !== node.label) {
      relabeled.push({
        id: mapNodeId(node.id),
        previousLabel: prevNode.label,
        label: node.label,
        matchedBy,
        ...(matchedBy === 'id' ? evidenceOverlapOf(prevNode, node) : {}),
      });
    }
  };

  const claimedKeys = new Set<string>();
  next.nodes.forEach((node, i) => {
    const key = nodeKey(node);
    if (claimedKeys.has(key)) return;
    claimedKeys.add(key);
    const prevNode = prevNodeByKey.get(key);
    if (prevNode !== undefined) link(i, prevNode);
  });

  const prevNodeById = new Map<string, ArchitectureNode>();
  for (const node of prev.nodes) if (!prevNodeById.has(node.id)) prevNodeById.set(node.id, node);
  next.nodes.forEach((node, i) => {
    if (pairOf.has(i)) return;
    const prevNode = prevNodeById.get(node.id);
    if (prevNode === undefined || usedPrev.has(prevNode)) return;
    if (slotKey(prevNode) !== slotKey(node)) return;
    relink(i, prevNode, 'id');
  });

  // 근거 파일이 같은 후보가 어느 쪽이든 둘 이상이면 어느 것이 어느 것인지 모른다. 잘못 이으면 답이 엉뚱한 노드에 붙어 잇지 않는다
  const prevShared = sharedCodeFiles(prev);
  const nextShared = sharedCodeFiles(next);
  const bucketOf = (node: ArchitectureNode, shared: ReadonlySet<string>): string | undefined => {
    const signature = codeFileSignature(node, shared);
    return signature === undefined ? undefined : `${slotKey(node)}\u0001${signature}`;
  };
  const nextBuckets = new Map<string, number[]>();
  next.nodes.forEach((node, i) => {
    if (pairOf.has(i)) return;
    const bucket = bucketOf(node, nextShared);
    if (bucket === undefined) return;
    nextBuckets.set(bucket, [...(nextBuckets.get(bucket) ?? []), i]);
  });
  const prevBuckets = new Map<string, ArchitectureNode[]>();
  for (const node of prev.nodes) {
    if (usedPrev.has(node)) continue;
    const bucket = bucketOf(node, prevShared);
    if (bucket === undefined) continue;
    prevBuckets.set(bucket, [...(prevBuckets.get(bucket) ?? []), node]);
  }
  for (const [bucket, indexes] of nextBuckets) {
    const prevNodes = prevBuckets.get(bucket);
    if (indexes.length !== 1 || prevNodes?.length !== 1) continue;
    relink(indexes[0]!, prevNodes[0]!, 'evidence');
  }

  const descriptionCarried: string[] = [];
  const summaryCarried: string[] = [];
  const nodes = next.nodes.map((n, i) => {
    const prevNode = pairOf.get(i);
    const carryDescription =
      prevNode !== undefined &&
      n.description === undefined &&
      hasCardDescription(prevNode.description);
    if (carryDescription) descriptionCarried.push(mapNodeId(n.id));
    const carrySummary =
      prevNode !== undefined && n.summary === undefined && hasCardDescription(prevNode.summary);
    if (carrySummary) summaryCarried.push(mapNodeId(n.id));
    return {
      ...n,
      id: mapNodeId(n.id),
      ...(carryDescription ? { description: prevNode.description } : {}),
      ...(carrySummary ? { summary: prevNode.summary } : {}),
      ...(n.parent !== undefined ? { parent: mapNodeId(n.parent) } : {}),
      ...(n.account !== undefined ? { account: mapNodeId(n.account) } : {}),
      ...(n.placedIn !== undefined ? { placedIn: mapNodeId(n.placedIn) } : {}),
      ...(n.columns !== undefined
        ? {
            columns: n.columns.map((c) =>
              c.references !== undefined
                ? { ...c, references: { ...c.references, table: mapNodeId(c.references.table) } }
                : { ...c },
            ),
          }
        : {}),
    };
  });

  const warnings: MergeWarning[] = [
    ...lostLabelWarnings(prev, next, pairOf, usedPrev, mapNodeId),
    ...duplicateKeyWarnings(next, prevNodeByKey, mapNodeId),
  ];

  const prevEdgeIdByKey = new Map<string, string>();
  for (const edge of prev.edges) {
    const key = edgeKey(edge);
    if (!prevEdgeIdByKey.has(key)) prevEdgeIdByKey.set(key, edge.id);
  }

  const edgeIdMap = new Map<string, string>();
  const takenEdgeIds = new Set(next.edges.map((e) => e.id));
  const claimedEdgeKeys = new Set<string>();
  const remappedEdges = next.edges.map((e) => ({
    ...e,
    from: mapNodeId(e.from),
    to: mapNodeId(e.to),
  }));
  for (const edge of remappedEdges) {
    const key = edgeKey(edge);
    if (claimedEdgeKeys.has(key)) continue;
    claimedEdgeKeys.add(key);
    const prevId = prevEdgeIdByKey.get(key);
    if (prevId === undefined || prevId === edge.id || takenEdgeIds.has(prevId)) continue;
    if (idCarriesCloudId(prevId)) continue;
    if (edgeIdMap.has(edge.id)) continue;
    takenEdgeIds.add(prevId);
    edgeIdMap.set(edge.id, prevId);
  }
  const mapEdgeId = (id: string): string => edgeIdMap.get(id) ?? id;
  const edges = remappedEdges.map((e) => ({ ...e, id: mapEdgeId(e.id) }));

  const unresolved: UnresolvedQuestion[] = next.unresolved.map((q) => ({
    ...q,
    subject: {
      ...q.subject,
      ...(q.subject.nodeId !== undefined ? { nodeId: mapNodeId(q.subject.nodeId) } : {}),
      ...(q.subject.edgeId !== undefined ? { edgeId: mapEdgeId(q.subject.edgeId) } : {}),
    },
  }));

  const nodeKindById = new Map(nodes.map((n) => [n.id, n.kind]));
  // 지난 흐름과 투영, 질문은 지난 노드 id로 적혀 있다. 짝지은 노드의 이번 id로 옮긴다.
  // 짝을 못 찾은 지난 노드는 null이다. 그 id를 이번 IR의 다른 노드가 쓰고 있어도 같은 노드가 아니라서다
  const finalIdOfPrev = new Map<string, string | null>();
  for (const node of prev.nodes) finalIdOfPrev.set(node.id, null);
  for (const [i, prevNode] of pairOf) finalIdOfPrev.set(prevNode.id, mapNodeId(next.nodes[i]!.id));
  const resolvePrevNodeId = (id: string): string | null => finalIdOfPrev.get(id) ?? null;
  // 노드 id가 바뀌었으면 이번 흐름이 가리키는 쪽만 따라 바꾼다
  const nextFlows = next.flows?.map((f) => ({
    ...f,
    ...(f.service !== undefined ? { service: mapNodeId(f.service) } : {}),
    steps: f.steps.map((st) =>
      st.refs !== undefined ? { ...st, refs: st.refs.map(mapNodeId) } : { ...st },
    ),
  }));
  // 질문 하나에 맞춰 돈 실행은 다른 흐름을 안 적는다. 이번에 안 나온 지난 흐름은 가리키는 노드가 다 살아 있을 때만 이어 싣는다
  const { carried: carriedFlows, dropped: droppedFlows } = carryFlows(
    prev.flows ?? [],
    nextFlows ?? [],
    nodeKindById,
    resolvePrevNodeId,
    options.evidenceOk,
  );
  warnings.push(...droppedFlows.map(flowDroppedWarning));
  const flows =
    nextFlows !== undefined || carriedFlows.length > 0
      ? [...(nextFlows ?? []), ...carriedFlows]
      : undefined;
  const projections = next.projections?.map((pr) => ({
    ...pr,
    ...(pr.participants !== undefined ? { participants: pr.participants.map(mapNodeId) } : {}),
    ...(pr.sides !== undefined
      ? { sides: pr.sides.map((side) => ({ ...side, nodes: side.nodes.map(mapNodeId) })) }
      : {}),
    messages: pr.messages.map((m) => ({
      ...m,
      from: mapNodeId(m.from),
      to: mapNodeId(m.to),
      ...(m.edge !== undefined ? { edge: mapEdgeId(m.edge) } : {}),
    })),
  }));
  const nodeIds = new Set(nodeKindById.keys());
  const edgeIds = new Set(edges.map((e) => e.id));
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  // 질문 하나에 답한 그림은 다음 실행이 다른 질문을 물어도 남아야 한다. 이번에 안 나온 지난 투영은 가리키는 것이 다 살아 있을 때만 이어 싣는다
  const { carried, dropped: droppedProjections } = carryProjections(
    prev.projections ?? [],
    projections ?? [],
    nodeKindById,
    edgeById,
    new Map(flows?.map((f) => [f.id, f]) ?? []),
    resolvePrevNodeId,
    options.evidenceOk,
  );
  warnings.push(...droppedProjections.map(projectionDroppedWarning));
  const allProjections =
    projections !== undefined || carried.length > 0
      ? [...(projections ?? []), ...carried]
      : undefined;
  const messageIds = new Set(allProjections?.flatMap((pr) => pr.messages.map((m) => m.id)) ?? []);
  const stepIds = new Set(flows?.flatMap((f) => f.steps.map((st) => st.id)) ?? []);
  const transitionIds = new Set(flows?.flatMap((f) => f.transitions.map((t) => t.id)) ?? []);

  const questionIds = new Set(unresolved.map((q) => q.id));
  const sameSubject = (a: UnresolvedQuestion, b: UnresolvedQuestion): boolean =>
    a.subject.nodeId === b.subject.nodeId &&
    a.subject.edgeId === b.subject.edgeId &&
    a.subject.stepId === b.subject.stepId &&
    a.subject.transitionId === b.subject.transitionId &&
    a.subject.messageId === b.subject.messageId;

  for (const answeredQ of prev.unresolved) {
    if (!isAnswered(answeredQ)) continue;
    const { edgeId, stepId, transitionId, messageId } = answeredQ.subject;
    const nodeId =
      answeredQ.subject.nodeId !== undefined
        ? resolvePrevNodeId(answeredQ.subject.nodeId)
        : undefined;
    if (nodeId === null) continue;
    if (nodeId !== undefined && !nodeIds.has(nodeId)) continue;
    if (edgeId !== undefined && !edgeIds.has(edgeId)) continue;
    if (stepId !== undefined && !stepIds.has(stepId)) continue;
    if (transitionId !== undefined && !transitionIds.has(transitionId)) continue;
    if (messageId !== undefined && !messageIds.has(messageId)) continue;
    const prevQ: UnresolvedQuestion =
      nodeId !== undefined
        ? { ...answeredQ, subject: { ...answeredQ.subject, nodeId } }
        : answeredQ;

    // 같은 대상에 같은 질문을 다시 물었으면 새로 추가하지 않고 답만 옮긴다
    const twin = unresolved.find(
      (q) => sameSubject(q, prevQ) && q.question.trim() === prevQ.question.trim(),
    );
    if (twin) {
      if (!isAnswered(twin)) twin.answer = prevQ.answer;
      continue;
    }
    let id = prevQ.id;
    for (let n = 2; questionIds.has(id); n++) id = `${prevQ.id}-${n}`;
    questionIds.add(id);
    unresolved.push({ ...prevQ, id, subject: { ...prevQ.subject } });
  }

  const topLevelCarried: Array<'summary' | 'note'> = [];
  const topLevel: Pick<ArchitectureIr, 'summary' | 'note'> = {};
  for (const field of ['summary', 'note'] as const) {
    if (next[field] !== undefined || !hasCardDescription(prev[field])) continue;
    topLevel[field] = prev[field];
    topLevelCarried.push(field);
  }

  const ir: ArchitectureIr = {
    ...next,
    ...topLevel,
    nodes,
    edges,
    unresolved,
    sourcesUsed: next.sourcesUsed,
    ...(next.groups !== undefined
      ? { groups: next.groups.map((g) => ({ ...g, members: g.members.map(mapNodeId).sort() })) }
      : {}),
    ...(flows !== undefined ? { flows } : {}),
    ...(allProjections !== undefined ? { projections: allProjections } : {}),
    ...(next.stages !== undefined
      ? {
          stages: next.stages.map((st) =>
            st.nodes !== undefined ? { ...st, nodes: st.nodes.map(mapNodeId) } : { ...st },
          ),
        }
      : {}),
  };
  return {
    ir,
    report: {
      descriptionCarried,
      summaryCarried,
      topLevelCarried,
      relabeled,
      flowsCarried: carriedFlows.map((f) => f.id),
      flowsDropped: droppedFlows.map((d) => d.flowId),
      projectionsDropped: droppedProjections,
      warnings,
    },
  };
}

// 끝까지 짝을 못 찾은 지난 노드에 사람이 남긴 것(답, 설명, 요약)이 있고 같은 자리에 새 노드가 생겼으면 label과 id를 함께 바꿔 끊겼을 가능성이 크다
function lostLabelWarnings(
  prev: ArchitectureIr,
  next: ArchitectureIr,
  pairOf: ReadonlyMap<number, ArchitectureNode>,
  usedPrev: ReadonlySet<ArchitectureNode>,
  mapNodeId: (id: string) => string,
): MergeWarning[] {
  const answeredNodeIds = new Set(
    prev.unresolved.flatMap((q) =>
      isAnswered(q) && q.subject.nodeId !== undefined ? [q.subject.nodeId] : [],
    ),
  );
  const warnings: MergeWarning[] = [];
  for (const prevNode of prev.nodes) {
    if (usedPrev.has(prevNode)) continue;
    if (
      !answeredNodeIds.has(prevNode.id) &&
      !hasCardDescription(prevNode.description) &&
      !hasCardDescription(prevNode.summary)
    )
      continue;
    const slot = slotKey(prevNode);
    const candidates = next.nodes.flatMap((n, i) =>
      !pairOf.has(i) && slotKey(n) === slot ? [mapNodeId(n.id)] : [],
    );
    if (candidates.length === 0) continue;
    warnings.push({
      code: 'LABEL_CHANGED_ID_LOST',
      previousId: prevNode.id,
      previousLabel: prevNode.label,
      kind: prevNode.kind,
      repo: prevNode.repo,
      candidates,
      message: `지난 실행의 "${prevNode.label}"(${prevNode.id})와 짝을 못 찾아 설명과 요약, 답이 이어지지 않았다. label과 id를 함께 바꿨다면 후보 ${candidates.join(', ')} 중 하나에 지난 id를 다시 쓴다.`,
    });
  }
  return warnings;
}

// 이번 실행에 같은 키가 여럿이면 첫 노드만 지난 id를 받는다. 순서만 바뀌어도 id가 뒤바뀔 수 있어 알린다
function duplicateKeyWarnings(
  next: ArchitectureIr,
  prevNodeByKey: ReadonlyMap<string, ArchitectureNode>,
  mapNodeId: (id: string) => string,
): MergeWarning[] {
  const byKey = new Map<string, ArchitectureNode[]>();
  for (const node of next.nodes) {
    const key = nodeKey(node);
    byKey.set(key, [...(byKey.get(key) ?? []), node]);
  }
  const warnings: MergeWarning[] = [];
  for (const [key, group] of byKey) {
    if (group.length < 2 || !prevNodeByKey.has(key)) continue;
    const nodeIds = group.map((n) => mapNodeId(n.id));
    const shown = keyText(group[0]!);
    warnings.push({
      code: 'MERGE_KEY_DUPLICATE',
      key: shown,
      nodeIds,
      message: `병합 키 ${shown}를 노드 ${nodeIds.join(', ')}가 함께 써서 첫 노드만 지난 id를 받았다. label을 서로 다르게 적는다.`,
    });
  }
  return warnings;
}

type FlowDropReason = 'node_gone' | 'no_refs' | 'evidence_stale' | 'id_conflict';

function flowEvidence(flow: ArchitectureFlow): Evidence[] {
  return [
    ...flow.steps.flatMap((st) => st.evidence),
    ...flow.transitions.flatMap((t) => t.evidence),
  ];
}

interface DroppedFlow {
  flowId: string;
  reason: FlowDropReason;
  missingNodeIds: string[];
}

// 흐름은 코드에 붙은 노드를 근거로 남는다. 가리키던 노드가 사라지면 그 코드가 없어진 것이라 흐름도 함께 지운다.
// 노드를 하나도 안 가리키는 흐름은 언제 지울지 판단할 근거가 없어 이어 싣지 않는다
function carryFlows(
  prev: readonly ArchitectureFlow[],
  next: readonly ArchitectureFlow[],
  nodeKindById: ReadonlyMap<string, ArchitectureNode['kind']>,
  resolvePrevNodeId: (id: string) => string | null,
  evidenceOk: ((evidence: readonly Evidence[]) => boolean) | undefined,
): { carried: ArchitectureFlow[]; dropped: DroppedFlow[] } {
  const flowIds = new Set(next.map((f) => f.id));
  // 단계와 전이 id는 흐름 전체에서 겹치면 안 된다. 겹치는 지난 흐름은 실으면 검증에서 막힌다
  const stepIds = new Set(next.flatMap((f) => f.steps.map((st) => st.id)));
  const transitionIds = new Set(next.flatMap((f) => f.transitions.map((t) => t.id)));
  const carried: ArchitectureFlow[] = [];
  const dropped: DroppedFlow[] = [];
  for (const prevFlow of prev) {
    if (flowIds.has(prevFlow.id)) continue;
    const refs = prevFlow.steps.flatMap((st) => st.refs ?? []);
    if (prevFlow.service === undefined && refs.length === 0) {
      dropped.push({ flowId: prevFlow.id, reason: 'no_refs', missingNodeIds: [] });
      continue;
    }
    const kindOfPrev = (id: string): ArchitectureNode['kind'] | undefined => {
      const finalId = resolvePrevNodeId(id);
      return finalId === null ? undefined : nodeKindById.get(finalId);
    };
    const missing = [
      ...(prevFlow.service !== undefined && kindOfPrev(prevFlow.service) !== 'service'
        ? [prevFlow.service]
        : []),
      ...refs.filter((id) => {
        const kind = kindOfPrev(id);
        return kind === undefined || !FLOW_REF_KINDS.includes(kind);
      }),
    ];
    if (missing.length > 0) {
      dropped.push({
        flowId: prevFlow.id,
        reason: 'node_gone',
        missingNodeIds: [...new Set(missing)],
      });
      continue;
    }
    // 위에서 다 살아 있음을 확인해 null이 나오지 않는다
    const toFinal = (id: string): string => resolvePrevNodeId(id) ?? id;
    const flow: ArchitectureFlow = {
      ...prevFlow,
      ...(prevFlow.service !== undefined ? { service: toFinal(prevFlow.service) } : {}),
      steps: prevFlow.steps.map((st) =>
        st.refs !== undefined ? { ...st, refs: st.refs.map(toFinal) } : st,
      ),
    };
    // 지난 흐름은 세션 IR에 없어 근거가 낡아도 고칠 자리가 안 보인다. 실으면 render 전체가 근거 오류로 막힌다
    if (evidenceOk !== undefined && !evidenceOk(flowEvidence(flow))) {
      dropped.push({ flowId: flow.id, reason: 'evidence_stale', missingNodeIds: [] });
      continue;
    }
    if (
      flow.steps.some((st) => stepIds.has(st.id)) ||
      flow.transitions.some((t) => transitionIds.has(t.id))
    ) {
      dropped.push({ flowId: flow.id, reason: 'id_conflict', missingNodeIds: [] });
      continue;
    }
    flowIds.add(flow.id);
    for (const st of flow.steps) stepIds.add(st.id);
    for (const t of flow.transitions) transitionIds.add(t.id);
    carried.push(flow);
  }
  return { carried, dropped };
}

function flowDroppedWarning(d: DroppedFlow): MergeWarning {
  const why =
    d.reason === 'node_gone'
      ? `가리키던 노드 ${d.missingNodeIds.join(', ')}가 이번 IR에 없어`
      : d.reason === 'no_refs'
        ? '노드를 하나도 가리키지 않아'
        : d.reason === 'evidence_stale'
          ? '단계나 전이의 code 근거가 지금 코드에 없어'
          : '이번 흐름과 단계나 전이 id가 겹쳐';
  return {
    code: 'FLOW_DROPPED',
    flowId: d.flowId,
    reason: d.reason,
    missingNodeIds: d.missingNodeIds,
    message:
      d.reason === 'evidence_stale'
        ? `지난 흐름 ${d.flowId}는 ${why} 이어 싣지 않았다. 아직 필요한 흐름이면 근거를 다시 찾아 이번 IR에 적는다.`
        : `지난 흐름 ${d.flowId}는 ${why} 이어 싣지 않았다. 아직 필요한 흐름이면 이번 IR에 다시 적는다.`,
  };
}

// 메시지에 투영 title이 실리지 않게 id만 쓴다
function projectionDroppedWarning(projectionId: string): MergeWarning {
  return {
    code: 'PROJECTION_DROPPED',
    projectionId,
    reason: 'evidence_stale',
    message: `지난 투영 ${projectionId}는 메시지의 code 근거가 지금 코드에 없어 이어 싣지 않았다. 아직 필요한 그림이면 근거를 다시 찾아 이번 IR에 적는다.`,
  };
}

/** 이어 실을 지난 투영과, 근거가 낡아 버린 투영 id. 구조가 깨져 버린 투영은 dropped에 안 싣는다 */
function carryProjections(
  prev: readonly ArchitectureProjection[],
  next: readonly ArchitectureProjection[],
  nodeKindById: ReadonlyMap<string, ArchitectureNode['kind']>,
  edgeById: ReadonlyMap<string, ArchitectureEdge>,
  flowById: ReadonlyMap<string, ArchitectureFlow>,
  resolvePrevNodeId: (id: string) => string | null,
  evidenceOk: ((evidence: readonly Evidence[]) => boolean) | undefined,
): { carried: ArchitectureProjection[]; dropped: string[] } {
  const projectionIds = new Set(next.map((pr) => pr.id));
  const messageIds = new Set(next.flatMap((pr) => pr.messages.map((m) => m.id)));
  const out: ArchitectureProjection[] = [];
  const dropped: string[] = [];
  for (const prevPr of prev) {
    if (projectionIds.has(prevPr.id)) continue;
    if (prevPr.messages.some((m) => messageIds.has(m.id))) continue;
    const pointed = [
      ...(prevPr.participants ?? []),
      ...(prevPr.sides ?? []).flatMap((side) => side.nodes),
      ...prevPr.messages.flatMap((m) => [m.from, m.to]),
    ];
    if (pointed.some((id) => resolvePrevNodeId(id) === null)) continue;
    const toFinal = (id: string): string => resolvePrevNodeId(id) ?? id;
    const pr: ArchitectureProjection = {
      ...prevPr,
      ...(prevPr.participants !== undefined
        ? { participants: prevPr.participants.map(toFinal) }
        : {}),
      ...(prevPr.sides !== undefined
        ? { sides: prevPr.sides.map((side) => ({ ...side, nodes: side.nodes.map(toFinal) })) }
        : {}),
      messages: prevPr.messages.map((m) => ({ ...m, from: toFinal(m.from), to: toFinal(m.to) })),
    };
    const listed = [...(pr.participants ?? []), ...(pr.sides ?? []).flatMap((side) => side.nodes)];
    if (!listed.every((id) => nodeKindById.has(id))) continue;
    if (erNonTableParticipants(pr, nodeKindById).length > 0) continue;
    if (pr.flow !== undefined) {
      const flow = flowById.get(pr.flow);
      if (flow === undefined || flowHasNothingToDraw(pr, flow)) continue;
    }
    const alive = pr.messages.every((m) => {
      if (!nodeKindById.has(m.from) || !nodeKindById.has(m.to)) return false;
      if (m.edge === undefined) return true;
      const e = edgeById.get(m.edge);
      return (
        e !== undefined &&
        ((e.from === m.from && e.to === m.to) || (e.from === m.to && e.to === m.from))
      );
    });
    if (!alive) continue;
    if (evidenceOk !== undefined && !evidenceOk(pr.messages.flatMap((m) => m.evidence))) {
      dropped.push(pr.id);
      continue;
    }
    projectionIds.add(pr.id);
    for (const m of pr.messages) messageIds.add(m.id);
    out.push(pr);
  }
  return { carried: out, dropped };
}

/** 이전 실행을 한 줄로 보여줄 때 쓰는 요약 */
export function previousRunSummary(prev: ArchitectureIr): PreviousRunSummary {
  return {
    generatedAt: prev.generatedAt,
    nodeCount: prev.nodes.length,
    edgeCount: prev.edges.length,
    unresolvedOpen: prev.unresolved.filter((q) => !isAnswered(q)).length,
    sourcesUsed: prev.sourcesUsed,
  };
}
