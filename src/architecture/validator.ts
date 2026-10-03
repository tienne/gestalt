import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { classifyCliCommand } from '../utils/read-only-tools.js';
import {
  PARENT_KINDS,
  type ArchitectureEdge,
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
  | 'CLOUD_ID_IN_ID';

export interface ArchitectureValidationError {
  code: ArchitectureValidationErrorCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
  evidenceIndex?: number;
}

export interface ValidatedIr {
  ir: ArchitectureIr;
  drawableNodeIds: Set<string>;
  drawableEdgeIds: Set<string>;
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
function deriveLineStyle(evidence: Evidence[]): LineStyle {
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
  owner: { nodeId: string } | { edgeId: string },
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
    const allowed = PARENT_KINDS[node.kind];
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

// 자동 질문은 페이지에 그대로 보이므로 사람이 부르는 이름으로 묻는다
function nameOf(node: ArchitectureNode): string {
  return node.displayName ?? node.label;
}

const PLATFORM_QUESTION: Record<Platform, string> = {
  web: '웹',
  android: 'Android 앱',
  ios: 'iOS 앱',
};

function isServedByBucket(
  serviceId: string,
  edges: ArchitectureEdge[],
  nodeById: Map<string, ArchitectureNode>,
  drawableEdgeIds: Set<string>,
): boolean {
  return edges.some(
    (e) =>
      e.kind === 'serves' &&
      e.to === serviceId &&
      drawableEdgeIds.has(e.id) &&
      nodeById.get(e.from)?.kind === 'bucket',
  );
}

function hasQuestionFor(
  unresolved: UnresolvedQuestion[],
  subject: UnresolvedQuestion['subject'],
): boolean {
  return unresolved.some(
    (q) => q.subject.nodeId === subject.nodeId && q.subject.edgeId === subject.edgeId,
  );
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
  checkParents(ir, errors);
  checkAccounts(ir, errors);
  checkIdsForCloudIds(ir, errors);

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
      if (platform === 'web' && isServedByBucket(node.id, edges, nodeById, drawableEdgeIds))
        continue;
      // 한 서비스에 플랫폼 질문이 여럿 설 수 있어 대상이 아니라 id로 겹침을 본다
      const id = `auto:platform:${node.id}:${platform}`;
      if (known.some((q) => q.id === id)) continue;
      const q: UnresolvedQuestion = {
        id,
        subject: { nodeId: node.id },
        question: `"${nameOf(node)}"를 ${PLATFORM_QUESTION[platform]}으로 배포한다는 근거를 못 찾았어요. 배포 워크플로나 스토어 설정이 어디 있나요?`,
      };
      known.push(q);
      autoUnresolved.push(q);
    }
  }

  return {
    ok: true,
    value: { ir: { ...ir, edges }, drawableNodeIds, drawableEdgeIds, autoUnresolved },
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
  return { ...ir, nodes: ir.nodes.map(mapNode), edges: ir.edges.map(mapEdge) };
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
