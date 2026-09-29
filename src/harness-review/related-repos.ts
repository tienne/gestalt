import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { log } from '../core/log.js';
import { isHarnessPath } from './identifiers.js';
import type { DetectionCache, Identifier, RelatedRepo } from './types.js';

export { isHarnessPath };

export const DETECTION_CACHE_PATH = join('.gestalt', 'harness-refs-cache.json');
export const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 1;

export interface RepoRef {
  owner: string;
  name: string;
}

/** gh CLI 실행부. 테스트에서 가짜로 바꿔 네트워크를 타지 않게 한다. */
export type GhRunner = (args: string[]) => string;

export const defaultGhRunner: GhRunner = (args) =>
  execFileSync('gh', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

/** MCP 패키지 이름 → 그 package.json의 repository 필드 값. 못 찾으면 null. */
export type PackageRepositoryResolver = (packageName: string, repoRoot: string) => unknown;

export const defaultPackageRepositoryResolver: PackageRepositoryResolver = (pkg, repoRoot) => {
  const manifest = join(repoRoot, 'node_modules', ...pkg.split('/'), 'package.json');
  if (!existsSync(manifest)) return null;
  const json = readJson(manifest);
  return isRecord(json) ? (json.repository ?? null) : null;
};

export interface DetectRelatedReposOptions {
  /** gestalt.json에서 온 추가 레포. "owner/name" 또는 GitHub URL. 추가만 받는다. */
  extraRepos?: ReadonlyArray<string | RepoRef>;
  /** 캐시가 없거나 낡았을 때만 부른다. 결과는 캐시에 함께 저장된다. */
  extractIdentifiers?: (ctx: { repoRoot: string; harnessDocs: string[] }) => Identifier[];
  gh?: GhRunner;
  resolvePackageRepository?: PackageRepositoryResolver;
  now?: Date;
  ttlMs?: number;
  /** true면 캐시를 무시하고 다시 탐지한다. */
  refresh?: boolean;
}

export type RelatedRepoDetection =
  | { noGitHubRemote: true; reason: string }
  | {
      noGitHubRemote: false;
      org: string;
      self: RepoRef;
      relatedRepos: RelatedRepo[];
      identifiers: Identifier[];
      fromCache: boolean;
      cache: DetectionCache;
    };

/**
 * 현재 레포의 관련 레포를 찾는다. origin의 owner를 조직으로 보고 하네스 문서의
 * 순방향 언급에서 같은 조직 레포를 뽑는다. 결과는 .gestalt/harness-refs-cache.json에
 * 저장하고 하네스 문서 해시가 바뀌거나 expiresAt이 지나면 다시 탐지한다.
 */
export function detectRelatedRepos(
  repoRoot: string,
  opts: DetectRelatedReposOptions = {},
): RelatedRepoDetection {
  const self = readOriginRepo(repoRoot);
  if (!self) {
    return {
      noGitHubRemote: true,
      reason: 'origin 원격이 없거나 GitHub 주소가 아니라 조직을 정할 수 없다',
    };
  }

  const now = opts.now ?? new Date();
  const gh = opts.gh ?? defaultGhRunner;
  const inputs = collectDetectionInputs(repoRoot);
  const hash = computeHarnessDocsHash(repoRoot, inputs);
  const configRepos = normalizeConfigRepos(opts.extraRepos ?? []);

  const cached = opts.refresh ? null : readDetectionCache(repoRoot);
  if (cached && cached.selfRepo === repoKey(self) && isCacheFresh(cached, hash, now)) {
    const autoRepos = cached.relatedRepos.filter((r) => r.discoveredBy !== 'config');
    const relatedRepos = mergeRepos(autoRepos, configRepos, self, gh, now, cached.relatedRepos);
    return {
      noGitHubRemote: false,
      org: self.owner,
      self,
      relatedRepos,
      identifiers: cached.identifiers,
      fromCache: true,
      cache: { ...cached, relatedRepos },
    };
  }

  const mentioned = findForwardMentions(repoRoot, self.owner, inputs, {
    resolvePackageRepository: opts.resolvePackageRepository ?? defaultPackageRepositoryResolver,
  });
  const autoRepos = mentioned
    .filter((r) => !sameRepo(r, self))
    .map((r) => toRelatedRepo(r, 'forwardMention', gh, now));
  const relatedRepos = mergeRepos(autoRepos, configRepos, self, gh, now);
  const identifiers =
    opts.extractIdentifiers?.({ repoRoot, harnessDocs: inputs.harnessDocs }) ?? [];

  const cache: DetectionCache = {
    relatedRepos,
    identifiers,
    harnessDocsHash: hash,
    expiresAt: new Date(now.getTime() + (opts.ttlMs ?? DEFAULT_CACHE_TTL_MS)),
  };
  writeDetectionCache(repoRoot, cache, self);

  return {
    noGitHubRemote: false,
    org: self.owner,
    self,
    relatedRepos,
    identifiers,
    fromCache: false,
    cache,
  };
}

// ── 원격 ──────────────────────────────────────────────

export function parseGitHubRepo(input: string): RepoRef | null {
  const s = input.trim();
  const url = s.match(
    /^(?:git\+)?(?:https?:\/\/|ssh:\/\/git@|git@|git:\/\/)(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i,
  );
  if (url) return { owner: url[1]!, name: url[2]! };
  const short = s.match(/^(?:github:)?([A-Za-z0-9][\w-]*)\/([\w.-]+?)(?:\.git)?$/);
  if (short) return { owner: short[1]!, name: short[2]! };
  return null;
}

export function readOriginRepo(repoRoot: string): RepoRef | null {
  let url: string;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  if (!/github\.com/i.test(url)) return null;
  return parseGitHubRepo(url);
}

// ── 하네스 문서 수집 ──────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.gestalt',
  '.gestalt-test',
  'dist',
  'coverage',
]);

