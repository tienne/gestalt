import { LEGACY_PACK_IDS, resolvePackIds } from './packs/index.js';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { normalizeRemoteUrl } from '../utils/claude-projects.js';
import { matchEndpoints, type BeRoute, type FeCall } from './endpoint-match.js';
import { parseArchitectureIr } from './ir-schema.js';
import { nodeKey } from './store.js';
import type {
  ArchitectureEdge,
  ArchitectureFlow,
  ArchitectureProjection,
  ArchitectureStage,
  ArchitectureGroup,
  ArchitectureIr,
  ArchitectureNode,
  ArchitectureRepo,
  ContextSource,
  Evidence,
  Platform,
  UnresolvedQuestion,
} from './types.js';
import {
  deriveLineStyle,
  stripPrivateExcerpts,
  validateArchitectureIr,
  type ArchitectureValidationError,
} from './validator.js';

export interface MergeArchitectureIrsOptions {
  /** 레포를 넘는 엔드포인트 매칭에서 FE 경로 앞에 붙는 게이트웨이 prefix 후보 */
  prefixCandidates?: string[];
  /** 입력마다 붙일 제품 이름. 넘긴 순서와 같다. 비우면 입력의 서비스 이름으로 짓는다 */
  groupNames?: string[];
}

export interface MergedSharedNode {
  id: string;
  kind: ArchitectureNode['kind'];
  label: string;
  repo: string;
  displayName?: string;
  /** 이 노드를 함께 가진 입력의 번호(호출할 때 넘긴 순서, 0부터) */
  inputs: number[];
}

export interface MergeReport {
  inputs: number;
  sharedNodes: MergedSharedNode[];
  /** 레포를 넘는 엔드포인트 매칭으로 새로 그은 엣지 id */
  crossRepoEdges: string[];
  /** 충돌이나 애매한 매칭으로 새로 생긴 미해결 질문 id */
  conflictQuestions: string[];
  /** 공유 노드나 레포를 넘는 연결로 이어지지 않은 입력 묶음 수. 1이면 한 덩어리다 */
  islands: number;
}

export type MergeArchitectureIrsResult =
  | { ok: true; ir: ArchitectureIr; report: MergeReport }
  | {
      ok: false;
      errors: { code: string; message: string; input?: number; nodeId?: string; edgeId?: string }[];
    };

const ENDPOINT_LABEL_RE = /^([A-Za-z*]+)\s+(\S.*)$/;

