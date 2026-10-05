import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import matter from 'gray-matter';
import type {
  ArchitectureEdge,
  ArchitectureIr,
  ArchitectureNode,
  DocGap,
  DocInfo,
  DocRoute,
  DocScreen,
  Evidence,
} from './types.js';
import { ARCHITECTURE_IR_SCHEMA_VERSION } from './types.js';
import { docPathKey } from './name-ref-match.js';

/**
 * 근거 표시와 구멍 표시, 머리줄을 찾는 정규식. 레포마다 형식이 달라 바꿀 수 있게 열어 둔다.
 * evidence는 첫 캡처가 `종류:위치@ref` 꼴이어야 하고 gap과 unverified는 첫 캡처가 설명이다
 */
export interface DocScanPatterns {
  evidence?: string;
  gap?: string;
  unverified?: string;
  updated?: string;
  keywordHeader?: string;
  routeHeader?: string;
  screenNameHeader?: string;
}

const DEFAULT_PATTERNS: Required<DocScanPatterns> = {
  evidence: String.raw`\[(?:evidence|근거)\s*:\s*([^\]]+)\]`,
  gap: String.raw`\[GAP(?:\s*:\s*([^\]]*))?\]`,
  unverified: String.raw`\[UNVERIFIED(?:\s*:\s*([^\]]*))?\]`,
  updated: String.raw`^>\s*(?:최종\s*수정|마지막\s*수정|last\s*updated|updated)\s*[:：]?\s*(\d{4}-\d{2}-\d{2})`,
  keywordHeader: String.raw`키워드|질문|keyword|question|trigger`,
  routeHeader: String.raw`url|라우트|route|진입|path`,
  screenNameHeader: String.raw`^화면$|화면\s*명|화면\s*이름|screen|name`,
};

export interface DocRoot {
  repoId: string;
  name?: string;
  path: string;
  /** 이 접두로 시작하는 경로만 훑는다. 비면 전부 */
  include?: string[];
  exclude?: string[];
}

/** 코드 파일을 가리킨 근거. 링크 상태 검사와 기술 노드 잇기가 이걸 쓴다 */
export interface DocCodeRef {
  repo: string;
  path: string;
  ref?: string;
  pinned: 'branch' | 'commit' | 'none';
  line: number;
}

export interface DocScreenRow extends DocScreen {
  name: string;
  line: number;
}

export interface ScannedDoc {
  repoId: string;
  path: string;
  title?: string;
  updatedAt?: string;
  sections: string[];
  gaps: DocGap[];
  evidenceMix: Record<string, number>;
  codeRefs: DocCodeRef[];
  routes: DocRoute[];
  screens: DocScreenRow[];
  /** 본문의 상대 md 링크. 레포 기준 경로로 편 것 */
  mdLinks: string[];
  /** 본문이 말한 `METHOD /path`. 기술 그림 엔드포인트와 맞춰 보는 데 쓴다. 예전 스캔 결과에는 없다 */
  apiRefs?: DocApiRef[];
}

export interface DocApiRef {
  method: string;
  path: string;
  line: number;
}

