import type { ScannedDoc } from './doc-scan.js';
import { docNodeId } from './doc-scan.js';
import { normalizePathTemplate } from './endpoint-match.js';
import { docPathKey } from './name-ref-match.js';
import { LEGACY_PACK_IDS } from './packs/index.js';
import { KNOWLEDGE_COVERAGE_KINDS } from './packs/knowledge.js';
import type {
  ArchitectureEdge,
  ArchitectureIr,
  ArchitectureNode,
  DocInfo,
  DocLink,
  DocLinkRef,
  UnresolvedQuestion,
} from './types.js';

/** 가리킨 파일이 클론에 있는지와 마지막 커밋 날짜. 클론이 없는 레포면 undefined */
export type FileFacts = (
  repoName: string,
  path: string,
) => { exists: boolean; committedAt?: string } | undefined;

export interface LinkDocsOptions {
  /** 문서가 적은 레포 이름 → 기술 IR의 repo id. 비면 repos[].name이나 id가 같은 레포를 쓴다 */
  repoAliases?: Record<string, string>;
  /** 화면 색인으로 쓸 design_screen의 `<repoId>/<경로 접두>`. 비면 화면은 잇지 않는다 */
  screenIndexPrefixes?: string[];
  fileFacts?: FileFacts;
  generatedAt: string;
}

export interface KnowledgeLinkSignals {
  coverage: Record<string, { total: number; covered: number }>;
  /** 문서가 하나도 안 붙은 기술 노드 */
  uncovered: string[];
  /** 문서 날짜보다 가리킨 파일 커밋이 늦은 문서 */
  stale: { doc: string; updatedAt: string; newestRef: string }[];
  /** 문서가 말한 API 중 기술 그림 엔드포인트에 없는 것 */
  apiMismatches: { doc: string; api: string; line: number }[];
  screensOnlyInCode: string[];
  screensOnlyInIndex: string[];
  links: { total: number; broken: number; branchOnly: number; pinned: number; unchecked: number };
  linkedDocs: number;
  describes: number;
  /** 담당별 열린 구멍 수. 담당을 안 적은 구멍은 '(담당 없음)'으로 센다 */
  gapsByOwner: Record<string, number>;
}

export interface LinkDocsResult {
  ir: ArchitectureIr;
  signals: KnowledgeLinkSignals;
  /** 링크 상태를 다시 센 문서 정보. 문서 지도 초안에 되돌려 쓴다 */
  docInfo: Map<string, DocInfo>;
}

const MODULE_KINDS = new Set(['service', 'micro_app', 'app_module']);
const NO_OWNER = '(담당 없음)';

/** `repo:path:line` 근거를 레포와 경로로 나눈다 */
function splitCodeLocation(location: string): { repo: string; path: string } | undefined {
  const i = location.indexOf(':');
  if (i <= 0) return undefined;
  return { repo: location.slice(0, i), path: docPathKey(location.slice(i + 1)) };
}

// 패키지 루트는 src 바로 앞까지다. 모노레포 앱과 백엔드 모듈이 대부분 이 꼴이라 문서가 그 아래 파일을 가리키면 그 모듈 이야기로 본다
function packageRoot(path: string): string | undefined {
  const i = path.indexOf('/src/');
  return i > 0 ? path.slice(0, i) : undefined;
}

// 폴더 하나가 모듈 수십 개를 덮으면 그 문서는 레포 전체 이야기라 모듈마다 잇지 않는다
const MAX_DIR_TARGETS = 8;

/**
 * 파일이 같은 노드가 없을 때 모듈로 잇는다. 가리킨 경로를 품은 가장 깊은 패키지 루트를 먼저 본다.
 * 그게 없으면 가리킨 경로가 폴더라 그 아래 패키지 루트들을 본다
 */
function moduleTargets(
  modules: readonly { repo: string; root: string; node: string }[],
  repo: string,
  path: string,
): string[] {
  const inRepo = modules.filter((m) => m.repo === repo);
  const owners = inRepo
    .filter((m) => path === m.root || path.startsWith(`${m.root}/`))
    .sort((a, b) => b.root.length - a.root.length);
  if (owners.length > 0) return owners.filter((m) => m.root === owners[0]!.root).map((m) => m.node);
  const under = [
    ...new Set(inRepo.filter((m) => m.root.startsWith(`${path}/`)).map((m) => m.node)),
  ];
  return under.length <= MAX_DIR_TARGETS ? under : [];
}