/** 분석마다 찾은 action이 다를 수 있어 합집합을 정렬해 둔다. 순서가 입력 순서를 따르면 같은 결과가 안 나온다 */
function unionActions(a: readonly string[] | undefined, b: readonly string[]): string[] {
  return [...new Set([...(a ?? []), ...b])].sort(byText);
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// 키 순서가 달라도 같은 IR이면 같은 문자열이 나와야 입력 정렬과 근거 중복 제거가 흔들리지 않는다
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => byText(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function repoKey(repo: ArchitectureRepo): string {
  const remote = repo.remote?.trim();
  if (remote) return `remote:${normalizeRemoteUrl(remote)}`;
  // remote가 없는 레포(클라우드 조회용 가짜 레포 등)는 이름으로만 알아본다
  return `local:${repo.name.trim().toLowerCase()}`;
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

function hasUserEvidence(node: ArchitectureNode): boolean {
  return node.evidence.some((e) => e.type === 'user');
}

function unionEvidence(into: Evidence[], more: Evidence[]): Evidence[] {
  const seen = new Set(into.map(canonicalJson));
  const out = [...into];
  for (const ev of more) {
    const key = canonicalJson(ev);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}

/** 한 노드에 여러 입력이 준 값. undefined는 "그 입력은 모른다"라 충돌로 치지 않는다 */
interface Claim {
  value: string;
  user: boolean;
}

interface Slot {
  node: ArchitectureNode;
  inputs: Set<number>;
  displayName: Claim[];
  displayNameInferred: Map<string, boolean>;
  /** 원래 입력 안의 parent id. 노드 id가 다 정해진 뒤에 합친 id로 바꾼다 */
  parent: { input: number; id: string; user: boolean }[];
  account: { input: number; id: string; user: boolean }[];
  environment: Claim[];
  /** micro_app을 자기 레포에서 분석한 입력이 적은 레포. 그 입력에는 이 앱으로 들어오는 loads가 없다 */
  ownRepo?: string;
}

type ConflictField = 'displayName' | 'parent' | 'environment' | 'account';

const CONFLICT_QUESTION: Record<ConflictField, (name: string, values: string[]) => string> = {
  displayName: (name, values) =>
    `"${name}"의 표시 이름이 분석마다 달라요 (${values.map((v) => `"${v}"`).join(', ')}). 어느 이름으로 부르면 될까요?`,
  parent: (name, values) =>
    `"${name}"가 분석마다 다른 곳에 속해 있어요 (${values.map((v) => `"${v}"`).join(', ')}). 어디에 두면 될까요?`,
  environment: (name, values) =>
    `"${name}"의 환경이 분석마다 달라요 (${values.join(', ')}). 어느 환경이 맞나요?`,
  account: (name, values) =>
    `"${name}"가 속한 계정이 분석마다 달라요 (${values.map((v) => `"${v}"`).join(', ')}). 어느 계정이 맞나요?`,
};

/**
 * 값이 하나로 모이면 그 값을, 갈리면 user 근거가 있는 쪽 값을 고른다.
 * user 근거 쪽도 갈리거나 없으면 아무 값도 고르지 않고 후보 목록을 돌려준다.
 */
function settle(claims: Claim[]): { value?: string; conflict?: string[] } {
  const distinct = [...new Set(claims.map((c) => c.value))];
  if (distinct.length <= 1) return { value: distinct[0] };
  const userValues = [...new Set(claims.filter((c) => c.user).map((c) => c.value))];
  if (userValues.length === 1) return { value: userValues[0] };
  return { conflict: distinct.sort(byText) };
}

function inputErrors(
  input: number,
  errors: ArchitectureValidationError[],
): Extract<MergeArchitectureIrsResult, { ok: false }>['errors'] {
  return errors.map((e) => ({
    code: e.code,
    message: `입력 ${input}: ${e.message}`,
    input,
    ...(e.nodeId !== undefined ? { nodeId: e.nodeId } : {}),
    ...(e.edgeId !== undefined ? { edgeId: e.edgeId } : {}),
  }));
}

/**
 * 따로 돌린 분석 IR 여럿을 하나로 합친다.
 *
 * 레포는 별칭(id)이 아니라 git remote로 알아본다. 노드는 nodeKey(kind, 레포, 정규화한 label)로
 * 알아본다. 같은 노드면 하나로 합치고 근거는 합집합으로 남긴다. 표시 이름이나 parent가 갈리면
 * 한쪽을 고르지 않고 값을 비운 채 미해결 질문으로 돌린다. user 근거가 있는 쪽 값은 그대로 둔다.
 * 한 IR에서 핸들러를 못 찾은 엔드포인트는 다른 IR의 핸들러 달린 엔드포인트와 method, 경로로
 * 맞춰 `handles`로 잇는다.
 *
 * 입력은 내용 해시 순으로 정렬한 뒤 합치므로 넘긴 순서와 상관없이 같은 결과가 나온다.
 * 입력은 바꾸지 않는다. 검증과 렌더는 결과를 validate, render에 그대로 넘긴다.
 */
export function mergeArchitectureIrs(
  irs: ArchitectureIr[],
  opts: MergeArchitectureIrsOptions = {},
): MergeArchitectureIrsResult {
  if (irs.length < 2) {
    return {
      ok: false,
      errors: [{ code: 'MERGE_TOO_FEW', message: '합칠 IR이 둘 이상 있어야 한다.' }],
    };
  }
  const views = [...new Set(irs.map((ir) => ir.view))];
  if (views.length > 1) {
    return {
      ok: false,
      errors: [
        {
          code: 'MERGE_VIEW_MISMATCH',
          message: `뷰가 다른 IR은 합치지 않는다 (${views.sort(byText).join(', ')}).`,
        },
      ],
    };
  }
  const structural = irs.flatMap((ir, i) => {
    const result = validateArchitectureIr(ir, { checkFiles: false });
    return result.ok ? [] : inputErrors(i, result.errors);
  });
  if (structural.length > 0) return { ok: false, errors: structural };

  // 보고에는 호출한 사람이 넘긴 순서의 번호를 쓴다. 합치는 순서만 해시로 정한다
  const ordered = irs
    .map((ir, input) => ({ ir: stripPrivateExcerpts(ir), input, hash: '' }))
    .map((entry) => ({
      ...entry,
      hash: createHash('sha256').update(canonicalJson(entry.ir)).digest('hex'),
    }))
    .sort((a, b) => byText(a.hash, b.hash) || a.input - b.input);

  // ── 레포 ──
  const repoIdByKey = new Map<string, string>();
  const takenRepoIds = new Set<string>();
  const repos: ArchitectureRepo[] = [];
  const repoMaps = new Map<number, Map<string, string>>();
  for (const { ir, input } of ordered) {
    const map = new Map<string, string>();
    for (const repo of ir.repos) {
      const key = repoKey(repo);
      let id = repoIdByKey.get(key);
      if (id === undefined) {
        id = uniqueId(repo.id, takenRepoIds);
        repoIdByKey.set(key, id);
        repos.push({ ...repo, id });
      } else {
        const existing = repos.find((r) => r.id === id)!;
        // 상대 경로 root는 그 IR을 그린 위치 기준이라 여기서는 못 푼다. 절대 경로가 있으면 그쪽을 쓴다
        if (
          repo.root !== undefined &&
          (existing.root === undefined || (!isAbsolute(existing.root) && isAbsolute(repo.root)))
        )
          existing.root = repo.root;
        if (existing.remote === undefined && repo.remote !== undefined)
          existing.remote = repo.remote;
      }
      map.set(repo.id, id);
    }
    // repos에 없는 레포 이름을 쓴 노드도 받아준다. 다른 IR의 레포 id와 겹치면 이름을 바꾼다
    for (const node of ir.nodes) {
      if (map.has(node.repo)) continue;
      const key = `local:${node.repo.trim().toLowerCase()}`;
      let id = repoIdByKey.get(key);
      if (id === undefined) {
        id = node.repo === '' ? '' : uniqueId(node.repo, takenRepoIds);
        repoIdByKey.set(key, id);
      }
      map.set(node.repo, id);
    }
    repoMaps.set(input, map);
  }

  const remapLocation = (ev: Evidence, map: Map<string, string>): Evidence => {
    if (ev.type === 'live' || ev.type === 'user') return { ...ev };
    const colon = ev.location.indexOf(':');
    if (colon <= 0) return { ...ev };
    const mapped = map.get(ev.location.slice(0, colon));
    if (mapped === undefined) return { ...ev };
    return { ...ev, location: `${mapped}${ev.location.slice(colon)}` };
  };
  const remapEvidence = (list: Evidence[], map: Map<string, string>): Evidence[] =>
    list.map((ev) => remapLocation(ev, map));

  // ── 노드 ──
  const slotsByKey = new Map<string, Slot[]>();
  const slots: Slot[] = [];
  const slotOf = new Map<string, Slot>(); // `${input}\u0000${원래 id}` → slot
  for (const { ir, input } of ordered) {
    const map = repoMaps.get(input)!;
    const loaded = new Set(ir.edges.filter((e) => e.kind === 'loads').map((e) => e.to));
    for (const raw of ir.nodes) {
      const repo = map.get(raw.repo)!;
      const evidence = remapEvidence(raw.evidence, map);
      const platformEvidence = raw.platformEvidence
        ? Object.fromEntries(
            Object.entries(raw.platformEvidence).map(([p, list]) => [
              p,
              remapEvidence(list ?? [], map),
            ]),
          )
        : undefined;
      const key = nodeKey({ kind: raw.kind, repo, label: raw.label });
      const user = hasUserEvidence(raw);
      // 한 입력 안에서 키가 겹친 두 노드는 그 분석이 일부러 나눈 것이라 서로 합치지 않는다
      const candidates = slotsByKey.get(key) ?? [];
      let slot = candidates.find((s) => !s.inputs.has(input));
      if (!slot) {
        const {
          displayName: _d,
          displayNameInferred: _di,
          parent: _p,
          account: _a,
          environment: _e,
          ...rest
        } = raw;
        slot = {
          node: {
            ...rest,
            repo,
            evidence: [],
            ...(platformEvidence ? { platformEvidence: {} } : {}),
          },
          inputs: new Set(),
          displayName: [],
          displayNameInferred: new Map(),
          parent: [],
          account: [],
          environment: [],
        };
        candidates.push(slot);
        slotsByKey.set(key, candidates);
        slots.push(slot);
      }
      slot.inputs.add(input);
      slot.node.evidence = unionEvidence(slot.node.evidence, evidence);
      // 호스트 분석이 리모트를 먼저 들여왔어도 리모트 레포 분석이 있으면 그쪽 레포를 쓴다
      if (raw.kind === 'micro_app' && !loaded.has(raw.id) && slot.ownRepo === undefined) {
        slot.ownRepo = repo;
        slot.node.repo = repo;
      }
      if (slot.node.description === undefined && raw.description !== undefined) {
        slot.node.description = raw.description;
      }
      if (raw.actions !== undefined)
        slot.node.actions = unionActions(slot.node.actions, raw.actions);
      if (raw.platforms !== undefined) {
        const merged = new Set([...(slot.node.platforms ?? []), ...raw.platforms]);
        slot.node.platforms = [...merged].sort(byText) as Platform[];
      }
      if (platformEvidence) {
        const target = (slot.node.platformEvidence ??= {});
        for (const [p, list] of Object.entries(platformEvidence) as [Platform, Evidence[]][]) {
          target[p] = unionEvidence(target[p] ?? [], list);
        }
      }
      if (raw.displayName !== undefined) {
        slot.displayName.push({ value: raw.displayName, user });
        // 같은 이름을 한쪽은 추정, 한쪽은 문서 그대로라고 했으면 문서 그대로 쪽을 믿는다
        const prevInferred = slot.displayNameInferred.get(raw.displayName);
        const inferred = raw.displayNameInferred === true;
        slot.displayNameInferred.set(
          raw.displayName,
          prevInferred === undefined ? inferred : prevInferred && inferred,
        );
      }
      if (raw.parent !== undefined) slot.parent.push({ input, id: raw.parent, user });
      if (raw.account !== undefined) slot.account.push({ input, id: raw.account, user });
      if (raw.environment !== undefined) slot.environment.push({ value: raw.environment, user });
      slotOf.set(`${input}\u0000${raw.id}`, slot);
    }
  }

  const takenNodeIds = new Set<string>();
  const idOfSlot = new Map<Slot, string>();
  for (const slot of slots) idOfSlot.set(slot, uniqueId(slot.node.id, takenNodeIds));
  const mapNode = (input: number, id: string): string => {
    const slot = slotOf.get(`${input}\u0000${id}`);
    return slot ? idOfSlot.get(slot)! : id;
  };

  // 질문에는 id 대신 사람이 읽을 이름을 보여준다. 표시 이름이 갈린 노드는 label로 부른다
  const nameById = new Map(
    slots.map((s) => [idOfSlot.get(s)!, settle(s.displayName).value ?? s.node.label]),
  );
  const conflictQuestions: UnresolvedQuestion[] = [];
  const nameOf = (slot: Slot): string => slot.node.label;
  const nodes: ArchitectureNode[] = slots.map((slot) => {
    const id = idOfSlot.get(slot)!;
    const node: ArchitectureNode = { ...slot.node, id };
    const ask = (field: ConflictField, values: string[]): void => {
      conflictQuestions.push({
        id: `merge:${field}:${id}`,
        subject: { nodeId: id },
        question: CONFLICT_QUESTION[field](nameOf(slot), values),
      });
    };

    const dn = settle(slot.displayName);
    if (dn.value !== undefined) {
      node.displayName = dn.value;
      if (slot.displayNameInferred.get(dn.value)) node.displayNameInferred = true;
    } else if (dn.conflict) ask('displayName', dn.conflict);

    const env = settle(slot.environment);
    if (env.value !== undefined) node.environment = env.value;
    else if (env.conflict) ask('environment', env.conflict);

    for (const field of ['parent', 'account'] as const) {
      const claims = slot[field].map((c) => ({ value: mapNode(c.input, c.id), user: c.user }));
      const settled = settle(claims);
      if (settled.value !== undefined) node[field] = settled.value;
      // 호스트 여럿이 같이 쓰는 리모트는 서비스가 갈리는 게 맞다. 묻지 않고 어느 서비스에도 안 넣어 따로 세운다
      else if (settled.conflict && field === 'parent' && node.kind === 'micro_app') continue;
      else if (settled.conflict)
        ask(
          field,
          settled.conflict.map((v) => nameById.get(v) ?? v),
        );
    }
    return node;
  });

  // ── 엣지 ──
  interface EdgeSlot {
    edge: ArchitectureEdge;
    inputs: Set<number>;
  }
  const edgeSlots = new Map<string, EdgeSlot>();
  const edgeSlotOf = new Map<string, EdgeSlot>();
  for (const { ir, input } of ordered) {
    const map = repoMaps.get(input)!;
    for (const raw of ir.edges) {
      const from = mapNode(input, raw.from);
      const to = mapNode(input, raw.to);
      const key = `${from}\u0000${to}\u0000${raw.kind}`;
      let slot = edgeSlots.get(key);
      const evidence = remapEvidence(raw.evidence, map);
      if (!slot) {
        slot = { edge: { ...raw, from, to, evidence: [] }, inputs: new Set() };
        edgeSlots.set(key, slot);
      }
      slot.inputs.add(input);
      slot.edge.evidence = unionEvidence(slot.edge.evidence, evidence);
      if (raw.lineStyle === 'solid') slot.edge.lineStyle = 'solid';
      if (raw.actions !== undefined)
        slot.edge.actions = unionActions(slot.edge.actions, raw.actions);
      edgeSlotOf.set(`${input}\u0000${raw.id}`, slot);
    }
  }
  const takenEdgeIds = new Set<string>();
  const edgeIdOf = new Map<EdgeSlot, string>();
  for (const slot of edgeSlots.values()) edgeIdOf.set(slot, uniqueId(slot.edge.id, takenEdgeIds));
  const edges: ArchitectureEdge[] = [...edgeSlots.values()].map((slot) => ({
    ...slot.edge,
    id: edgeIdOf.get(slot)!,
  }));
  const mapEdge = (input: number, id: string): string => {
    const slot = edgeSlotOf.get(`${input}\u0000${id}`);
    return slot ? edgeIdOf.get(slot)! : id;
  };

  // ── 레포를 넘는 엔드포인트 연결 ──
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const inputsOf = new Map(slots.map((s) => [idOfSlot.get(s)!, s.inputs]));
  const handlesFrom = new Map<string, ArchitectureEdge[]>();
  for (const e of edges) {
    if (e.kind !== 'handles' || nodeById.get(e.to)?.kind !== 'app_module') continue;
    const list = handlesFrom.get(e.from) ?? [];
    list.push(e);
    handlesFrom.set(e.from, list);
  }
  const parseEndpoint = (node: ArchitectureNode): { method: string; path: string } | null => {
    const m = ENDPOINT_LABEL_RE.exec(node.label.trim());
    return m ? { method: m[1]!.toUpperCase(), path: m[2]! } : null;
  };
  const endpoints = nodes.filter((n) => n.kind === 'endpoint');
  const routes = endpoints.filter((n) => handlesFrom.has(n.id));
  const orphanGroups = new Map<string, ArchitectureNode[]>();
  for (const n of endpoints) {
    if (handlesFrom.has(n.id)) continue;
    const sig = [...inputsOf.get(n.id)!].sort((a, b) => a - b).join(',');
    const group = orphanGroups.get(sig) ?? [];
    group.push(n);
    orphanGroups.set(sig, group);
  }

  const crossEdges: ArchitectureEdge[] = [];
  const disjoint = (a: Set<number>, b: Set<number>): boolean => [...a].every((x) => !b.has(x));
  for (const [sig, group] of [...orphanGroups.entries()].sort(([a], [b]) => byText(a, b))) {
    const own = new Set(sig.split(',').map(Number));
    const feCalls: FeCall[] = group.flatMap((n) => {
      const parsed = parseEndpoint(n);
      return parsed ? [{ id: n.id, ...parsed }] : [];
    });
    // 같은 분석 안에서 이미 못 맞춘 쌍을 다시 맞추지 않는다. 다른 분석이 찾은 핸들러만 후보다
    const beRoutes: BeRoute[] = routes.flatMap((n) => {
      if (!disjoint(own, inputsOf.get(n.id)!)) return [];
      const parsed = parseEndpoint(n);
      return parsed ? [{ id: n.id, repo: n.repo, ...parsed }] : [];
    });
    if (feCalls.length === 0 || beRoutes.length === 0) continue;
    const result = matchEndpoints({ feCalls, beRoutes, prefixCandidates: opts.prefixCandidates });
    for (const match of result.matches) {
      for (const handle of handlesFrom.get(match.beRouteId)!) {
        const fe = nodeById.get(match.feCallId)!;
        // FE 쪽 경로 줄과 BE 쪽 라우트 줄이 둘 다 있어야 "같은 API"라는 주장이 선다
        const evidence = unionEvidence(
          fe.evidence.filter((e) => e.type === 'code' || e.type === 'spec'),
          handle.evidence,
        );
        crossEdges.push({
          id: uniqueId(`merge:handles:${fe.id}:${handle.to}`, takenEdgeIds),
          from: fe.id,
          to: handle.to,
          kind: 'handles',
          evidence,
          lineStyle: deriveLineStyle(evidence),
        });
      }
    }
    for (const miss of result.unmatched) {
      if (miss.reason === 'no_route') continue;
      const fe = nodeById.get(miss.feCallId)!;
      const names = miss.candidates.map((id) => {
        const n = nodeById.get(id)!;
        return `"${n.label}" (${n.repo})`;
      });
      conflictQuestions.push({
        id: `merge:endpoint:${fe.id}`,
        subject: { nodeId: fe.id },
        question: `"${fe.label}"를 받는 핸들러가 다른 분석에 여럿 있어요 (${names.join(', ')}). 어느 쪽이 받나요?`,
      });
    }
  }
  edges.push(...crossEdges);

  // ── 도메인 흐름 ──
  // 흐름은 한 분석이 자기 서비스를 보고 쓴 것이라 서로 합치지 않고 나란히 싣는다. id만 겹치지 않게 바꾼다
  const flows: ArchitectureFlow[] = [];
  const takenFlowIds = new Set<string>();
  const takenStepIds = new Set<string>();
  const stepIdOf = new Map<string, string>(); // `${input}\u0000${원래 id}` → 새 id. 단계와 전이가 함께 쓴다
  const mapStep = (input: number, id: string): string => stepIdOf.get(`${input}\u0000${id}`) ?? id;
  for (const { ir, input } of ordered) {
    const map = repoMaps.get(input)!;
    for (const f of ir.flows ?? []) {
      for (const item of [...f.steps, ...f.transitions]) {
        stepIdOf.set(`${input}\u0000${item.id}`, uniqueId(item.id, takenStepIds));
      }
      flows.push({
        ...f,
        id: uniqueId(f.id, takenFlowIds),
        ...(f.service !== undefined ? { service: mapNode(input, f.service) } : {}),
        steps: f.steps.map((st) => ({
          ...st,
          id: mapStep(input, st.id),
          ...(st.refs !== undefined ? { refs: st.refs.map((r) => mapNode(input, r)) } : {}),
          evidence: remapEvidence(st.evidence, map),
        })),
        transitions: f.transitions.map((t) => ({
          ...t,
          id: mapStep(input, t.id),
          from: mapStep(input, t.from),
          to: mapStep(input, t.to),
          evidence: remapEvidence(t.evidence, map),
        })),
      });
    }
  }

  // ── 질문별 투영 ──
  // 투영도 한 분석이 자기 지도를 보고 쓴 것이라 나란히 싣는다. 노드와 엣지는 합친 id로 바꾸고 투영과 메시지 id만 겹치지 않게 한다
  const projections: ArchitectureProjection[] = [];
  const takenProjectionIds = new Set<string>();
  const takenMessageIds = new Set<string>();
  const messageIdOf = new Map<string, string>();
  const mapMessage = (input: number, id: string): string =>
    messageIdOf.get(`${input}\u0000${id}`) ?? id;
  for (const { ir, input } of ordered) {
    const map = repoMaps.get(input)!;
    for (const pr of ir.projections ?? []) {
      for (const m of pr.messages) {
        messageIdOf.set(`${input}\u0000${m.id}`, uniqueId(m.id, takenMessageIds));
      }
      projections.push({
        ...pr,
        id: uniqueId(pr.id, takenProjectionIds),
        ...(pr.participants !== undefined
          ? { participants: pr.participants.map((id) => mapNode(input, id)) }
          : {}),
        messages: pr.messages.map((m) => ({
          ...m,
          id: mapMessage(input, m.id),
          from: mapNode(input, m.from),
          to: mapNode(input, m.to),
          ...(m.edge !== undefined ? { edge: mapEdge(input, m.edge) } : {}),
          evidence: remapEvidence(m.evidence, map),
        })),
      });
    }
  }

  // ── 기술 그림 구간 ──
  // 같은 id면 한 구간으로 합친다. 두 분석이 같은 이름으로 나눴으면 같은 칸이라고 보는 게 그림을 덜 쪼갠다
  const stages: ArchitectureStage[] = [];
  for (const { ir, input } of ordered) {
    const map = repoMaps.get(input)!;
    for (const st of ir.stages ?? []) {
      const nodesOf = st.nodes?.map((id) => mapNode(input, id));
      const reposOf = st.repos?.map((r) => map.get(r) ?? r);
      const existing = stages.find((x) => x.id === st.id);
      if (existing === undefined) {
        stages.push({
          ...st,
          ...(nodesOf !== undefined ? { nodes: nodesOf } : {}),
          ...(reposOf !== undefined ? { repos: reposOf } : {}),
        });
        continue;
      }
      if (nodesOf !== undefined)
        existing.nodes = [...new Set([...(existing.nodes ?? []), ...nodesOf])];
      if (st.kinds !== undefined)
        existing.kinds = [...new Set([...(existing.kinds ?? []), ...st.kinds])];
      // 한쪽이 레포를 안 가렸으면 그 구간은 모든 레포를 받는다. 합친 뒤에도 그쪽 노드가 빠지지 않게 가림을 푼다
      if (existing.repos === undefined || reposOf === undefined) delete existing.repos;
      else existing.repos = [...new Set([...existing.repos, ...reposOf])];
    }
  }

  // ── 미해결 질문 ──
  const unresolved: UnresolvedQuestion[] = [];
  const takenQuestionIds = new Set<string>();
  const seenQuestion = new Map<string, UnresolvedQuestion>();
  for (const { ir, input } of ordered) {
    for (const q of ir.unresolved) {
      const subject: UnresolvedQuestion['subject'] = {
        ...(q.subject.nodeId !== undefined ? { nodeId: mapNode(input, q.subject.nodeId) } : {}),
        ...(q.subject.edgeId !== undefined ? { edgeId: mapEdge(input, q.subject.edgeId) } : {}),
        ...(q.subject.stepId !== undefined ? { stepId: mapStep(input, q.subject.stepId) } : {}),
        ...(q.subject.transitionId !== undefined
          ? { transitionId: mapStep(input, q.subject.transitionId) }
          : {}),
        ...(q.subject.messageId !== undefined
          ? { messageId: mapMessage(input, q.subject.messageId) }
          : {}),
      };
      const key = [
        subject.nodeId,
        subject.edgeId,
        subject.stepId,
        subject.transitionId,
        subject.messageId,
        q.question.trim(),
      ].join('\u0000');
      const twin = seenQuestion.get(key);
      if (twin) {
        if ((twin.answer ?? '').trim() === '' && q.answer !== undefined) twin.answer = q.answer;
        continue;
      }
      const merged: UnresolvedQuestion = { ...q, id: uniqueId(q.id, takenQuestionIds), subject };
      seenQuestion.set(key, merged);
      unresolved.push(merged);
    }
  }
  const conflictIds: string[] = [];
  for (const q of conflictQuestions) {
    const id = uniqueId(q.id, takenQuestionIds);
    conflictIds.push(id);
    unresolved.push({ ...q, id });
  }

  // ── 맥락 소스 ──
  const sources = new Map<string, ContextSource>();
  for (const { ir } of ordered) {
    for (const s of ir.sourcesUsed) {
      const key = `${s.via}\u0000${s.identifier}`;
      const prev = sources.get(key);
      if (!prev) {
        sources.set(key, { ...s });
        continue;
      }
      // 한쪽이라도 private이면 private로 남긴다. 공개로 풀면 공유본에 이름이 샌다
      if (s.visibility === 'private') prev.visibility = 'private';
      prev.readOnly = prev.readOnly && s.readOnly;
      prev.probeHit = prev.probeHit || s.probeHit;
    }
  }

  // ── 제품 그룹 ──
  // 이미 합친 IR을 다시 합치면 그 안의 그룹을 그대로 물려받는다. 아니면 입력 하나가 제품 하나다
  const groups: ArchitectureGroup[] = [];
  const takenGroupIds = new Set<string>();
  for (const { ir, input } of ordered) {
    const own = ir.groups ?? [
      {
        id: `group-${groups.length + 1}`,
        name: opts.groupNames?.[input] ?? defaultGroupName(ir),
        members: ir.nodes.map((n) => n.id),
      },
    ];
    for (const g of own) {
      const members = [...new Set(g.members.map((m) => mapNode(input, m)))].sort(byText);
      if (members.length === 0) continue;
      groups.push({ id: uniqueId(g.id, takenGroupIds), name: g.name, members });
    }
  }

  const generatedAt = ordered
    .map((o) => o.ir.generatedAt)
    .sort(byText)
    .at(-1)!;
  // 한쪽이라도 packs를 적었으면 양쪽 어휘를 다 담는다. 안 적은 쪽은 LEGACY_PACK_IDS로 읽는다
  const packs = ordered.some((o) => o.ir.packs !== undefined)
    ? resolvePackIds(ordered.flatMap((o) => o.ir.packs ?? LEGACY_PACK_IDS))
    : undefined;
  const draft: ArchitectureIr = stripPrivateExcerpts({
    schemaVersion: ordered[0]!.ir.schemaVersion,
    view: ordered[0]!.ir.view,
    ...(packs !== undefined ? { packs } : {}),
    repos,
    nodes,
    edges,
    unresolved,
    sourcesUsed: [...sources.values()],
    generatedAt,
    ...(groups.length > 0 ? { groups } : {}),
    ...(flows.length > 0 ? { flows } : {}),
    ...(stages.length > 0 ? { stages } : {}),
    ...(projections.length > 0 ? { projections } : {}),
  });
  // 스키마를 한 번 더 통과시키면 객체 키가 스키마 순서로 다시 놓인다. 입력의 키 순서가 바이트에 새지 않는다
  const reparsed = parseArchitectureIr(draft);
  if (!reparsed.ok) {
    return { ok: false, errors: [{ code: 'MERGE_INTERNAL', message: reparsed.error.message }] };
  }
  const ir = reparsed.value;

  const sharedNodes: MergedSharedNode[] = slots
    .filter((s) => s.inputs.size > 1)
    .map((s) => {
      const n = nodeById.get(idOfSlot.get(s)!)!;
      return {
        id: n.id,
        kind: n.kind,
        label: n.label,
        repo: n.repo,
        ...(n.displayName !== undefined ? { displayName: n.displayName } : {}),
        inputs: [...s.inputs].sort((a, b) => a - b),
      };
    })
    .sort((a, b) => byText(a.kind, b.kind) || byText(a.id, b.id));

  return {
    ok: true,
    ir,
    report: {
      inputs: irs.length,
      sharedNodes,
      crossRepoEdges: crossEdges.map((e) => e.id).sort(byText),
      conflictQuestions: conflictIds.sort(byText),
      islands: countIslands(irs.length, slots, crossEdges, inputsOf),
    },
  };
}

function defaultGroupName(ir: ArchitectureIr): string {
  const services = ir.nodes
    .filter((n) => n.kind === 'service')
    .sort((a, b) => byText(a.id, b.id))
    .map((n) => n.displayName ?? n.label);
  if (services.length === 0) return ir.repos[0]?.name ?? '분석';
  return services.length === 1 ? services[0]! : `${services[0]!} 외 ${services.length - 1}`;
}

function countIslands(
  inputs: number,
  slots: Slot[],
  crossEdges: ArchitectureEdge[],
  inputsOf: Map<string, Set<number>>,
): number {
  const parent = Array.from({ length: inputs }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  const join = (group: Iterable<number>): void => {
    const [first, ...rest] = [...group];
    if (first === undefined) return;
    for (const x of rest) parent[find(x)] = find(first);
  };
  for (const slot of slots) join(slot.inputs);
  for (const e of crossEdges) join([...inputsOf.get(e.from)!, ...inputsOf.get(e.to)!]);
  return new Set(parent.map((_, i) => find(i))).size;
}
