import { posix } from 'node:path';
import type { DocScanResult } from './doc-scan.js';

/** 에이전트가 처음 여는 문서. 폴더 안내판인 INDEX는 들어오는 링크가 없을 때만 진입점으로 본다 */
const ENTRY_NAMES = new Set([
  'readme.md',
  'claude.md',
  'agents.md',
  'skill.md',
  'knowledge_index.md',
]);
const INDEX_NAME = 'index.md';

export interface DeadRoute {
  /** `<repoId>/<path>` */
  from: string;
  keywords: string[];
  targetPath: string;
}

export interface KeywordConflict {
  keyword: string;
  /** `<repoId>/<path>` */
  targets: string[];
}

export interface DocRouteReport {
  /** `<repoId>/<path>` */
  entries: string[];
  reachable: number;
  /** 진입 문서에서 링크를 따라가도 안 닿는 문서. 진입 문서가 하나도 없으면 비운다 */
  orphans: string[];
  deadRoutes: DeadRoute[];
  /** 같은 말이 다른 문서로 안내되는 자리 */
  conflicts: KeywordConflict[];
  /** 질문 안내 표가 이 문서로 보내는 말. 키는 `<repoId>/<path>` */
  keywords: Record<string, string[]>;
}

/** 상대 링크를 레포 기준 경로로 편다. 레포 밖이나 바깥 주소면 undefined */
export function resolveDocLink(fromPath: string, link: string): string | undefined {
  if (/^[a-z]+:/i.test(link) || link.startsWith('#')) return undefined;
  const clean = link.replace(/[#?].*$/, '');
  if (clean === '') return undefined;
  const joined = clean.startsWith('/')
    ? posix.normalize(clean.slice(1))
    : posix.normalize(posix.join(posix.dirname(fromPath), clean));
  return joined.startsWith('..') ? undefined : joined;
}

const keyOf = (d: { repoId: string; path: string }): string => `${d.repoId}/${d.path}`;

export type DocResolver = (
  doc: { repoId: string; path: string },
  ref: string,
) => string | undefined;

/**
 * 문서에 적힌 md 경로를 훑은 문서 하나로 푼다. 돌려주는 값은 `<repoId>/<path>`다.
 * 문서 폴더 기준으로 먼저 본다. 안 맞으면 위 폴더로 한 단씩 올라가며 붙여 본다. 옆 스킬이나 레포 루트 기준으로 적은 경로가 여기서 풀린다.
 * 그래도 없으면 같은 레포에서 뒷부분이 맞는 문서가 하나뿐일 때만 그 문서로 본다
 */
export function docResolver(scan: DocScanResult): DocResolver {
  const keys = new Set(scan.docs.map(keyOf));
  const byName = new Map<string, string[]>();
  for (const k of keys) {
    const base = posix.basename(k);
    byName.set(base, [...(byName.get(base) ?? []), k]);
  }
  return (doc, ref) => {
    const has = (p: string | undefined): string | undefined =>
      p !== undefined && keys.has(`${doc.repoId}/${p}`) ? `${doc.repoId}/${p}` : undefined;
    const raw = ref.replace(/^\$\{?REPO_ROOT\}?\//, '/');
    const direct = has(resolveDocLink(doc.path, raw));
    if (direct !== undefined || /^[a-z]+:/i.test(raw)) return direct;
    const rest = posix.normalize(raw.replace(/[#?].*$/, '').replace(/^(\.{0,2}\/)+/, ''));
    if (rest.startsWith('..') || rest === '.') return undefined;
    for (let dir = posix.dirname(doc.path); ; dir = posix.dirname(dir)) {
      const hit = has(dir === '.' ? rest : `${dir}/${rest}`);
      if (hit !== undefined) return hit;
      if (dir === '.') break;
    }
    const hits = (byName.get(posix.basename(rest)) ?? []).filter(
      (k) => k.startsWith(`${doc.repoId}/`) && k.endsWith(`/${rest}`),
    );
    return hits.length === 1 ? hits[0] : undefined;
  };
}

/** 질문 안내 표와 문서 사이 링크로 질문 길을 따라가 고립 문서, 막다른 안내, 같은 말 충돌을 찾는다 */
export function analyzeDocRoutes(scan: DocScanResult): DocRouteReport {
  const keys = new Set(scan.docs.map(keyOf));
  const resolve = docResolver(scan);

  const out = new Map<string, Set<string>>();
  const inbound = new Set<string>();
  const deadRoutes: DeadRoute[] = [];
  const keywordTargets = new Map<string, Set<string>>();
  const keywords = new Map<string, Set<string>>();
  for (const d of scan.docs) {
    const from = keyOf(d);
    const next = new Set<string>();
    const add = (k: string | undefined): void => {
      if (k === undefined || k === from) return;
      next.add(k);
      inbound.add(k);
    };
    for (const l of d.mdLinks) add(keys.has(`${d.repoId}/${l}`) ? `${d.repoId}/${l}` : undefined);
    for (const r of d.mdRefs ?? []) add(resolve(d, r));
    for (const r of d.routes) {
      const target = resolve(d, r.link ?? r.targetPath);
      if (target === undefined) {
        deadRoutes.push({ from, keywords: r.keywords, targetPath: r.targetPath });
        continue;
      }
      add(target);
      for (const raw of r.keywords) {
        const kw = raw.toLowerCase();
        keywordTargets.set(kw, (keywordTargets.get(kw) ?? new Set()).add(target));
        keywords.set(target, (keywords.get(target) ?? new Set()).add(raw));
      }
    }
    out.set(from, next);
  }

  const entries = scan.docs
    .filter((d) => {
      const name = posix.basename(d.path).toLowerCase();
      return ENTRY_NAMES.has(name) || (name === INDEX_NAME && !inbound.has(keyOf(d)));
    })
    .map(keyOf)
    .sort();
  const seen = new Set(entries);
  const queue = [...entries];
  while (queue.length > 0) {
    for (const n of out.get(queue.pop()!) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }

  const conflicts = [...keywordTargets]
    .filter(([, t]) => t.size > 1)
    .map(([keyword, t]) => ({ keyword, targets: [...t].sort() }))
    .sort((a, b) => (a.keyword < b.keyword ? -1 : 1));
  return {
    entries,
    reachable: seen.size,
    orphans: entries.length === 0 ? [] : [...keys].filter((k) => !seen.has(k)).sort(),
    deadRoutes,
    conflicts,
    keywords: Object.fromEntries([...keywords].map(([k, v]) => [k, [...v]])),
  };
}