export interface DocScanResult {
  docs: ScannedDoc[];
  skipped: { path: string; reason: string }[];
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo']);
const TEXT_LIMIT = 160;

// 근거 종류를 막대 색 묶음으로 접는다. 레포 이름이 그대로 공유본에 실리지 않게 코드 근거는 code 하나로 모은다
const KIND_GROUPS: Record<string, string> = {
  confluence: 'wiki',
  notion: 'wiki',
  wiki: 'wiki',
  jira: 'ticket',
  ticket: 'ticket',
  linear: 'ticket',
  slack: 'chat',
  redash: 'data',
  aws: 'data',
  db: 'data',
  datadog: 'data',
  grafana: 'data',
  sentry: 'data',
  amplitude: 'data',
  ui: 'ui',
  figma: 'ui',
  url: 'url',
  svc: 'data',
  doc: 'doc',
  docs: 'doc',
  kb: 'doc',
};
const CODE_HOST_KINDS = new Set(['github', 'github-ext', 'gitlab', 'bitbucket']);
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;
const CODE_HOST_URL_RE =
  /https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/[^/\s]+\/([^/\s]+)\/(?:-\/)?(?:blob|tree|src)\/([^/\s]+)\/([^\s)#?]+)(?:#L(\d+))?/g;

// 예시 요청은 코드 블록에 자주 있어서 API 언급만은 코드 블록 안도 센다
const API_RE = /\b(GET|POST|PUT|PATCH|DELETE)\s+`?(\/[\w\-./{}:<>[\]]*[\w}\]>])/g;
const toPosix = (p: string): string => p.split(sep).join('/');

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > TEXT_LIMIT ? `${t.slice(0, TEXT_LIMIT - 1)}…` : t;
}

function pinOf(ref: string | undefined): DocCodeRef['pinned'] {
  if (ref === undefined || ref === '') return 'none';
  return COMMIT_RE.test(ref) ? 'commit' : 'branch';
}

/** `종류:위치@ref`를 막대 묶음과 코드 참조로 나눈다. 코드가 아니면 ref는 null */
export function parseEvidenceMarker(
  body: string,
  line: number,
): { group: string; ref: DocCodeRef | null } {
  const raw = body.trim();
  if (raw.includes('<')) return { group: 'other', ref: null };
  const colon = raw.indexOf(':');
  // 종류 없이 `레포/경로:줄@ref`로 쓴 꼴. 첫 콜론 앞에 /가 있으면 종류가 아니라 경로다
  const head = colon > 0 ? raw.slice(0, colon) : raw;
  if (head.includes('/') && !/^https?$/i.test(head)) {
    const at = raw.lastIndexOf('@');
    const ref = at > 0 ? raw.slice(at + 1).trim() : undefined;
    const loc = docPathKey(at > 0 ? raw.slice(0, at) : raw);
    const slash = loc.indexOf('/');
    if (slash <= 0 || /\s/.test(loc)) return { group: 'other', ref: null };
    return {
      group: 'code',
      ref: { repo: loc.slice(0, slash), path: loc.slice(slash + 1), ref, pinned: pinOf(ref), line },
    };
  }
  const kind = (colon > 0 ? raw.slice(0, colon) : raw).trim().toLowerCase();
  const rest = colon > 0 ? raw.slice(colon + 1).trim() : '';
  const known = KIND_GROUPS[kind];
  if (known !== undefined) return { group: known, ref: null };
  const at = rest.lastIndexOf('@');
  const location = (at > 0 ? rest.slice(0, at) : rest).trim();
  const ref = at > 0 ? rest.slice(at + 1).trim() : undefined;
  if (CODE_HOST_KINDS.has(kind)) {
    // 조직/레포/경로. 조직을 빼고 레포와 경로만 남긴다
    const parts = location.split('/').filter(Boolean);
    if (parts.length < 3) return { group: 'code', ref: null };
    return {
      group: 'code',
      ref: { repo: parts[1]!, path: parts.slice(2).join('/'), ref, pinned: pinOf(ref), line },
    };
  }
  // 종류 자리에 레포 이름을 바로 쓴 꼴. 위치가 경로처럼 생겼을 때만 코드로 본다
  if (/[/.]/.test(location) && !/\s/.test(location)) {
    return {
      group: 'code',
      ref: { repo: kind, path: docPathKey(location), ref, pinned: pinOf(ref), line },
    };
  }
  return { group: 'other', ref: null };
}

function ownerOf(text: string): string | undefined {
  const m =
    /(?:담당(?:자)?|owner)\s*[:：=]\s*([^,;)\]|]+)/i.exec(text) ?? /@([\w][\w.-]*)/.exec(text);
  return m ? m[1]!.trim() : undefined;
}

function splitRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  const cells = t
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
  return cells;
}

const isDivider = (cells: string[]): boolean => cells.every((c) => /^:?-{2,}:?$/.test(c));

function plain(cell: string): string {
  return cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__/g, '')
    .trim();
}

function linkTargets(cell: string): string[] {
  const out: string[] = [];
  for (const m of cell.matchAll(/\]\(([^)\s]+)\)/g)) out.push(m[1]!);
  for (const m of cell.matchAll(/`([^`\s]+\.md)`/g)) out.push(m[1]!);
  return out;
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

const blank = (cell: string): boolean => /^[-—–]?$/.test(cell.trim());

function truthy(cell: string): boolean | undefined {
  const t = plain(cell).toLowerCase();
  if (t === '') return false;
  if (/^(x|n|no|false|-|—|–|없음|없다|미|❌|✗)$/.test(t)) return false;
  if (/^(o|y|yes|true|v|✓|✔|✅|있음|있다)$/.test(t)) return true;
  if (/\]\(/.test(cell)) return true;
  return undefined;
}

interface TableCols {
  header: string[];
  find: (re: RegExp) => number;
}

function cols(header: string[]): TableCols {
  const lower = header.map((h) => plain(h).toLowerCase());
  return { header: lower, find: (re) => lower.findIndex((h) => re.test(h)) };
}

/** md 한 파일을 훑는다. 파일 시스템을 안 만져서 테스트가 문자열만 넘기면 된다 */
export function scanMarkdown(
  repoId: string,
  path: string,
  text: string,
  patterns: DocScanPatterns = {},
): ScannedDoc {
  const p = { ...DEFAULT_PATTERNS, ...patterns };
  const evidenceRe = new RegExp(p.evidence, 'gi');
  const gapRe = new RegExp(p.gap, 'g');
  const unverifiedRe = new RegExp(p.unverified, 'g');
  const updatedRe = new RegExp(p.updated, 'i');
  const keywordRe = new RegExp(p.keywordHeader, 'i');
  const routeRe = new RegExp(p.routeHeader, 'i');
  const screenNameRe = new RegExp(p.screenNameHeader, 'i');

  let fm: Record<string, unknown> = {};
  let body = text;
  let offset = 0;
  try {
    const parsed = matter(text);
    fm = parsed.data;
    body = parsed.content;
    offset = text.slice(0, text.length - body.length).split('\n').length - 1;
  } catch {
    // frontmatter가 깨진 파일은 본문만 본다
  }
  const out: ScannedDoc = {
    repoId,
    path,
    sections: [],
    gaps: [],
    evidenceMix: {},
    codeRefs: [],
    routes: [],
    screens: [],
    mdLinks: [],
    apiRefs: [],
  };
  const apiSeen = new Set<string>();
  const title = typeof fm['title'] === 'string' ? fm['title'] : undefined;
  if (title !== undefined) out.title = clip(title);
  for (const key of ['updated', 'last_updated', 'updatedAt', 'lastUpdated']) {
    const v = fm[key];
    if (v instanceof Date) out.updatedAt = v.toISOString().slice(0, 10);
    else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) out.updatedAt = v.slice(0, 10);
  }
  const fmSources = fm['sources'];
  const bump = (group: string): void => {
    out.evidenceMix[group] = (out.evidenceMix[group] ?? 0) + 1;
  };
  if (Array.isArray(fmSources)) {
    for (const s of fmSources) {
      if (typeof s !== 'string') continue;
      const { group, ref } = parseEvidenceMarker(s, 1);
      bump(group);
      if (ref) out.codeRefs.push(ref);
    }
  }

  const lines = body.split('\n');
  const links = new Set<string>();
  let fenced = false;
  let table: { cols: TableCols; kind: 'route' | 'screen' | 'other' } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1 + offset;
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    for (const m of line.matchAll(API_RE)) {
      const key = `${m[1]} ${m[2]}`;
      if (apiSeen.has(key)) continue;
      apiSeen.add(key);
      out.apiRefs!.push({ method: m[1]!, path: m[2]!, line: lineNo });
    }
    if (fenced) continue;

    const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (h1 && out.title === undefined) out.title = clip(plain(h1[1]!));
    const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h2 && out.sections.length < 40) out.sections.push(clip(plain(h2[1]!)));
    if (out.updatedAt === undefined) {
      const u = updatedRe.exec(line);
      if (u) out.updatedAt = u[1]!;
    }

