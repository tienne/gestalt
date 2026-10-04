import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { classifyCliCommand } from '../utils/read-only-tools.js';
import { indexMicroApps } from './micro-app.js';
import { ALL_PACKS_VOCABULARY, irVocabulary, packById } from './packs/index.js';
import {
  FLOW_REF_KINDS,
  HARNESS_KINDS,
  PARENT_KINDS,
  type ArchitectureEdge,
  type ArchitectureFlow,
  type ArchitectureIr,
  type ArchitectureNode,
  type Evidence,
  type LineStyle,
  type NodeKind,
  type Platform,
  type UnresolvedQuestion,
} from './types.js';

export type ArchitectureValidationErrorCode =
  | 'SOLID_EDGE_WITHOUT_EVIDENCE'
  | 'CODE_EVIDENCE_NOT_FOUND'
  | 'PRIVATE_EXCERPT_PRESENT'
  | 'DANGLING_EDGE'
  | 'PARENT_NOT_FOUND'
  | 'PARENT_CYCLE'
  | 'INVALID_PARENT_KIND'
  | 'LIVE_COMMAND_NOT_READ_ONLY'
  | 'ACCOUNT_NOT_FOUND'
  | 'INVALID_ACCOUNT_KIND'
  | 'CLOUD_ID_IN_ID'
  | 'GROUP_MEMBER_NOT_FOUND'
  | 'DUPLICATE_GROUP_ID'
  | 'SERVES_SERVICE_WITH_APPS'
  | 'INVALID_LOADS_ENDS'
  | 'INVALID_HARNESS_EDGE_ENDS'
  | 'INVALID_CALL_ACTIONS'
  | 'UNKNOWN_MCP_ACTION'
  | 'MD_CODE_EVIDENCE'
  | 'FLOW_SERVICE_NOT_FOUND'
  | 'DUPLICATE_FLOW_ID'
  | 'FLOW_ACTOR_NOT_FOUND'
  | 'FLOW_STEP_NOT_FOUND'
  | 'FLOW_REF_NOT_FOUND'
  | 'INVALID_FLOW_REF_KIND'
  | 'SOLID_TRANSITION_WITHOUT_EVIDENCE'
  | 'DUPLICATE_STAGE_ID'
  | 'STAGE_NODE_NOT_FOUND'
  | 'STAGE_NODE_TWICE'
  | 'UNKNOWN_PACK'
  | 'KIND_NOT_IN_PACKS';

export interface ArchitectureValidationError {
  code: ArchitectureValidationErrorCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
  flowId?: string;
  stepId?: string;
  transitionId?: string;
  evidenceIndex?: number;
}

export interface ValidatedIr {
  ir: ArchitectureIr;
  drawableNodeIds: Set<string>;
  drawableEdgeIds: Set<string>;
  /** 근거가 있는 흐름 단계. 없는 단계는 그리지 않고 질문으로 간다 */
  drawableStepIds: Set<string>;
  /** 근거가 있고 양 끝 단계가 그려지는 전이 */
  drawableTransitionIds: Set<string>;
  autoUnresolved: UnresolvedQuestion[];
}

export interface ValidateArchitectureIrOptions {
  /** 비우면 ir.repos의 root를 쓴다 */
  repoRoots?: Record<string, string>;
  /** 기본 true. false면 code 근거의 파일 존재와 줄 범위를 확인하지 않는다 */
  checkFiles?: boolean;
}

export type ValidateArchitectureIrResult =
  | { ok: true; value: ValidatedIr }
  | { ok: false; errors: ArchitectureValidationError[] };

const CODE_LOCATION_RE = /^([^:]+):(.+):(\d+)$/;
/** AWS 계정 ID 꼴(숫자 12자리). 앞뒤가 숫자면 더 긴 수의 일부라 계정 ID로 보지 않는다 */
export const ACCOUNT_ID_RE = /(?<!\d)\d{12}(?!\d)/g;
// CloudFront 배포 ID 꼴. 대문자 id나 이름과 헷갈릴 수 있어 이름은 cdn 노드에서만, 질문 글자는 통째로 가린다
const DISTRIBUTION_ID_RE = /\bE[0-9A-Z]{12,13}\b/g;