/** 화면 label `[app] /route · Name`에서 라우트만 뽑는다 */
export function screenRouteOf(node: Pick<ArchitectureNode, 'label'>): string | undefined {
  return /(?:^|\s)(\/\S*)/.exec(node.label)?.[1];
}

const routeKey = (route: string): string => normalizePathTemplate(route).toLowerCase();

// `/list/:tab?`처럼 끝 파라미터를 생략할 수 있는 라우트는 생략한 꼴로도 찾을 수 있어야 한다
function routeKeys(route: string): string[] {
  const keys = [routeKey(route)];
  let r = route.trim();
  while (/\/:[A-Za-z_]\w*\?$/.test(r)) {
    r = r.replace(/\/:[A-Za-z_]\w*\?$/, '');
    keys.push(routeKey(r || '/'));
  }
  return keys;
}

// 색인은 `/info/NAVER`처럼 값을 박아 적기도 한다. 같은 자리가 코드에서 파라미터면 같은 화면으로 본다
function routeFits(indexKey: string, techKey: string): boolean {
  const a = indexKey.split('/');
  const b = techKey.split('/');
  return (
    a.length === b.length &&
    b.some((s) => s === '{}') &&
    b.every((s, i) => s === '{}' || s === a[i])
  );
}
const apiKey = (method: string, path: string): string =>
  `${method.toUpperCase()} ${normalizePathTemplate(path)}`;

/**
 * 기술 그림에 문서를 엮는다. 문서가 가리킨 코드 파일, 문서가 말한 API, 화면 색인의 라우트로 잇고
 * 이어진 문서만 기술 IR에 얹어 knowledge-link IR을 만든다. 잇지 못한 쪽은 신호로 돌려준다
 */