    for (const m of line.matchAll(evidenceRe)) {
      const { group, ref } = parseEvidenceMarker(m[1] ?? '', lineNo);
      bump(group);
      if (ref) out.codeRefs.push(ref);
    }
    for (const m of line.matchAll(CODE_HOST_URL_RE)) {
      const ref = m[2]!;
      out.codeRefs.push({ repo: m[1]!, path: m[3]!, ref, pinned: pinOf(ref), line: lineNo });
      bump('code');
    }
    // `[GAP]`만 쓰고 설명은 뒤에 잇는 문서가 많아 캡처가 비면 그 줄의 나머지를 설명으로 본다
    const after = (m: RegExpMatchArray): string =>
      m[1] ?? plain(line.slice((m.index ?? 0) + m[0].length).replace(/^[\s*:—–-]+/, ''));
    for (const m of line.matchAll(gapRe)) {
      const text = after(m);
      const owner = ownerOf(text);
      out.gaps.push({
        kind: 'gap',
        ...(text.trim() !== '' ? { text: clip(text) } : {}),
        ...(owner !== undefined ? { owner } : {}),
        line: lineNo,
      });
    }
    for (const m of line.matchAll(unverifiedRe)) {
      const text = after(m);
      out.gaps.push({
        kind: 'unverified',
        ...(text.trim() !== '' ? { text: clip(text) } : {}),
        line: lineNo,
      });
    }
    for (const m of line.matchAll(/\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g)) {
      const target = resolveDocLink(path, m[1]!);
      if (target !== undefined) links.add(target);
    }