// live 근거만 있는 선은 점선이다. 조회는 지금 그렇다는 사실이지 코드가 그렇게 만든다는 증거가 아니라서
// 다음 배포에 바뀔 수 있다. 코드나 스펙이 함께 있어야 실선이 된다
export function deriveLineStyle(evidence: Evidence[]): LineStyle {
  return evidence.some((e) => e.type === 'code' || e.type === 'spec') ? 'solid' : 'dashed';
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

// 같은 파일을 근거로 여러 번 가리키는 게 흔해서 한 번 검증하는 동안만 줄 수를 기억한다.
type LineCountCache = Map<string, number | null>;

function readLineCount(absPath: string, cache: LineCountCache): number | null {
  if (cache.has(absPath)) return cache.get(absPath)!;
  let count: number | null = null;
  try {
    if (statSync(absPath).isFile()) count = countLines(readFileSync(absPath, 'utf-8'));
  } catch {
    count = null;
  }
  cache.set(absPath, count);
  return count;
}

/** code 근거 위치가 실제 파일의 실제 줄을 가리키는지 본다. 문제가 없으면 null */
function checkCodeLocation(
  location: string,
  repoRoots: Record<string, string>,
  cache: LineCountCache,
): string | null {
  const match = CODE_LOCATION_RE.exec(location);
  if (!match) {
    return `code 근거 위치 "${location}"가 <repoId>:<relPath>:<line> 꼴이 아니다.`;
  }
  const repoId = match[1]!;
  const relPath = match[2]!;
  const line = Number(match[3]!);
  const root = repoRoots[repoId];
  if (!root) {
    return `code 근거 위치 "${location}"의 레포 "${repoId}"를 repos에서 찾지 못했다.`;
  }
  if (isAbsolute(relPath)) {
    return `code 근거 위치 "${location}"의 경로가 절대 경로다. 레포 루트 기준 상대 경로여야 한다.`;
  }
  const rootAbs = resolve(root);
  const fileAbs = resolve(rootAbs, relPath);
  const rel = relative(rootAbs, fileAbs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return `code 근거 위치 "${location}"의 경로가 레포 루트 밖을 가리킨다.`;
  }
  const lineCount = readLineCount(fileAbs, cache);
  if (lineCount === null) {
    return `code 근거 위치 "${location}"의 파일이 레포 "${repoId}"에 없다.`;
  }
  if (line < 1 || line > lineCount) {
    return `code 근거 위치 "${location}"의 줄 번호 ${line}이 파일 범위(1~${lineCount}) 밖이다.`;
  }
  return null;
}

function checkEvidenceList(
  evidence: Evidence[],
  owner:
    | { nodeId: string }
    | { edgeId: string }
    | { flowId: string; stepId: string }
    | { flowId: string; transitionId: string },
  ctx: { checkFiles: boolean; repoRoots: Record<string, string>; cache: LineCountCache },
  errors: ArchitectureValidationError[],
): void {
  evidence.forEach((ev, evidenceIndex) => {
    if (ev.visibility === 'private' && ev.excerpt !== undefined) {
      errors.push({
        code: 'PRIVATE_EXCERPT_PRESENT',
        message:
          ev.type === 'live'
            ? `private live 근거 "${ev.location}"에 조회 응답 원문(excerpt)이 들어 있다. 명령과 조회 시각만 남긴다.`
            : `private 근거 "${ev.location}"에 excerpt가 들어 있다. private 근거는 원문을 싣지 않는다.`,
        ...owner,
        evidenceIndex,
      });
    }
    if (ev.type === 'live' && ev.command !== undefined) {
      const verdict = classifyCliCommand(ev.command);
      if (verdict !== 'allow') {
        errors.push({
          code: 'LIVE_COMMAND_NOT_READ_ONLY',
          message: `live 근거의 명령 "${ev.command}"이 읽기 전용 조회로 판정되지 않는다(${verdict}). 하위 명령은 list, get, describe만 쓴다.`,
          ...owner,
          evidenceIndex,
        });
      }
    }
    if (ev.type === 'code' && ctx.checkFiles) {
      const problem = checkCodeLocation(ev.location, ctx.repoRoots, ctx.cache);
      if (problem) {
        errors.push({ code: 'CODE_EVIDENCE_NOT_FOUND', message: problem, ...owner, evidenceIndex });
      }
    }
  });
}

function checkGroups(ir: ArchitectureIr, errors: ArchitectureValidationError[]): void {
  const nodeIds = new Set(ir.nodes.map((n) => n.id));
  const seen = new Set<string>();
  for (const group of ir.groups ?? []) {
    if (seen.has(group.id)) {
      errors.push({ code: 'DUPLICATE_GROUP_ID', message: `그룹 id "${group.id}"가 겹친다.` });
    }
    seen.add(group.id);
    for (const member of group.members) {
      if (nodeIds.has(member)) continue;
      errors.push({
        code: 'GROUP_MEMBER_NOT_FOUND',
        message: `그룹 "${group.id}"의 member "${member}"가 nodes에 없다.`,
        nodeId: member,
      });
    }
  }
}

// 한 노드를 두 구간에 이름으로 올리면 어느 칸에 설지 입력 순서가 정하게 된다. 세션이 의도를 밝히게 거부한다
function checkStages(ir: ArchitectureIr, errors: ArchitectureValidationError[]): void {
  const nodeIds = new Set(ir.nodes.map((n) => n.id));
  const seen = new Set<string>();
  const listedIn = new Map<string, string>();
  for (const stage of ir.stages ?? []) {
    if (seen.has(stage.id)) {
      errors.push({ code: 'DUPLICATE_STAGE_ID', message: `구간 id "${stage.id}"가 겹친다.` });
    }
    seen.add(stage.id);
    for (const id of stage.nodes ?? []) {
      if (!nodeIds.has(id)) {
        errors.push({
          code: 'STAGE_NODE_NOT_FOUND',
          message: `구간 "${stage.id}"의 노드 "${id}"가 nodes에 없다.`,
          nodeId: id,
        });
        continue;
      }
      const other = listedIn.get(id);
      if (other !== undefined && other !== stage.id) {
        errors.push({
          code: 'STAGE_NODE_TWICE',
          message: `노드 "${id}"가 구간 "${other}"와 "${stage.id}"에 함께 올라 있다. 한 구간에만 둔다.`,
          nodeId: id,
        });
      }
      listedIn.set(id, stage.id);
    }
  }
}

function checkAccounts(ir: ArchitectureIr, errors: ArchitectureValidationError[]): void {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  for (const node of ir.nodes) {
    if (node.account === undefined) continue;
    const account = byId.get(node.account);
    if (!account) {
      errors.push({
        code: 'ACCOUNT_NOT_FOUND',
        message: `노드 "${node.id}"의 account "${node.account}"가 nodes에 없다.`,
        nodeId: node.id,
      });
    } else if (account.kind !== 'cloud_account') {
      errors.push({
        code: 'INVALID_ACCOUNT_KIND',
        message: `노드 "${node.id}"의 account는 cloud_account 노드여야 하는데 ${account.kind}다.`,
        nodeId: node.id,
      });
    }
  }
}

// id는 HTML 속성과 주소창 해시에 그대로 실려 공유본에서도 못 가린다. 계정 ID와 배포 ID는 label에만 두고 id는 별칭으로 짓게 한다
const accountLike = (id: string): boolean => new RegExp(ACCOUNT_ID_RE.source).test(id);
const distributionLike = (id: string): boolean => new RegExp(DISTRIBUTION_ID_RE.source).test(id);

/** 이 id가 공유본에서 못 가리는 클라우드 식별자를 담는지. kind를 모르면(엣지) 계정 ID만 본다 */
export function idCarriesCloudId(id: string, kind?: NodeKind): boolean {
  return accountLike(id) || (kind === 'cdn' && distributionLike(id));
}

function checkIdsForCloudIds(ir: ArchitectureIr, errors: ArchitectureValidationError[]): void {
  for (const node of ir.nodes) {
    const what = accountLike(node.id)
      ? '계정 ID로 보이는 12자리 숫자'
      : idCarriesCloudId(node.id, node.kind)
        ? 'CDN 배포 ID'
        : undefined;
    if (what === undefined) continue;
    errors.push({
      code: 'CLOUD_ID_IN_ID',
      message: `노드 id "${node.id}"에 ${what}가 들어 있다. id는 별칭(prod-customer 같은)으로 짓고 실제 ID는 label에 둔다.`,
      nodeId: node.id,
    });
  }
  for (const edge of ir.edges) {
    if (!accountLike(edge.id)) continue;
    errors.push({
      code: 'CLOUD_ID_IN_ID',
      message: `엣지 id "${edge.id}"에 계정 ID로 보이는 12자리 숫자가 들어 있다. id는 별칭으로 짓는다.`,
      edgeId: edge.id,
    });
  }
}

function checkParents(ir: ArchitectureIr, errors: ArchitectureValidationError[]): void {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  for (const node of ir.nodes) {
    if (node.parent === undefined) continue;
    const parent = byId.get(node.parent);
    if (!parent) {
      errors.push({
        code: 'PARENT_NOT_FOUND',
        message: `노드 "${node.id}"의 parent "${node.parent}"가 nodes에 없다.`,
        nodeId: node.id,
      });
      continue;
    }
    // 고리에 걸린 노드마다 한 번씩만 알린다. 고리 밖에서 고리로 들어가는 노드는 고리 쪽 에러로 충분하다
    const seen = new Set<string>([node.id]);
    let cursor: ArchitectureNode | undefined = parent;
    while (cursor) {
      if (cursor.id === node.id) {
        errors.push({
          code: 'PARENT_CYCLE',
          message: `노드 "${node.id}"의 parent를 따라가면 자기 자신으로 돌아온다.`,
          nodeId: node.id,
        });
        break;
      }
      if (seen.has(cursor.id) || cursor.parent === undefined) break;
      seen.add(cursor.id);
      cursor = byId.get(cursor.parent);
    }
    const allowed =
      node.kind === 'endpoint' && node.protocol !== 'mcp' ? undefined : PARENT_KINDS[node.kind];
    if (!allowed?.includes(parent.kind)) {
      errors.push({
        code: 'INVALID_PARENT_KIND',
        message: allowed
          ? `${node.kind} 노드 "${node.id}"의 parent는 ${allowed.join(' 또는 ')}여야 하는데 ${parent.kind}다.`
          : `${node.kind} 노드 "${node.id}"는 parent를 가질 수 없다.`,
        nodeId: node.id,
      });
    }
  }
}

/**
 * 마이크로 프론트엔드 규칙. 호스트와 리모트는 버킷, CDN, 도메인을 따로 가지므로 서빙 사슬은 자기 앱을 가리켜야 한다.
 * 앱이 달린 서비스를 serves로 가리키면 어느 앱 인프라인지 구조에서 사라져 거부한다
 */
function checkMicroApps(ir: ArchitectureIr, errors: ArchitectureValidationError[]): void {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const grouped = new Set(
    ir.nodes.filter((n) => n.kind === 'micro_app' && n.parent !== undefined).map((n) => n.parent!),
  );
  for (const edge of ir.edges) {
    if (edge.kind === 'serves' && grouped.has(edge.to)) {
      errors.push({
        code: 'SERVES_SERVICE_WITH_APPS',
        message: `엣지 "${edge.id}"가 micro_app이 달린 서비스 "${edge.to}"를 serves로 가리킨다. 서빙 사슬은 그 인프라를 쓰는 호스트나 리모트 micro_app을 가리켜야 한다.`,
        edgeId: edge.id,
      });
    }
    if (edge.kind !== 'loads') continue;
    const ends = [edge.from, edge.to].map((id) => byId.get(id)?.kind);
    if (ends.every((k) => k === 'micro_app' || k === undefined)) continue;
    // 하네스 클라이언트가 플러그인을 읽어 들이는 것도 런타임 로드다
    if (ends[0] === 'client' && (ends[1] === 'service' || ends[1] === undefined)) continue;
    errors.push({
      code: 'INVALID_LOADS_ENDS',
      message: `loads 엣지 "${edge.id}"는 micro_app에서 micro_app으로, 또는 client에서 service로만 이을 수 있는데 ${ends.join(' → ')}다.`,
      edgeId: edge.id,
    });
  }
}

/** 노드와 엣지 kind는 IR이 적은 팩(requires 포함)에 있어야 한다. 안 적은 팩의 kind가 섞이면 어떤 범례로 읽을지 정할 수 없다 */
function checkPacks(ir: ArchitectureIr, errors: ArchitectureValidationError[]): void {
  for (const id of ir.packs ?? []) {
    if (packById(id) === undefined) {
      errors.push({ code: 'UNKNOWN_PACK', message: `packs의 "${id}"는 없는 팩이다.` });
    }
  }
  const vocab = irVocabulary(ir);
  const declared = vocab.packIds.join(', ');
  for (const node of ir.nodes) {
    if (!(node.kind in vocab.nodeKinds)) {
      errors.push({
        code: 'KIND_NOT_IN_PACKS',
        message: `노드 "${node.id}"의 kind ${node.kind}는 이 IR의 팩(${declared})에 없다. packs에 그 kind가 든 팩을 더한다.`,
        nodeId: node.id,
      });
    }
  }
  for (const edge of ir.edges) {
    if (!(edge.kind in vocab.edgeKinds)) {
      errors.push({
        code: 'KIND_NOT_IN_PACKS',
        message: `엣지 "${edge.id}"의 kind ${edge.kind}는 이 IR의 팩(${declared})에 없다. packs에 그 kind가 든 팩을 더한다.`,
        edgeId: edge.id,
      });
    }
  }
}

/** 양 끝 kind를 정해둔 엣지. 규칙은 팩의 edgeKinds.ends에 있고 키에 없는 엣지 kind는 여기서 보지 않는다 */
const HARNESS_EDGE_ENDS: Partial<
  Record<ArchitectureEdge['kind'], { from: readonly string[]; to: readonly string[] }>
> = Object.fromEntries(
  Object.entries(ALL_PACKS_VOCABULARY.edgeKinds).flatMap(([k, d]) =>
    d.ends === undefined ? [] : [[k, d.ends]],
  ),
);

function isMcpEndpoint(node: ArchitectureNode | undefined): boolean {
  return node?.kind === 'endpoint' && node.protocol === 'mcp';
}

function checkHarnessEdges(ir: ArchitectureIr, errors: ArchitectureValidationError[]): void {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  for (const edge of ir.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    // 끝점이 없는 엣지는 DANGLING_EDGE가 따로 잡는다
    if (from === undefined || to === undefined) continue;
    const ends = HARNESS_EDGE_ENDS[edge.kind];
    if (ends !== undefined && (!ends.from.includes(from.kind) || !ends.to.includes(to.kind))) {
      errors.push({
        code: 'INVALID_HARNESS_EDGE_ENDS',
        message: `${edge.kind} 엣지 "${edge.id}"는 ${ends.from.join(', ')}에서 ${ends.to.join(', ')}로만 이을 수 있는데 ${from.kind} → ${to.kind}다.`,
        edgeId: edge.id,
      });
    }
    if (edge.kind === 'calls' && (from.kind === 'skill' || from.kind === 'agent')) {
      if (to.kind !== 'endpoint') {
        errors.push({
          code: 'INVALID_HARNESS_EDGE_ENDS',
          message: `calls 엣지 "${edge.id}"는 ${from.kind}에서 endpoint로만 이을 수 있는데 ${to.kind}를 가리킨다. 다른 스킬은 invokes, 에이전트는 spawns로 잇는다.`,
          edgeId: edge.id,
        });
      }
    }
    if (edge.actions === undefined) continue;
    if (edge.kind !== 'calls' || !isMcpEndpoint(to)) {
      errors.push({
        code: 'INVALID_CALL_ACTIONS',
        message: `엣지 "${edge.id}"에 actions가 있다. actions는 mcp endpoint로 가는 calls에만 단다.`,
        edgeId: edge.id,
      });
      continue;
    }
    if (to.actions === undefined) continue;
    const unknown = edge.actions.filter((a) => !to.actions!.includes(a));
    if (unknown.length === 0) continue;
    errors.push({
      code: 'UNKNOWN_MCP_ACTION',
      message: `엣지 "${edge.id}"가 도구 "${to.label}"에 없는 action ${unknown.map((a) => `"${a}"`).join(', ')}을 부른다. 도구의 actions는 ${to.actions.join(', ')}이다.`,
      edgeId: edge.id,
    });
  }
}

const MD_PATH_RE = /\.mdx?$/i;

/**
 * 하네스 IR에서 md 파일 줄을 code 근거로 받는 자리를 스킬과 에이전트로 좁힌다. 세션이 실행하는 지시문만 코드로 친다.
 * README나 docs의 언급까지 실선이 되면 문서에 적힌 계획과 실제 동작이 그림에서 안 갈린다.
 * 웹 IR은 README 줄을 code로 써 온 결과가 있어 하네스 kind가 있을 때만 건다
 */
function checkMdCodeEvidence(ir: ArchitectureIr, errors: ArchitectureValidationError[]): void {
  if (!ir.nodes.some((n) => HARNESS_KINDS.includes(n.kind))) return;
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const instructionKind = (id: string): boolean => {
    const kind = byId.get(id)?.kind;
    return kind === 'skill' || kind === 'agent';
  };
  const mdIndexes = (evidence: Evidence[]): number[] =>
    evidence.flatMap((ev, i) => {
      if (ev.type !== 'code') return [];
      const match = CODE_LOCATION_RE.exec(ev.location);
      return match && MD_PATH_RE.test(match[2]!) ? [i] : [];
    });
  const message = (location: string, subject: string): string =>
    `${subject}의 code 근거 "${location}"가 md 파일이다. md 줄을 code로 받는 건 skill, agent 노드와 그 둘에서 나가는 엣지뿐이다. 문서 언급이면 doc 근거로 바꾼다.`;
  for (const node of ir.nodes) {
    if (instructionKind(node.id)) continue;
    for (const i of mdIndexes(node.evidence)) {
      errors.push({
        code: 'MD_CODE_EVIDENCE',
        message: message(node.evidence[i]!.location, `노드 "${node.id}"`),
        nodeId: node.id,
        evidenceIndex: i,
      });
    }
  }
  for (const edge of ir.edges) {
    if (instructionKind(edge.from)) continue;
    for (const i of mdIndexes(edge.evidence)) {
      errors.push({
        code: 'MD_CODE_EVIDENCE',
        message: message(edge.evidence[i]!.location, `엣지 "${edge.id}"`),
        edgeId: edge.id,
        evidenceIndex: i,
      });
    }
  }
}

// 자동 질문은 페이지에 그대로 보이므로 사람이 부르는 이름으로 묻는다
function nameOf(node: ArchitectureNode): string {
  return node.displayName ?? node.label;
}

const PLATFORM_QUESTION: Record<Platform, string> = {
  web: '웹',
  android: 'Android 앱',
  ios: 'iOS 앱',
};

/** 서비스나 그 서비스에 달린 micro_app을 버킷이나 서버가 서빙하는지 */
function isServedByWebHost(
  serviceId: string,
  edges: ArchitectureEdge[],
  nodeById: Map<string, ArchitectureNode>,
  drawableEdgeIds: Set<string>,
): boolean {
  const target = (id: string): boolean => {
    const n = nodeById.get(id);
    return id === serviceId || (n?.kind === 'micro_app' && n.parent === serviceId);
  };
  return edges.some(
    (e) =>
      e.kind === 'serves' &&
      target(e.to) &&
      drawableEdgeIds.has(e.id) &&
      (nodeById.get(e.from)?.kind === 'bucket' || nodeById.get(e.from)?.kind === 'deploy_target'),
  );
}

function hasQuestionFor(
  unresolved: UnresolvedQuestion[],
  subject: UnresolvedQuestion['subject'],
): boolean {
  return unresolved.some(
    (q) =>
      q.subject.nodeId === subject.nodeId &&
      q.subject.edgeId === subject.edgeId &&
      q.subject.stepId === subject.stepId &&
      q.subject.transitionId === subject.transitionId,
  );
}

type EvidenceCtx = Parameters<typeof checkEvidenceList>[2];

/**
 * 흐름 구조 검사. 단계와 전이 id는 흐름을 넘어 겹치면 안 된다. 질문의 stepId, transitionId가 흐름 id 없이 가리키기 때문이다.
 * refs는 기술 그림으로 내려가는 입구라 없는 노드나 화면, API가 아닌 노드를 가리키면 거부한다
 */
function checkFlows(
  ir: ArchitectureIr,
  ctx: EvidenceCtx,
  errors: ArchitectureValidationError[],
): void {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const dup = (flowId: string, id: string, what: string): void => {
    if (!seen.has(`${what}\u0000${id}`)) {
      seen.add(`${what}\u0000${id}`);
      return;
    }
    errors.push({
      code: 'DUPLICATE_FLOW_ID',
      message: `흐름 "${flowId}"의 ${what} id "${id}"가 다른 곳에서도 쓰인다. 흐름 전체에서 겹치지 않아야 한다.`,
      flowId,
    });
  };
  for (const flow of ir.flows ?? []) {
    dup(flow.id, flow.id, '흐름');
    if (byId.get(flow.service)?.kind !== 'service') {
      errors.push({
        code: 'FLOW_SERVICE_NOT_FOUND',
        message: `흐름 "${flow.id}"의 service "${flow.service}"가 service 노드가 아니거나 nodes에 없다.`,
        flowId: flow.id,
      });
    }
    const actorIds = new Set<string>();
    for (const a of flow.actors) {
      if (actorIds.has(a.id)) {
        errors.push({
          code: 'DUPLICATE_FLOW_ID',
          message: `흐름 "${flow.id}"에 행위자 id "${a.id}"가 두 번 있다.`,
          flowId: flow.id,
        });
      }
      actorIds.add(a.id);
    }
    const stepIds = new Set<string>();
    for (const step of flow.steps) {
      dup(flow.id, step.id, '단계');
      stepIds.add(step.id);
      const where = { flowId: flow.id, stepId: step.id };
      if (!actorIds.has(step.actor)) {
        errors.push({
          code: 'FLOW_ACTOR_NOT_FOUND',
          message: `단계 "${step.id}"의 actor "${step.actor}"가 흐름 "${flow.id}"의 actors에 없다.`,
          ...where,
        });
      }
      for (const ref of step.refs ?? []) {
        const target = byId.get(ref);
        if (!target) {
          errors.push({
            code: 'FLOW_REF_NOT_FOUND',
            message: `단계 "${step.id}"의 refs "${ref}"가 nodes에 없다.`,
            ...where,
          });
        } else if (!FLOW_REF_KINDS.includes(target.kind)) {
          errors.push({
            code: 'INVALID_FLOW_REF_KIND',
            message: `단계 "${step.id}"의 refs "${ref}"는 ${target.kind}다. ${FLOW_REF_KINDS.join(', ')}만 가리킬 수 있다.`,
            ...where,
          });
        }
      }
      checkEvidenceList(step.evidence, where, ctx, errors);
    }
    for (const t of flow.transitions) {
      dup(flow.id, t.id, '전이');
      const where = { flowId: flow.id, transitionId: t.id };
      const missing = [t.from, t.to].filter((id) => !stepIds.has(id));
      if (missing.length > 0) {
        errors.push({
          code: 'FLOW_STEP_NOT_FOUND',
          message: `전이 "${t.id}"가 흐름 "${flow.id}"에 없는 단계 ${missing.map((id) => `"${id}"`).join(', ')}를 가리킨다.`,
          ...where,
        });
      }
      for (const actor of t.actors ?? []) {
        if (actorIds.has(actor)) continue;
        errors.push({
          code: 'FLOW_ACTOR_NOT_FOUND',
          message: `전이 "${t.id}"의 actors "${actor}"가 흐름 "${flow.id}"의 actors에 없다.`,
          ...where,
        });
      }
      // 엣지와 같은 규칙이다. 실선은 상태를 바꾸는 코드를 봤다는 주장이라 기획서만으로는 못 긋는다
      if (t.lineStyle === 'solid' && deriveLineStyle(t.evidence) !== 'solid') {
        errors.push({
          code: 'SOLID_TRANSITION_WITHOUT_EVIDENCE',
          message:
            t.evidence.length === 0
              ? `전이 "${t.id}"가 실선인데 근거가 하나도 없다. 근거를 달거나 점선으로 바꿔 미해결 질문으로 돌려야 한다.`
              : `전이 "${t.id}"가 실선인데 code나 spec 근거가 없다. 기획서나 지식베이스(doc)만 있으면 점선이어야 한다.`,
          ...where,
        });
      }
      checkEvidenceList(t.evidence, where, ctx, errors);
    }
  }
}

/**
 * 사람이 두 단계 사이를 잇기만 하는 단계를 찾아 전이로 적을지 묻는다.
 * 들어오고 나가는 선이 하나씩이고 나간 선이 이미 다른 길로 닿는 단계로 합류할 때가 그렇다.
 * 그중 상태 값이 없거나 앞 단계로 되돌아가는 것만 고른다. 상태가 남고 앞으로 나아가는 단계는 진짜 단계라서다
 */
function askStepsAsTransitions(
  flow: ArchitectureFlow,
  drawable: Set<string>,
  ask: (q: UnresolvedQuestion) => void,
): void {
  const people = new Set(flow.actors.filter((a) => a.kind === 'person').map((a) => a.id));
  const name = new Map(flow.steps.map((s) => [s.id, s.label]));
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length > 0) {
      const at = queue.shift()!;
      if (at === target) return true;
      for (const t of flow.transitions) {
        if (t.from !== at || seen.has(t.to)) continue;
        seen.add(t.to);
        queue.push(t.to);
      }
    }
    return false;
  };
  for (const step of flow.steps) {
    if (!drawable.has(step.id) || !people.has(step.actor)) continue;
    const ins = flow.transitions.filter((t) => t.to === step.id);
    const outs = flow.transitions.filter((t) => t.from === step.id);
    if (ins.length !== 1 || outs.length !== 1) continue;
    const from = ins[0]!.from;
    const to = outs[0]!.to;
    // 들어온 단계로 바로 돌아가는 건 그 단계를 되돌린 것이지 이 단계가 잇는 게 아니다
    if (from === to) continue;
    const rejoins = flow.transitions.some((t) => t.to === to && t.from !== step.id);
    if (!rejoins) continue;
    if (step.state !== undefined && !reaches(to, from)) continue;
    ask({
      id: `auto:as-transition:${step.id}`,
      subject: { stepId: step.id },
      question: `"${step.label}" 단계는 "${name.get(from) ?? from}"에서 "${name.get(to) ?? to}"로 넘어가는 동작이라 전이로 적을 수 있어요. 이 단계에 머무는 상태가 따로 있나요? 없으면 전이의 label과 actors로 옮기는 게 읽기 편해요.`,
    });
  }
}