// node_modules 같은 큰 트리를 들어가기 전에 잘라야 해서 recursive 옵션 대신 직접 내려간다.
// 심링크는 따라가지 않는다. 같은 문서를 두 번 읽거나 레포 밖으로 나가지 않게 하려는 것이다.
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = join(e.parentPath, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(abs);
      } else if (e.isFile()) {
        out.push(relative(root, abs).split(sep).join('/'));
      }
    }
  }
  return out.sort();
}

interface DetectionInputs {
  harnessDocs: string[];
  mcpPackageManifests: string[];
}

function collectDetectionInputs(repoRoot: string): DetectionInputs {
  const files = walkFiles(repoRoot);
  const harnessDocs = files.filter(isHarnessPath);
  const mcpPackageManifests = files.filter((f) => {
    if (basename(f) !== 'package.json') return false;
    const json = readJson(join(repoRoot, f));
    return isRecord(json) && json.private !== true && dependsOnMcpSdk(json);
  });
  return { harnessDocs, mcpPackageManifests };
}

function dependsOnMcpSdk(pkg: Record<string, unknown>): boolean {
  return ['dependencies', 'peerDependencies'].some((k) => {
    const deps = pkg[k];
    return isRecord(deps) && '@modelcontextprotocol/sdk' in deps;
  });
}

export function computeHarnessDocsHash(
  repoRoot: string,
  inputs: DetectionInputs = collectDetectionInputs(repoRoot),
): string {
  const h = createHash('sha256');
  for (const f of [...inputs.harnessDocs, ...inputs.mcpPackageManifests].sort()) {
    h.update(f);
    h.update('\0');
    h.update(readFileSync(join(repoRoot, f)));
    h.update('\0');
  }
  return h.digest('hex');
}

// ── 순방향 언급 ───────────────────────────────────────