    const cells = splitRow(line);
    if (cells === null) {
      table = null;
      continue;
    }
    if (table === null) {
      const next = splitRow(lines[i + 1] ?? '');
      if (next === null || !isDivider(next)) continue;
      const c = cols(cells);
      const kw = c.find(keywordRe);
      const route = c.find(routeRe);
      const name = c.find(screenNameRe);
      // 화면 설계 문서 안의 작은 표까지 화면 색인으로 잡지 않게 프레임이나 타입 열도 있어야 색인으로 본다
      const screenish = c.find(/프레임|frame|타입|유형|type/) >= 0;
      const kind = route >= 0 && name >= 0 && screenish ? 'screen' : kw >= 0 ? 'route' : 'other';
      table = { cols: c, kind };
      i++;
      continue;
    }
    if (table.kind === 'route') {
      const kw = table.cols.find(keywordRe);
      const keywords = plain(cells[kw] ?? '')
        .split(/[,/·、;]/)
        .map((k) => k.trim())
        .filter(Boolean);
      const target = cells
        .filter((_, j) => j !== kw)
        .flatMap(linkTargets)
        .map((l) => resolveDocLink(path, l))
        .find((t): t is string => t !== undefined && t.endsWith('.md'));
      if (keywords.length > 0 && target !== undefined) {
        out.routes.push({ keywords, targetPath: target });
      }
    } else if (table.kind === 'screen') {
      const c = table.cols;
      const at = (re: RegExp): string | undefined => {
        const j = c.find(re);
        return j >= 0 ? cells[j] : undefined;
      };
      const name = plain(at(screenNameRe) ?? '');
      if (name === '') continue;
      const row: DocScreenRow = { name: clip(name), line: lineNo };
      const route = plain(at(routeRe) ?? '');
      if (!blank(route)) row.route = clip(route);
      const type = plain(at(/타입|유형|type|종류/) ?? '');
      if (type !== '') row.screenType = clip(type);
      const frame = plain(at(/프레임|frame/) ?? '');
      if (!blank(frame)) row.frame = clip(frame);
      const nodeId = plain(at(/node.?id|노드/) ?? '');
      if (/^\d+[:-]\d+$/.test(nodeId)) row.frameNode = nodeId;
      const key = at(/component.?key|컴포넌트|심볼/);
      if (key !== undefined) row.symbolized = truthy(key) ?? plain(key) !== '';
      const spec = at(/design\.md|설계|스펙|spec/);
      if (spec !== undefined) row.hasSpec = truthy(spec) ?? false;
      const syn = plain(at(/동의어|별칭|synonym|alias/) ?? '');
      if (!blank(syn)) {
        row.synonyms = syn
          .split(/[,/·、;]/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      out.screens.push(row);
    }
  }
  out.mdLinks = [...links].sort();
  return out;
}

function listMarkdown(root: DocRoot): { rel: string; abs: string }[] {
  const files: { rel: string; abs: string }[] = [];
  for (const ent of readdirSync(root.path, { recursive: true, withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue;
    const abs = join(ent.parentPath, ent.name);
    const rel = toPosix(relative(root.path, abs));
    if (rel.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
    if (root.include?.length && !root.include.some((p) => rel.startsWith(p))) continue;
    if (root.exclude?.some((p) => rel.startsWith(p))) continue;
    files.push({ rel, abs });
  }
  // 심링크 폴더를 따라가면 같은 파일이 두 경로로 잡힌다. 실제 파일 하나에 경로 하나만 남기고 숨김 폴더 밖 경로를 고른다
  const hidden = (rel: string): number => (rel.split('/').some((s) => s.startsWith('.')) ? 1 : 0);
  const best = new Map<string, { rel: string; abs: string }>();
  for (const f of files) {
    let real = f.abs;
    try {
      real = realpathSync(f.abs);
    } catch {
      // 끊긴 링크는 경로 그대로 둔다
    }
    const prev = best.get(real);
    if (
      prev === undefined ||
      hidden(f.rel) - hidden(prev.rel) < 0 ||
      (hidden(f.rel) === hidden(prev.rel) && f.rel.length < prev.rel.length)
    ) {
      best.set(real, f);
    }
  }
  return [...best.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** 문서 루트들의 md를 전부 훑는다. 읽기만 한다 */
export function scanDocRoots(roots: DocRoot[], patterns: DocScanPatterns = {}): DocScanResult {
  const docs: ScannedDoc[] = [];
  const skipped: DocScanResult['skipped'] = [];
  for (const root of roots) {
    for (const f of listMarkdown(root)) {
      let text: string;
      try {
        text = readFileSync(f.abs, 'utf8');
      } catch (err) {
        skipped.push({ path: `${root.repoId}:${f.rel}`, reason: String(err) });
        continue;
      }
      docs.push(scanMarkdown(root.repoId, f.rel, text, patterns));
    }
  }
  return { docs, skipped };
}

const docEvidence = (repoId: string, path: string, line = 1): Evidence => ({
  type: 'doc',
  location: `${repoId}:${path}:${line}`,
  visibility: 'private',
});

export const docNodeId = (repoId: string, path: string): string => `doc:${repoId}/${path}`;
const groupNodeId = (repoId: string, dir: string): string => `dir:${repoId}/${dir}`;

const INDEX_NAMES = ['INDEX.md', 'README.md', 'index.md', 'readme.md'];

function linkHealth(refs: DocCodeRef[]): DocInfo['links'] | undefined {
  if (refs.length === 0) return undefined;
  return {
    total: refs.length,
    broken: 0,
    branchOnly: refs.filter((r) => r.pinned === 'branch').length,
    pinned: refs.filter((r) => r.pinned === 'commit').length,
    unchecked: refs.length,
  };
}

/**
 * 훑은 결과로 지식 문서 지도 IR 초안을 만든다. 폴더가 묶음, md가 문서, 화면 색인 표의 행이 화면 문서다.
 * 질문 안내 표와 화면 색인은 indexes 선으로 잇는다. 세션이 이 초안을 다듬어 render에 넘긴다
 */
export function buildKnowledgeIr(
  roots: DocRoot[],
  scan: DocScanResult,
  generatedAt: string,
): ArchitectureIr {
  const nodes: ArchitectureNode[] = [];
  const edges: ArchitectureEdge[] = [];
  const byKey = new Map(scan.docs.map((d) => [`${d.repoId}/${d.path}`, d]));
  const groups = new Map<string, ArchitectureNode>();

  // 레포마다 묶음 하나를 맨 위에 둔다. 전체보기가 레포 카드만 보여 주고 그 아래로 폴더를 따라 들어간다
  const rootGroup = (repoId: string): string => {
    const id = groupNodeId(repoId, '.');
    if (!groups.has(id)) {
      const name = roots.find((r) => r.repoId === repoId)?.name ?? repoId;
      groups.set(id, {
        id,
        kind: 'doc_group',
        label: `${repoId}/`,
        displayName: name,
        repo: repoId,
        evidence: [docEvidence(repoId, '.')],
        doc: { path: './' },
      });
    }
    return id;
  };

  const ensureGroup = (repoId: string, dir: string): string => {
    if (dir === '.' || dir === '') return rootGroup(repoId);
    const id = groupNodeId(repoId, dir);
    if (groups.has(id)) return id;
    const parent = ensureGroup(repoId, posix.dirname(dir));
    const index = INDEX_NAMES.map((n) => byKey.get(`${repoId}/${dir}/${n}`)).find(Boolean);
    const node: ArchitectureNode = {
      id,
      kind: 'doc_group',
      label: `${dir}/`,
      displayName: index?.title ?? posix.basename(dir),
      repo: repoId,
      parent,
      evidence: [docEvidence(repoId, index ? index.path : dir)],
      doc: { path: `${dir}/` },
    };
    groups.set(id, node);
    return id;
  };

  for (const d of scan.docs) {
    const dir = posix.dirname(d.path);
    const parent = ensureGroup(d.repoId, dir);
    const id = docNodeId(d.repoId, d.path);
    const doc: DocInfo = { path: d.path };
    if (d.updatedAt !== undefined) doc.updatedAt = d.updatedAt;
    if (d.sections.length) doc.sections = d.sections;
    if (d.gaps.length) doc.gaps = d.gaps;
    if (Object.keys(d.evidenceMix).length) doc.evidenceMix = d.evidenceMix;
    const links = linkHealth(d.codeRefs);
    if (links !== undefined) doc.links = links;
    if (d.routes.length) {
      doc.routes = d.routes.map((r) => {
        const target = byKey.has(`${d.repoId}/${r.targetPath}`)
          ? docNodeId(d.repoId, r.targetPath)
          : undefined;
        return { ...r, ...(target !== undefined ? { target } : {}) };
      });
    }
    nodes.push({
      id,
      kind: 'document',
      label: d.path,
      ...(d.title !== undefined ? { displayName: d.title } : {}),
      repo: d.repoId,
      parent,
      evidence: [docEvidence(d.repoId, d.path)],
      doc,
    });
    const seen = new Set<string>();
    for (const r of doc.routes ?? []) {
      if (r.target === undefined || r.target === id || seen.has(r.target)) continue;
      seen.add(r.target);
      edges.push({
        id: `ix:${id}->${r.target}`,
        from: id,
        to: r.target,
        kind: 'indexes',
        evidence: [docEvidence(d.repoId, d.path)],
        lineStyle: 'dashed',
      });
    }
    if (d.screens.length) {
      const screenGroup = `${groupNodeId(d.repoId, d.path)}#screens`;
      groups.set(screenGroup, {
        id: screenGroup,
        kind: 'doc_group',
        label: `${d.path}#screens`,
        displayName: `${d.title ?? posix.basename(d.path)} 화면`,
        repo: d.repoId,
        parent,
        evidence: [docEvidence(d.repoId, d.path)],
        doc: { path: d.path },
      });
      const used = new Map<string, number>();
      for (const row of d.screens) {
        const base = `${d.path}#${row.name}`;
        const n = (used.get(base) ?? 0) + 1;
        used.set(base, n);
        const label = n > 1 ? `${base} (${n})` : base;
        const { name, line, ...screen } = row;
        const sid = `scr:${d.repoId}/${label}`;
        nodes.push({
          id: sid,
          kind: 'design_screen',
          label,
          displayName: name,
          repo: d.repoId,
          parent: screenGroup,
          evidence: [docEvidence(d.repoId, d.path, line)],
          doc: { path: `${d.path}#L${line}`, screen },
        });
      }
    }
  }
  const sortById = <T extends { id: string }>(a: T, b: T): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return {
    schemaVersion: ARCHITECTURE_IR_SCHEMA_VERSION,
    view: 'knowledge',
    packs: ['knowledge'],
    repos: roots.map((r) => ({ id: r.repoId, name: r.name ?? r.repoId })),
    nodes: [...groups.values(), ...nodes].sort(sortById),
    edges: edges.sort(sortById),
    unresolved: [],
    sourcesUsed: [],
    generatedAt,
  };
}

export interface DocScanSummary {
  docCount: number;
  withUpdatedAt: number;
  gapCount: number;
  unverifiedCount: number;
  evidenceMix: Record<string, number>;
  codeRefCount: number;
  apiRefCount: number;
  routeCount: number;
  unresolvedRouteCount: number;
  screenCount: number;
}

export function summarizeScan(scan: DocScanResult): DocScanSummary {
  const keys = new Set(scan.docs.map((d) => `${d.repoId}/${d.path}`));
  const mix: Record<string, number> = {};
  let routes = 0;
  let unresolvedRoutes = 0;
  for (const d of scan.docs) {
    for (const [k, v] of Object.entries(d.evidenceMix)) mix[k] = (mix[k] ?? 0) + v;
    routes += d.routes.length;
    unresolvedRoutes += d.routes.filter((r) => !keys.has(`${d.repoId}/${r.targetPath}`)).length;
  }
  return {
    docCount: scan.docs.length,
    withUpdatedAt: scan.docs.filter((d) => d.updatedAt !== undefined).length,
    gapCount: scan.docs.reduce((a, d) => a + d.gaps.filter((g) => g.kind === 'gap').length, 0),
    unverifiedCount: scan.docs.reduce(
      (a, d) => a + d.gaps.filter((g) => g.kind === 'unverified').length,
      0,
    ),
    evidenceMix: Object.fromEntries(Object.entries(mix).sort(([a], [b]) => (a < b ? -1 : 1))),
    codeRefCount: scan.docs.reduce((a, d) => a + d.codeRefs.length, 0),
    apiRefCount: scan.docs.reduce((a, d) => a + (d.apiRefs?.length ?? 0), 0),
    routeCount: routes,
    unresolvedRouteCount: unresolvedRoutes,
    screenCount: scan.docs.reduce((a, d) => a + d.screens.length, 0),
  };
}