/**
 * 나가는 전이가 없는데 끝 단계로 표시하지 않은 단계를 묻는다.
 * 미루기처럼 다시 줄로 돌아가는 단계가 선을 빠뜨리면 그림만 봐서는 흐름이 거기서 끝난 것처럼 읽힌다
 */
function askDeadEnds(
  flow: ArchitectureFlow,
  drawable: Set<string>,
  ask: (q: UnresolvedQuestion) => void,
): void {
  const hasOut = new Set(flow.transitions.map((t) => t.from));
  for (const step of flow.steps) {
    if (step.terminal || hasOut.has(step.id) || !drawable.has(step.id)) continue;
    ask({
      id: `auto:dead-end:${step.id}`,
      subject: { stepId: step.id },
      question: `"${step.label}" 단계 다음에 어디로 가는지 못 찾았어요. 흐름이 여기서 끝나나요, 아니면 이어지는 단계가 있나요?`,
    });
  }
}

/** 근거로 다시 정한 선 모양을 싣는다. 그릴 단계와 전이를 고르고 근거 없는 것은 질문으로 돌린다 */
function settleFlows(
  flows: ArchitectureFlow[],
  ask: (q: UnresolvedQuestion) => void,
  askById: (q: UnresolvedQuestion) => void,
): { flows: ArchitectureFlow[]; steps: Set<string>; transitions: Set<string> } {
  const steps = new Set<string>();
  const transitions = new Set<string>();
  const settled = flows.map((flow) => {
    const stepName = new Map(flow.steps.map((s) => [s.id, s.label]));
    for (const step of flow.steps) {
      if (step.evidence.length > 0) {
        steps.add(step.id);
        continue;
      }
      ask({
        id: `auto:step:${step.id}`,
        subject: { stepId: step.id },
        question: `"${flow.title}"의 "${step.label}" 단계를 코드나 지식베이스, 기획서에서 확인하지 못했어요. 실제로 있는 단계인가요?`,
      });
    }
    // 세션이 그 단계에 다른 질문을 이미 달았어도 이 질문은 따로 선다
    askStepsAsTransitions(flow, steps, askById);
    askDeadEnds(flow, steps, askById);
    const transitionsOut = flow.transitions.map((t) => ({
      ...t,
      lineStyle: deriveLineStyle(t.evidence),
    }));
    for (const t of transitionsOut) {
      if (t.evidence.length === 0) {
        ask({
          id: `auto:transition:${t.id}`,
          subject: { transitionId: t.id },
          question: `"${stepName.get(t.from) ?? t.from}"에서 "${stepName.get(t.to) ?? t.to}"로 넘어가는 걸 코드나 문서에서 확인하지 못했어요. 실제로 이렇게 넘어가나요?`,
        });
        continue;
      }
      if (steps.has(t.from) && steps.has(t.to)) transitions.add(t.id);
    }
    return { ...flow, transitions: transitionsOut };
  });
  return { flows: settled, steps, transitions };
}