const GITHUB_URL_RE =
  /(?:https?:\/\/(?:www\.)?|git@)github\.com[/:]([A-Za-z0-9][\w-]*)\/([\w.-]+)/gi;
const GH_CLONE_RE = /\bgh\s+repo\s+clone\s+([A-Za-z0-9][\w-]*)\/([\w.-]+)/g;

function cleanRepoName(raw: string): string {
  return raw.replace(/\.git$/i, '').replace(/[.]+$/, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 본문에서 조직 레포 언급을 뽑는다. owner/repo 표기, GitHub URL, gh repo clone 대상. */
export function extractRepoMentions(text: string, org: string): RepoRef[] {
  const found: RepoRef[] = [];
  const push = (owner: string, name: string) => {
    const clean = cleanRepoName(name);
    if (clean && owner.toLowerCase() === org.toLowerCase()) found.push({ owner: org, name: clean });
  };

  for (const m of text.matchAll(GITHUB_URL_RE)) push(m[1]!, m[2]!);
  for (const m of text.matchAll(GH_CLONE_RE)) push(m[1]!, m[2]!);
  // 경로 한가운데의 "x/acme/y"나 이메일, 스코프 패키지(@acme/x)는 레포 표기가 아니다.
  const shortRe = new RegExp(`(?<![\\w./@:-])(${escapeRegExp(org)})/([\\w.-]+)`, 'gi');
  for (const m of text.matchAll(shortRe)) {
    push(m[1]!, m[2]!);
  }
  return dedupeRepos(found);
}

function parseRepositoryField(value: unknown): RepoRef | null {
  if (typeof value === 'string') return parseGitHubRepo(value);
  if (isRecord(value) && typeof value.url === 'string') return parseGitHubRepo(value.url);
  return null;
}

// marketplace 소스 꼴: { source: 'github', repo } 또는 { source: 'git'|'url', url }.
function parseMarketplaceSource(value: unknown): RepoRef | null {
  if (!isRecord(value)) return null;
  if (typeof value.repo === 'string') return parseGitHubRepo(value.repo);
  if (typeof value.url === 'string') return parseGitHubRepo(value.url);
  return null;
}

interface ManifestFacts {
  marketplaces: Map<string, RepoRef>;
  pluginRepos: RepoRef[];
  pluginRefs: string[];
}

function readManifestFacts(repoRoot: string, harnessDocs: string[]): ManifestFacts {
  const marketplaces = new Map<string, RepoRef>();
  const pluginRepos: RepoRef[] = [];
  const pluginRefs: string[] = [];

  for (const f of harnessDocs.filter((d) => d.endsWith('.json'))) {
    const json = readJson(join(repoRoot, f));
    if (!isRecord(json)) continue;

    const known = json.extraKnownMarketplaces;
    if (isRecord(known)) {
      for (const [name, entry] of Object.entries(known)) {
        const repo = isRecord(entry) ? parseMarketplaceSource(entry.source) : null;
        if (repo) marketplaces.set(name, repo);
      }
    }

    const enabled = json.enabledPlugins;
    if (isRecord(enabled)) pluginRefs.push(...Object.keys(enabled));
    else if (Array.isArray(enabled)) pluginRefs.push(...enabled.filter(isString));

    if (basename(f) === 'marketplace.json' && Array.isArray(json.plugins)) {
      for (const p of json.plugins) {
        const repo = isRecord(p) ? parseMarketplaceSource(p.source) : null;
        if (repo) pluginRepos.push(repo);
      }
    }
  }
  return { marketplaces, pluginRepos, pluginRefs };
}

function extractPluginRefs(text: string): string[] {
  return [...text.matchAll(/(?<![\w.@-])([a-z0-9][\w-]*@[a-z0-9][\w-]*)(?![\w.@-])/gi)].map(
    (m) => m[1]!,
  );
}

const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx']);

/** .mcp.json 서버 정의에서 npx류로 띄우는 패키지 이름을 뽑는다. 버전 핀은 뗀다. */
export function extractMcpPackages(mcpJson: unknown): string[] {
  if (!isRecord(mcpJson)) return [];
  const servers = mcpJson.mcpServers ?? mcpJson.servers;
  if (!isRecord(servers)) return [];
  const out: string[] = [];
  for (const server of Object.values(servers)) {
    if (!isRecord(server) || typeof server.command !== 'string') continue;
    const args = Array.isArray(server.args) ? server.args.filter(isString) : [];
    let rest: string[];
    if (PACKAGE_RUNNERS.has(basename(server.command))) rest = args;
    else if (/^(pnpm|yarn)$/.test(basename(server.command)) && args[0] === 'dlx')
      rest = args.slice(1);
    else continue;
    const spec = rest.find((a) => !a.startsWith('-'));
    if (!spec) continue;
    const name = spec.startsWith('@')
      ? spec.replace(/^(@[^/]+\/[^@]+)@.*$/, '$1')
      : spec.split('@')[0]!;
    if (name) out.push(name);
  }
  return out;
}

export function findForwardMentions(
  repoRoot: string,
  org: string,
  inputs: DetectionInputs = collectDetectionInputs(repoRoot),
  opts: { resolvePackageRepository?: PackageRepositoryResolver } = {},
): RepoRef[] {
  const resolvePkg = opts.resolvePackageRepository ?? defaultPackageRepositoryResolver;
  const found: RepoRef[] = [];
  const texts = inputs.harnessDocs.map((f) => readFileSync(join(repoRoot, f), 'utf-8'));

  for (const text of texts) found.push(...extractRepoMentions(text, org));

  const facts = readManifestFacts(repoRoot, inputs.harnessDocs);
  found.push(...facts.pluginRepos);
  const refs = new Set([...facts.pluginRefs, ...texts.flatMap(extractPluginRefs)]);
  for (const ref of refs) {
    const market = ref.slice(ref.indexOf('@') + 1);
    const repo = facts.marketplaces.get(market);
    if (repo) found.push(repo);
  }

  for (const f of inputs.harnessDocs.filter((d) => basename(d).endsWith('mcp.json'))) {
    for (const pkg of extractMcpPackages(readJson(join(repoRoot, f)))) {
      let repo: RepoRef | null = null;
      try {
        repo = parseRepositoryField(resolvePkg(pkg, repoRoot));
      } catch (e) {
        log(`[harness-review] MCP 패키지 ${pkg}의 repository를 못 읽었다:`, e);
      }
      if (repo) found.push(repo);
    }
  }

  for (const f of inputs.mcpPackageManifests) {
    const json = readJson(join(repoRoot, f));
    const repo = isRecord(json) ? parseRepositoryField(json.repository) : null;
    if (repo) found.push(repo);
  }

  return dedupeRepos(found.filter((r) => r.owner.toLowerCase() === org.toLowerCase()));
}

// ── 병합 ──────────────────────────────────────────────

function repoKey(r: RepoRef): string {
  return `${r.owner}/${r.name}`.toLowerCase();
}

function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return repoKey(a) === repoKey(b);
}

function dedupeRepos(repos: RepoRef[]): RepoRef[] {
  const seen = new Map<string, RepoRef>();
  for (const r of repos) if (!seen.has(repoKey(r))) seen.set(repoKey(r), r);
  return [...seen.values()];
}

function normalizeConfigRepos(entries: ReadonlyArray<string | RepoRef>): RepoRef[] {
  const out: RepoRef[] = [];
  for (const e of entries) {
    const repo = typeof e === 'string' ? parseGitHubRepo(e) : e;
    if (repo?.owner && repo.name) out.push({ owner: repo.owner, name: repo.name });
    else log('[harness-review] 관련 레포 설정 값을 해석하지 못해 건너뛴다:', e);
  }
  return dedupeRepos(out);
}

function resolveDefaultBranch(gh: GhRunner, repo: RepoRef): string {
  try {
    const out = gh([
      'repo',
      'view',
      `${repo.owner}/${repo.name}`,
      '--json',
      'defaultBranchRef',
      '-q',
      '.defaultBranchRef.name',
    ]).trim();
    if (out) return out;
  } catch (e) {
    log(`[harness-review] ${repo.owner}/${repo.name} 기본 브랜치 조회 실패, main으로 둔다:`, e);
  }
  return 'main';
}

function toRelatedRepo(
  repo: RepoRef,
  discoveredBy: RelatedRepo['discoveredBy'],
  gh: GhRunner,
  now: Date,
): RelatedRepo {
  return {
    owner: repo.owner,
    name: repo.name,
    discoveredBy,
    defaultBranch: resolveDefaultBranch(gh, repo),
    lastDetectedAt: now,
  };
}

// 자동 탐지와 설정 양쪽에 있는 레포는 자동 탐지 쪽을 남긴다. 설정은 목록을 늘리기만 한다.
function mergeRepos(
  autoRepos: RelatedRepo[],
  configRepos: RepoRef[],
  self: RepoRef,
  gh: GhRunner,
  now: Date,
  previous: RelatedRepo[] = [],
): RelatedRepo[] {
  const merged = [...autoRepos];
  const keys = new Set(autoRepos.map(repoKey));
  for (const r of configRepos) {
    if (sameRepo(r, self) || keys.has(repoKey(r))) continue;
    keys.add(repoKey(r));
    // 캐시에 이미 있던 설정 레포는 기본 브랜치를 다시 묻지 않는다.
    const known = previous.find((p) => p.discoveredBy === 'config' && sameRepo(p, r));
    merged.push(known ?? toRelatedRepo(r, 'config', gh, now));
  }
  return merged;
}

// ── 캐시 ──────────────────────────────────────────────

export interface StoredDetectionCache extends DetectionCache {
  selfRepo: string;
}

export function isCacheFresh(cache: DetectionCache, harnessDocsHash: string, now: Date): boolean {
  return cache.harnessDocsHash === harnessDocsHash && now.getTime() < cache.expiresAt.getTime();
}

export function readDetectionCache(repoRoot: string): StoredDetectionCache | null {
  const json = readJson(join(repoRoot, DETECTION_CACHE_PATH));
  if (!isRecord(json) || json.version !== CACHE_VERSION) return null;
  if (
    typeof json.selfRepo !== 'string' ||
    typeof json.harnessDocsHash !== 'string' ||
    typeof json.expiresAt !== 'string' ||
    !Array.isArray(json.relatedRepos) ||
    !Array.isArray(json.identifiers)
  ) {
    return null;
  }
  const expiresAt = new Date(json.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) return null;
  return {
    selfRepo: json.selfRepo,
    harnessDocsHash: json.harnessDocsHash,
    expiresAt,
    identifiers: json.identifiers as Identifier[],
    relatedRepos: (json.relatedRepos as Array<Record<string, unknown>>).map((r) => ({
      ...(r as unknown as RelatedRepo),
      lastDetectedAt: typeof r.lastDetectedAt === 'string' ? new Date(r.lastDetectedAt) : null,
    })),
  };
}

export function writeDetectionCache(repoRoot: string, cache: DetectionCache, self: RepoRef): void {
  const abs = join(repoRoot, DETECTION_CACHE_PATH);
  mkdirSync(join(repoRoot, '.gestalt'), { recursive: true });
  const body = { version: CACHE_VERSION, selfRepo: repoKey(self), ...cache };
  writeFileSync(abs, `${JSON.stringify(body, null, 2)}\n`);
}

// ── 공용 ──────────────────────────────────────────────

function readJson(abs: string): unknown {
  try {
    return JSON.parse(readFileSync(abs, 'utf-8'));
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
