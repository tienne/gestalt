import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonOrQuarantine, writeJsonAtomic } from '../core/json-file.js';
import { parseArchitectureIr } from './ir-schema.js';
import type {
  ArchitectureEdge,
  ArchitectureIr,
  ArchitectureNode,
  ArchitectureView,
  ContextSource,
  UnresolvedQuestion,
} from './types.js';
import { idCarriesCloudId, stripPrivateExcerpts } from './validator.js';

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

  /** private 근거의 excerpt는 디스크에 남기지 않는다. 저장한 경로를 돌려준다 */
  save(ir: ArchitectureIr): string {
    const path = this.irPath(ir.view);
    writeJsonAtomic(path, stripPrivateExcerpts(ir));
    return path;
  }

  saveHtml(view: ArchitectureView, audience: 'private' | 'shared', html: string): string {
    const path = this.htmlPath(view, audience);
    writeTextAtomic(path, html);
    return path;
  }
}

// 브라우저가 열어둔 HTML을 새로고침할 때 반쯤 쓰인 파일을 보지 않게 json과 같은 방식으로 갈아 끼운다
function writeTextAtomic(path: string, content: string): void {
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
  const label = node.label.trim().replace(/\s+/g, ' ').toLowerCase();
  return `${node.kind}\u0000${node.repo}\u0000${label}`;
}

function edgeKey(edge: Pick<ArchitectureEdge, 'from' | 'to' | 'kind'>): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
}

function isAnswered(q: UnresolvedQuestion): boolean {
  return q.answer !== undefined && q.answer.trim() !== '';
}

/**
 * 재실행 IR(next)이 이전 IR(prev)의 id를 물려받게 맞춘다.
 *
 * 생성할 때마다 id가 새로 매겨지면 사람이 단 답이나 화면 위치 기억이 전부 끊긴다.
 * 노드는 kind, repo, 정규화한 label이 같으면 같은 것으로 보고 엣지는 바뀐 노드 id 기준
 * (from, to, kind)가 같으면 같은 것으로 본다. next의 다른 id와 부딪히면 바꾸지 않는다.
 * prev에서 답이 달린 질문은 대상이 merge 결과에 남아 있을 때만 이어 붙인다.
 * 입력은 바꾸지 않는다.
 */
export function mergeWithPrevious(prev: ArchitectureIr, next: ArchitectureIr): ArchitectureIr {
  const prevNodeIdByKey = new Map<string, string>();
  for (const node of prev.nodes) {
    const key = nodeKey(node);
    if (!prevNodeIdByKey.has(key)) prevNodeIdByKey.set(key, node.id);
  }

  const nodeIdMap = new Map<string, string>();
  // 비워진 옛 id를 다시 쓰지 않는다. 연쇄로 바꾸다 보면 한 바퀴 돌아 id가 겹칠 수 있다
  const takenNodeIds = new Set(next.nodes.map((n) => n.id));
  const claimedKeys = new Set<string>();
  for (const node of next.nodes) {
    const key = nodeKey(node);
    if (claimedKeys.has(key)) continue;
    claimedKeys.add(key);
    const prevId = prevNodeIdByKey.get(key);
    if (prevId === undefined || prevId === node.id || takenNodeIds.has(prevId)) continue;
    if (nodeIdMap.has(node.id)) continue;
    // 지난 실행이 계정 ID나 배포 ID를 id에 박았으면 물려받지 않는다. 지금 검증기가 그런 id를 거부한다
    if (idCarriesCloudId(prevId, node.kind)) continue;
    takenNodeIds.add(prevId);
    nodeIdMap.set(node.id, prevId);
  }
  const mapNodeId = (id: string): string => nodeIdMap.get(id) ?? id;

  const nodes = next.nodes.map((n) => ({
    ...n,
    id: mapNodeId(n.id),
    ...(n.parent !== undefined ? { parent: mapNodeId(n.parent) } : {}),
    ...(n.account !== undefined ? { account: mapNodeId(n.account) } : {}),
  }));

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

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edgeIds = new Set(edges.map((e) => e.id));
  const questionIds = new Set(unresolved.map((q) => q.id));
  const sameSubject = (a: UnresolvedQuestion, b: UnresolvedQuestion): boolean =>
    a.subject.nodeId === b.subject.nodeId && a.subject.edgeId === b.subject.edgeId;

  for (const prevQ of prev.unresolved) {
    if (!isAnswered(prevQ)) continue;
    const { nodeId, edgeId } = prevQ.subject;
    if (nodeId !== undefined && !nodeIds.has(nodeId)) continue;
    if (edgeId !== undefined && !edgeIds.has(edgeId)) continue;

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

  return {
    ...next,
    nodes,
    edges,
    unresolved,
    sourcesUsed: next.sourcesUsed,
    ...(next.groups !== undefined
      ? { groups: next.groups.map((g) => ({ ...g, members: g.members.map(mapNodeId).sort() })) }
      : {}),
  };
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