/**
 * ArchitectureIr를 그리기 전에 검증한다.
 * 근거가 없는 노드나 엣지는 에러로 보지 않고 그리기 대상에서 빼며 미해결 질문을 만든다.
 * 엣지의 lineStyle은 근거 종류로 다시 계산해 반환하는 ir에 덮어쓴다. 입력은 바꾸지 않는다.
 */
export function validateArchitectureIr(
  ir: ArchitectureIr,
  opts: ValidateArchitectureIrOptions = {},
): ValidateArchitectureIrResult {
  const checkFiles = opts.checkFiles ?? true;
  const repoRoots = opts.repoRoots ?? Object.fromEntries(ir.repos.map((r) => [r.id, r.root]));
  const ctx = { checkFiles, repoRoots, cache: new Map<string, number | null>() };
  const errors: ArchitectureValidationError[] = [];
  const nodeIds = new Set(ir.nodes.map((n) => n.id));

  for (const node of ir.nodes) {
    checkEvidenceList(node.evidence, { nodeId: node.id }, ctx, errors);
    for (const platform of Object.keys(node.platformEvidence ?? {}).sort() as Platform[]) {
      checkEvidenceList(node.platformEvidence![platform]!, { nodeId: node.id }, ctx, errors);
    }
  }
  checkPacks(ir, errors);
  checkParents(ir, errors);
  checkAccounts(ir, errors);
  checkGroups(ir, errors);
  checkStages(ir, errors);
  checkIdsForCloudIds(ir, errors);
  checkMicroApps(ir, errors);
  checkHarnessEdges(ir, errors);
  checkMdCodeEvidence(ir, errors);
  checkFlows(ir, ctx, errors);

  for (const edge of ir.edges) {
    const missing = [edge.from, edge.to].filter((id) => !nodeIds.has(id));
    if (missing.length > 0) {
      errors.push({
        code: 'DANGLING_EDGE',
        message: `엣지 "${edge.id}"가 nodes에 없는 노드 ${missing.map((id) => `"${id}"`).join(', ')}를 가리킨다.`,
        edgeId: edge.id,
      });
    }
    // 실선은 "코드나 스펙으로 확인했다"는 주장이라 근거 없이 내면 그림 전체를 믿을 수 없게 된다.
    // 그래서 미해결로 조용히 돌리지 않고 거부한다. 근거 없는 점선 엣지만 (e)에서 미해결로 간다.
    if (edge.lineStyle === 'solid' && deriveLineStyle(edge.evidence) !== 'solid') {
      errors.push({
        code: 'SOLID_EDGE_WITHOUT_EVIDENCE',
        message:
          edge.evidence.length === 0
            ? `엣지 "${edge.id}"가 실선인데 근거가 하나도 없다. 근거를 달거나 점선으로 바꿔 미해결 질문으로 돌려야 한다.`
            : `엣지 "${edge.id}"가 실선인데 code나 spec 근거가 없다. doc, user, live 근거만 있으면 점선이어야 한다.`,
        edgeId: edge.id,
      });
    }
    checkEvidenceList(edge.evidence, { edgeId: edge.id }, ctx, errors);
  }

  if (errors.length > 0) return { ok: false, errors };

  const drawableNodeIds = new Set<string>();
  const drawableEdgeIds = new Set<string>();
  const autoUnresolved: UnresolvedQuestion[] = [];
  const known = [...ir.unresolved];
  const ask = (q: UnresolvedQuestion): void => {
    if (hasQuestionFor(known, q.subject)) return;
    known.push(q);
    autoUnresolved.push(q);
  };
  // 한 대상에 질문이 여럿 설 수 있는 자리다. 대상이 아니라 id로 겹침을 본다
  const askById = (q: UnresolvedQuestion): void => {
    if (known.some((k) => k.id === q.id)) return;
    known.push(q);
    autoUnresolved.push(q);
  };

  for (const node of ir.nodes) {
    if (node.evidence.length > 0) {
      drawableNodeIds.add(node.id);
      continue;
    }
    ask({
      id: `auto:node:${node.id}`,
      subject: { nodeId: node.id },
      question: `"${nameOf(node)}"가 어디에 정의돼 있는지 못 찾았어요. 위치를 알려주실 수 있나요?`,
    });
  }

  const nodeById = new Map(ir.nodes.map((n) => [n.id, n]));
  const nameById = (id: string): string => {
    const n = nodeById.get(id);
    return n ? nameOf(n) : id;
  };
  const edges: ArchitectureEdge[] = ir.edges.map((edge) => ({
    ...edge,
    lineStyle: deriveLineStyle(edge.evidence),
  }));
  for (const edge of edges) {
    if (edge.evidence.length === 0) {
      ask({
        id: `auto:edge:${edge.id}`,
        subject: { edgeId: edge.id },
        question: `"${nameById(edge.from)}"에서 "${nameById(edge.to)}"로 가는 연결을 코드나 문서에서 확인하지 못했어요. 실제로 이어져 있나요?`,
      });
      continue;
    }
    if (drawableNodeIds.has(edge.from) && drawableNodeIds.has(edge.to)) {
      drawableEdgeIds.add(edge.id);
    }
  }

  for (const node of ir.nodes) {
    if (node.kind !== 'service' || !drawableNodeIds.has(node.id)) continue;
    for (const platform of node.platforms ?? []) {
      if ((node.platformEvidence?.[platform] ?? []).length > 0) continue;
      if (platform === 'web' && isServedByWebHost(node.id, edges, nodeById, drawableEdgeIds))
        continue;
      askById({
        id: `auto:platform:${node.id}:${platform}`,
        subject: { nodeId: node.id },
        question: `"${nameOf(node)}"를 ${PLATFORM_QUESTION[platform]}으로 배포한다는 근거를 못 찾았어요. 배포 워크플로나 스토어 설정이 어디 있나요?`,
      });
    }
  }

  // 진입 앱을 못 정하면 사용자가 받는 도메인이 어느 사슬인지 그림이 말하지 못한다
  const drawn = ir.nodes.filter((n) => drawableNodeIds.has(n.id));
  const apps = indexMicroApps(
    drawn,
    edges.filter((e) => drawableEdgeIds.has(e.id)),
  );
  for (const [service, list] of [...apps.appsOf].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (apps.entryOf.has(service) || list.length < 2) continue;
    const hosts = list.filter((a) => apps.hosts.has(a)).map(nameById);
    ask({
      id: `auto:entry:${service}`,
      subject: { nodeId: service },
      question:
        hosts.length === 0
          ? `"${nameById(service)}"의 앱이 모두 다른 앱에 불려 와요. 사용자가 처음 받는 호스트 앱은 어느 것인가요?`
          : `"${nameById(service)}"에서 호스트로 보이는 앱이 여럿이에요 (${hosts.map((h) => `"${h}"`).join(', ')}). 리모트를 불러오는 remotes 설정은 어느 앱에 있나요?`,
    });
  }

  const flowResult = settleFlows(ir.flows ?? [], ask, askById);
  return {
    ok: true,
    value: {
      ir: { ...ir, edges, ...(ir.flows !== undefined ? { flows: flowResult.flows } : {}) },
      drawableNodeIds,
      drawableEdgeIds,
      drawableStepIds: flowResult.steps,
      drawableTransitionIds: flowResult.transitions,
      autoUnresolved,
    },
  };
}