export function linkDocs(
  tech: ArchitectureIr,
  knowledge: ArchitectureIr,
  scanned: readonly ScannedDoc[],
  options: LinkDocsOptions,
): LinkDocsResult {
  const aliases = options.repoAliases ?? {};
  const repoIdOf = (name: string): string | undefined =>
    aliases[name] ?? tech.repos.find((r) => r.name === name || r.id === name)?.id;

  const fileIndex = new Map<string, string[]>();
  const modules: { repo: string; root: string; node: string }[] = [];
  const endpoints = new Map<string, string>();
  for (const n of tech.nodes) {
    if (n.kind === 'endpoint') {
      const sp = n.label.indexOf(' ');
      if (sp > 0) endpoints.set(apiKey(n.label.slice(0, sp), n.label.slice(sp + 1)), n.id);
    }
    for (const e of n.evidence) {
      if (e.type !== 'code') continue;
      const loc = splitCodeLocation(e.location);
      if (loc === undefined) continue;
      const key = `${loc.repo}:${loc.path}`;
      fileIndex.set(key, [...(fileIndex.get(key) ?? []), n.id]);
      const root = MODULE_KINDS.has(n.kind) ? packageRoot(loc.path) : undefined;
      if (root !== undefined) modules.push({ repo: loc.repo, root, node: n.id });
    }
  }

  const techIds = new Set(tech.nodes.map((n) => n.id));
  const knowledgeById = new Map(knowledge.nodes.map((n) => [n.id, n]));
  const links = new Map<string, { via: DocLink['via']; refs: DocLinkRef[]; line: number }>();
  const addLink = (doc: string, to: string, via: DocLink['via'], ref: DocLinkRef, line: number) => {
    const key = `${doc}\u0000${to}`;
    const cur = links.get(key);
    if (cur === undefined) {
      links.set(key, { via, refs: [ref], line });
      return;
    }
    if (!cur.refs.some((r) => r.target === ref.target)) cur.refs.push(ref);
  };

  const docInfo = new Map<string, DocInfo>();
  const signals: KnowledgeLinkSignals = {
    coverage: {},
    uncovered: [],
    stale: [],
    apiMismatches: [],
    screensOnlyInCode: [],
    screensOnlyInIndex: [],
    links: { total: 0, broken: 0, branchOnly: 0, pinned: 0, unchecked: 0 },
    linkedDocs: 0,
    describes: 0,
    gapsByOwner: {},
  };

  for (const d of scanned) {
    const id = docNodeId(d.repoId, d.path);
    const base = knowledgeById.get(id)?.doc ?? { path: d.path };
    let broken = 0;
    let unchecked = 0;
    let newest: string | undefined;
    for (const ref of d.codeRefs) {
      const path = docPathKey(ref.path);
      const facts = options.fileFacts?.(ref.repo, path);
      if (facts === undefined) unchecked++;
      else if (!facts.exists) broken++;
      if (facts?.committedAt !== undefined && (newest === undefined || facts.committedAt > newest))
        newest = facts.committedAt;
      const repo = repoIdOf(ref.repo);
      if (repo === undefined) continue;
      const exact = fileIndex.get(`${repo}:${path}`);
      const targets = exact ?? moduleTargets(modules, repo, path);
      for (const t of new Set(targets)) {
        addLink(
          id,
          t,
          'code-ref',
          {
            target: `${repo}:${path}`,
            verified: facts?.exists === true,
            pinned: ref.pinned,
            ...(facts?.committedAt !== undefined ? { committedAt: facts.committedAt } : {}),
          },
          ref.line,
        );
      }
    }
    for (const api of d.apiRefs ?? []) {
      const ep = endpoints.get(apiKey(api.method, api.path));
      if (ep !== undefined) {
        addLink(
          id,
          ep,
          'api-path',
          { target: apiKey(api.method, api.path), verified: true },
          api.line,
        );
      }
    }

    const info: DocInfo = { ...base };
    if (d.codeRefs.length > 0) {
      info.links = {
        total: d.codeRefs.length,
        broken,
        branchOnly: d.codeRefs.filter((r) => r.pinned === 'branch').length,
        pinned: d.codeRefs.filter((r) => r.pinned === 'commit').length,
        unchecked,
      };
      for (const k of ['total', 'broken', 'branchOnly', 'pinned', 'unchecked'] as const)
        signals.links[k] += info.links[k];
    }
    const own = info.updatedAt ?? info.committedAt;
    if (own !== undefined && newest !== undefined && newest > own) {
      info.staleSince = newest;
      signals.stale.push({ doc: id, updatedAt: own, newestRef: newest });
    }
    docInfo.set(id, info);
  }

  // 화면 색인의 라우트와 코드의 라우트를 맞춘다. 표 한 칸에 라우트가 여럿 적힌 행도 있다
  const prefixes = options.screenIndexPrefixes ?? [];
  if (prefixes.length > 0) {
    const techScreens = new Map<string, string[]>();
    for (const n of tech.nodes) {
      if (n.kind !== 'screen') continue;
      const r = screenRouteOf(n);
      if (r === undefined) continue;
      for (const k of routeKeys(r)) techScreens.set(k, [...(techScreens.get(k) ?? []), n.id]);
    }
    const matchedTech = new Set<string>();
    for (const n of knowledge.nodes) {
      if (n.kind !== 'design_screen') continue;
      if (!prefixes.some((p) => `${n.repo}/${n.doc?.path ?? ''}`.startsWith(p))) continue;
      const routes = (n.doc?.screen?.route ?? '').match(/\/[^\s,;()]*/g) ?? [];
      let hit = false;
      for (const r of routes) {
        const key = routeKey(r);
        let found = (techScreens.get(key) ?? []).map((t) => [t, key] as const);
        if (found.length === 0)
          found = [...techScreens]
            .filter(([k]) => routeFits(key, k))
            .flatMap(([k, ids]) => ids.map((t) => [t, k] as const));
        for (const [t, k] of found) {
          hit = true;
          matchedTech.add(t);
          addLink(n.id, t, 'screen-route', { target: `route:${k}`, verified: true }, 1);
        }
      }
      if (!hit && routes.length > 0) signals.screensOnlyInIndex.push(n.id);
      if (!docInfo.has(n.id) && n.doc !== undefined) docInfo.set(n.id, n.doc);
    }
    const allTech = new Set([...techScreens.values()].flat());
    signals.screensOnlyInCode = [...allTech].filter((t) => !matchedTech.has(t)).sort();
    signals.screensOnlyInIndex.sort();
  }

  const edges: ArchitectureEdge[] = [];
  const linkedDocs = new Set<string>();
  const coveredTech = new Set<string>();
  for (const [key, l] of [...links].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [doc, to] = key.split('\u0000') as [string, string];
    if (!techIds.has(to)) continue;
    linkedDocs.add(doc);
    coveredTech.add(to);
    const src = knowledgeById.get(doc);
    edges.push({
      id: `desc:${doc}->${to}`,
      from: doc,
      to,
      kind: 'describes',
      evidence: [
        {
          type: 'doc',
          location: `${src?.repo ?? 'kb'}:${(src?.doc?.path ?? doc).replace(/#.*$/, '')}:${l.line}`,
          visibility: 'private',
        },
      ],
      lineStyle: 'dashed',
      docLink: { via: l.via, refs: l.refs.sort((a, b) => (a.target < b.target ? -1 : 1)) },
    });
  }

  // 문서가 말한 API가 그림에 없는지는 이 그림에 이어진 문서만 본다. 안 이어진 문서까지 세면 다른 서버 이야기가 다 어긋남이 된다
  const firstTarget = new Map<string, string>();
  for (const e of edges) if (!firstTarget.has(e.from)) firstTarget.set(e.from, e.to);
  const unresolved: UnresolvedQuestion[] = [];
  const docNodes: ArchitectureNode[] = [];
  const nameOf = (n: ArchitectureNode | undefined, id: string): string =>
    n?.displayName ?? n?.label ?? id;
  for (const doc of [...linkedDocs].sort()) {
    const src = knowledgeById.get(doc);
    if (src === undefined) continue;
    const { parent: _parent, ...rest } = src;
    const info = docInfo.get(doc) ?? src.doc;
    docNodes.push({ ...rest, ...(info !== undefined ? { doc: info } : {}) });
    const subject = firstTarget.get(doc)!;
    const gaps = info?.gaps ?? [];
    for (const g of gaps) {
      const who = g.owner ?? NO_OWNER;
      signals.gapsByOwner[who] = (signals.gapsByOwner[who] ?? 0) + 1;
    }
    const gapN = gaps.filter((g) => g.kind === 'gap').length;
    const unvN = gaps.length - gapN;
    if (gaps.length > 0) {
      unresolved.push({
        id: `doc-gap:${doc}`,
        subject: { nodeId: subject },
        question:
          `"${nameOf(src, doc)}" 문서에 ` +
          [
            gapN > 0 ? `비었다고 적힌 곳 ${gapN}개` : '',
            unvN > 0 ? `확인 안 된 서술 ${unvN}개` : '',
          ]
            .filter(Boolean)
            .join(', ') +
          '가 남아 있어요. 채울 수 있나요?',
      });
    }
    const scan = scanned.find((s) => docNodeId(s.repoId, s.path) === doc);
    for (const api of scan?.apiRefs ?? []) {
      const k = apiKey(api.method, api.path);
      if (endpoints.has(k)) continue;
      signals.apiMismatches.push({ doc, api: k, line: api.line });
      unresolved.push({
        id: `doc-api:${doc}:${k}`,
        subject: { nodeId: subject },
        question: `"${nameOf(src, doc)}" 문서가 말하는 ${k}를 이 그림의 엔드포인트에서 못 찾았어요. 바뀌었거나 다른 서버 것인가요?`,
      });
    }
  }

  for (const kind of KNOWLEDGE_COVERAGE_KINDS) {
    const all = tech.nodes.filter((n) => n.kind === kind);
    if (all.length === 0) continue;
    signals.coverage[kind] = {
      total: all.length,
      covered: all.filter((n) => coveredTech.has(n.id)).length,
    };
    for (const n of all) if (!coveredTech.has(n.id)) signals.uncovered.push(n.id);
  }
  signals.uncovered.sort();
  signals.linkedDocs = linkedDocs.size;
  signals.describes = edges.length;

  const knowledgeRepos = knowledge.repos.filter((r) => !tech.repos.some((t) => t.id === r.id));
  const byId = <T extends { id: string }>(a: T, b: T): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return {
    ir: {
      ...tech,
      view: 'knowledge-link',
      packs: [...new Set([...(tech.packs ?? LEGACY_PACK_IDS), 'knowledge'])],
      repos: [...tech.repos, ...knowledgeRepos],
      nodes: [...tech.nodes, ...docNodes].sort(byId),
      edges: [...tech.edges, ...edges].sort(byId),
      unresolved: [...tech.unresolved, ...unresolved.sort(byId)],
      generatedAt: options.generatedAt,
    },
    signals,
    docInfo,
  };
}