function mapEvidence(ir: ArchitectureIr, fn: (ev: Evidence) => Evidence): ArchitectureIr {
  const mapNode = (n: ArchitectureNode): ArchitectureNode => ({
    ...n,
    evidence: n.evidence.map(fn),
    ...(n.platformEvidence !== undefined
      ? {
          platformEvidence: Object.fromEntries(
            Object.entries(n.platformEvidence).map(([p, list]) => [p, list.map(fn)]),
          ),
        }
      : {}),
  });
  const mapEdge = (e: ArchitectureEdge): ArchitectureEdge => ({
    ...e,
    evidence: e.evidence.map(fn),
  });
  const mapFlow = (f: ArchitectureFlow): ArchitectureFlow => ({
    ...f,
    steps: f.steps.map((st) => ({ ...st, evidence: st.evidence.map(fn) })),
    transitions: f.transitions.map((t) => ({ ...t, evidence: t.evidence.map(fn) })),
  });
  return {
    ...ir,
    nodes: ir.nodes.map(mapNode),
    edges: ir.edges.map(mapEdge),
    ...(ir.flows !== undefined ? { flows: ir.flows.map(mapFlow) } : {}),
  };
}

// 흐름 글자도 노드 이름처럼 아무 글이나 들어올 수 있어 질문과 같은 기준으로 가린다
function maskFlowText(f: ArchitectureFlow): ArchitectureFlow {
  const opt = (t: string | undefined): { description?: string } =>
    t !== undefined ? { description: maskSharedText(t) } : {};
  return {
    ...f,
    title: maskSharedText(f.title),
    ...opt(f.description),
    ...(f.stateLabels !== undefined
      ? {
          stateLabels: Object.fromEntries(
            Object.entries(f.stateLabels).map(([k, v]) => [k, maskSharedText(v)]),
          ),
        }
      : {}),
    actors: f.actors.map((a) => ({ ...a, label: maskSharedText(a.label) })),
    steps: f.steps.map((st) => ({
      ...st,
      label: maskSharedText(st.label),
      ...opt(st.description),
    })),
    transitions: f.transitions.map((t) => ({
      ...t,
      ...(t.label !== undefined ? { label: maskSharedText(t.label) } : {}),
    })),
  };
}

const MASKED_ACCOUNT_ID = '[계정 ID]';
const MASKED_DISTRIBUTION_ID = '[배포 ID]';

/** 공유본에 실을 글자에서 계정 ID 꼴 숫자를 가린다 */
export function maskAccountIds(text: string): string {
  return text.replace(ACCOUNT_ID_RE, MASKED_ACCOUNT_ID);
}

/** 질문처럼 어느 노드 이름이 섞였는지 모르는 글자. 계정 ID와 배포 ID 꼴을 둘 다 가린다 */
export function maskSharedText(text: string): string {
  return maskAccountIds(text).replace(DISTRIBUTION_ID_RE, MASKED_DISTRIBUTION_ID);
}

function maskNodeText(node: ArchitectureNode): ArchitectureNode {
  const mask = (t: string): string => {
    const masked = maskAccountIds(t);
    return node.kind === 'cdn'
      ? masked.replace(DISTRIBUTION_ID_RE, MASKED_DISTRIBUTION_ID)
      : masked;
  };
  return {
    ...node,
    label: mask(node.label),
    ...(node.displayName !== undefined ? { displayName: mask(node.displayName) } : {}),
    ...(node.description !== undefined ? { description: mask(node.description) } : {}),
  };
}

/**
 * 공유용 사본. 입력은 바꾸지 않는다.
 * private 근거는 type과 visibility만 남긴다. live 근거는 public이어도 명령과 리소스 식별자에 계정 ID나
 * 리소스 ID가 담기므로 조회 시각만 남긴다. 노드 이름과 질문 글자의 계정 ID 꼴 숫자도 가린다
 */
export function redactForSharing(ir: ArchitectureIr): ArchitectureIr {
  const redacted = mapEvidence(ir, (ev) => {
    if (ev.type === 'live') {
      return {
        type: ev.type,
        visibility: ev.visibility,
        ...(ev.observedAt !== undefined ? { observedAt: ev.observedAt } : {}),
      } as Evidence;
    }
    return ev.visibility === 'private'
      ? ({ type: ev.type, visibility: ev.visibility } as Evidence)
      : { ...ev };
  });
  return {
    ...redacted,
    nodes: redacted.nodes.map(maskNodeText),
    ...(redacted.flows !== undefined ? { flows: redacted.flows.map(maskFlowText) } : {}),
    unresolved: redacted.unresolved.map((q) => ({
      ...q,
      question: maskSharedText(q.question),
      ...(q.answer !== undefined ? { answer: maskSharedText(q.answer) } : {}),
    })),
  };
}

/** 저장용 사본. private 근거의 excerpt만 지운다. 입력은 바꾸지 않는다 */
export function stripPrivateExcerpts(ir: ArchitectureIr): ArchitectureIr {
  return mapEvidence(ir, (ev) => {
    if (ev.visibility !== 'private' || ev.excerpt === undefined) return { ...ev };
    const { excerpt: _excerpt, ...rest } = ev;
    return rest;
  });
}
