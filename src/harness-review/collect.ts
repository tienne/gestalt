/**
 * 참조 후보 수집 오케스트레이터.
 *
 * review 스킬 1단계 뒤에 한 번 돌아 검출기 일곱 개의 결과를 JSON 하나로 묶는다. 판정은 하지 않는다.
 * 검출기 하나가 예외를 던져도 그 검출기만 skipped로 적고 나머지는 끝까지 돈다. 후보 수집이
 * 리뷰를 막으면 안 되기 때문이다(C0). 조회가 막혔거나 원격이 없으면 참조 검사 영역을 리뷰 불가로
 * 표시해 스킬이 사용자에게 물을 수 있게 한다(C7).
 */
import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { runGh, type GhRunner } from '../review-loop/fetch.js';
import {
  backwardSearch,
  type BackwardSearchCoverage,
  type BackwardSearchResult,
  type LlmJudgmentTarget,
} from './backward-search.js';
import { findCopyDrift } from './copy-drift.js';
import { forwardSearch } from './forward-search.js';
import type { BlockReason } from './github-backend.js';
import { GithubCodeSearchAdapter, isOrgWildcard, orgWildcard } from './github-code-search.js';
import { HybridSearchBackend } from './hybrid-search.js';
import { extractIdentifiersFromGit, isHarnessPath, isRuleDocPath } from './identifiers.js';
import {
  defaultCloneRoot,
  prepareRelatedClones,
  pruneWorktreeClones,
  worktreeCloneRoot,
  type CloneGitRunner,
  type CloneTarget,
} from './related-clones.js';
import { detectRelatedRepos, readOriginRepo } from './related-repos.js';
import { findRuleIdListGapsFromGit } from './rule-id-lists.js';
import { findRuleOverlapFromGit } from './rule-overlap.js';
import { LocalCloneBackend, type CodeSearchBackend, type SkippedRepo } from './search-backend.js';
import { findSelfContamination } from './self-contamination.js';
import { findSelfReferences } from './self-references.js';
import {
  REFERENCE_CANDIDATE_KINDS,
  type Identifier,
  type ReferenceCandidate,
  type ReferenceCandidateKind,
  type SearchBackendKind,
} from './types.js';

export const COLLECT_BACKENDS = ['local', 'github'] as const;

export type CollectBackend = (typeof COLLECT_BACKENDS)[number];

export const DETECTOR_NAMES = [
  'relatedRepos',
  'identifiers',
  'selfContamination',
  'copyDrift',
  'ruleIdListGap',
  'ruleOverlap',
  'forwardSearch',
  'backwardSearch',
  'selfReferences',
] as const;

export type DetectorName = (typeof DETECTOR_NAMES)[number];

export interface DetectorStatus {
  status: 'ok' | 'skipped';
  reason?: string;
}

export interface LookupBlockedEntry {
  source: 'forwardSearch' | 'backwardSearch';
  reason: Exclude<BlockReason, 'noGitHubRemote'>;
  detail: string;
}

export interface RepoDir {
  /** owner/name */
  repo: string;
  dir: string;
}

export interface CollectOptions {
  repoRoot: string;
  base: string;
  head: string;
  backend: CollectBackend;
  /** 관련 레포의 로컬 clone. `경로` 또는 `owner/name=경로` 꼴 */
  repoDirs?: string[];
  /** gestalt.json relatedRepos. 자동 탐지 결과에 더하기만 한다 */
  extraRepos?: string[];
  /** 테스트에서 가짜로 바꾼다. 기본은 실제 gh */
  gh?: GhRunner;
  now?: Date;
  /** 관련 레포 탐지 캐시를 무시한다 */
  refresh?: boolean;
  codeGraphDbPath?: string;
  /** github 백엔드가 관련 레포를 받아 두는 자리. 기본은 `~/.gestalt/repos`이고 그 아래 워크트리마다 나뉜다 */
  cloneRoot?: string;
  /** 테스트에서 클론 준비의 git 호출을 바꾼다 */
  cloneGit?: CloneGitRunner;
  /** 테스트에서 코드 검색 한도 대기를 실제로 자지 않게 바꾼다 */
  sleep?: (ms: number) => Promise<void>;
}

export interface CollectResult {
  version: 1;
  base: string;
  head: string;
  /** 리뷰 중인 레포. 원격이 없으면 디렉토리 이름만 있다 */
  repo: string;
  org: string | null;
  backendUsed: SearchBackendKind;
  relatedRepos: string[];
  /** 역방향 검색에 실제로 넘긴 레포. 조직 전체를 찾을 땐 `owner/*`가 들어 있다 */
  searchedRepos: string[];
  identifiers: Identifier[];
  candidates: Record<ReferenceCandidateKind, ReferenceCandidate[]>;
  counts: Record<ReferenceCandidateKind, number>;
  /** 패턴으로 검색어를 못 만든 식별자. harness-reviewer가 파일을 읽고 판정한다 */
  needsLlmJudgment: LlmJudgmentTarget[];
  /** gh 조회가 막힌 자리. 원격 없음은 noGitHubRemote로 따로 싣는다 */
  lookupBlocked: LookupBlockedEntry[];
  noGitHubRemote: boolean;
  /**
   * 레포 간 참조 검사를 전부 또는 일부 못 봤다. true면 스킬이 "참조 검사만 비워둔 채 진행"과
   * "기다림" 중 하나를 사용자에게 묻는다. 후보가 0건이어도 이 값이 true면 참조 없음으로 읽지 않는다
   */
  referenceCheckSkipped: boolean;
  skippedRepos: SkippedRepo[];
  /** 역방향 검색이 질의를 몇 개 계획했고 몇 개를 봤는지. 검색을 안 돌렸으면 null */
  backwardSearchCoverage: BackwardSearchCoverage | null;
  detectors: Record<DetectorName, DetectorStatus>;
  limitations: string[];
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const REPO_SLUG_RE = /^[^/\s=]+\/[^/\s=]+$/;

/** `--repo-dir` 값을 레포 표기와 디렉토리로 푼다. 표기를 안 주면 clone의 origin에서 읽는다 */
export function parseRepoDirs(raw: string[], org: string | null): RepoDir[] {
  const out: RepoDir[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const eq = entry.indexOf('=');
    const left = eq > 0 ? entry.slice(0, eq) : '';
    let repo: string;
    let dir: string;
    if (REPO_SLUG_RE.test(left)) {
      repo = left;
      dir = resolve(entry.slice(eq + 1));
    } else {
      dir = resolve(entry);
      const origin = readOriginRepo(dir);
      repo = origin
        ? `${origin.owner}/${origin.name}`
        : org
          ? `${org}/${basename(dir)}`
          : basename(dir);
    }
    if (seen.has(repo)) continue;
    seen.add(repo);
    out.push({ repo, dir });
  }
  return out;
}

function emptyCandidates(): Record<ReferenceCandidateKind, ReferenceCandidate[]> {
  return Object.fromEntries(REFERENCE_CANDIDATE_KINDS.map((k) => [k, []])) as unknown as Record<
    ReferenceCandidateKind,
    ReferenceCandidate[]
  >;
}

/**
 * base와 head 사이 변경에서 diff 밖 검사 후보를 모은다. 리뷰를 막지 않으려고 어떤 경우에도
 * 예외를 던지지 않고 결과를 돌려준다. 워킹트리는 head가 체크아웃된 상태라고 본다.
 */
export async function collectReferenceCandidates(opts: CollectOptions): Promise<CollectResult> {
  const repoRoot = resolve(opts.repoRoot);
  const gh = opts.gh ?? runGh;
  const limitations: string[] = [];
  const detectors = {} as Record<DetectorName, DetectorStatus>;
  const candidates = emptyCandidates();
  const lookupBlocked: LookupBlockedEntry[] = [];
  const skippedRepos: SkippedRepo[] = [];

  const skip = (name: DetectorName, reason: string) => {
    detectors[name] = { status: 'skipped', reason };
    limitations.push(`${name} 검출기를 건너뛰었다: ${reason}`);
  };
  const run = <T>(name: DetectorName, body: () => T): T | undefined => {
    try {
      const value = body();
      detectors[name] = { status: 'ok' };
      return value;
    } catch (e) {
      skip(name, errorMessage(e));
      return undefined;
    }
  };
  const addCandidates = (list: ReferenceCandidate[]) => {
    for (const c of list) candidates[c.kind].push(c);
  };
  const noteBlocked = (
    source: LookupBlockedEntry['source'],
    blocked: { reason: BlockReason; detail: string } | null | undefined,
  ) => {
    if (!blocked || blocked.reason === 'noGitHubRemote') return;
    lookupBlocked.push({ source, reason: blocked.reason, detail: blocked.detail });
  };

  // ── 관련 레포 ──────────────────────────────────────
  const detection = run('relatedRepos', () =>
    detectRelatedRepos(repoRoot, {
      extraRepos: opts.extraRepos ?? [],
      gh: (args) => gh(args),
      now: opts.now,
      refresh: opts.refresh,
    }),
  );
  const noGitHubRemote = detection?.noGitHubRemote === true;
  const found = detection && !detection.noGitHubRemote ? detection : undefined;
  if (detection?.noGitHubRemote) limitations.push(detection.reason);
  const org = found?.org ?? null;
  const repo = found ? `${found.self.owner}/${found.self.name}` : basename(repoRoot);
  const relatedRepos = found?.relatedRepos.map((r) => `${r.owner}/${r.name}`) ?? [];

  const repoDirs = parseRepoDirs(opts.repoDirs ?? [], org).filter((d) => d.repo !== repo);

  try {
    const headSha = git(repoRoot, ['rev-parse', opts.head]).trim();
    const worktreeHead = git(repoRoot, ['rev-parse', 'HEAD']).trim();
    if (worktreeHead !== headSha) {
      limitations.push(
        '워킹트리가 head 커밋이 아니다. 자기오염과 순방향 검사는 워킹트리 파일을 읽으므로 결과가 head와 어긋날 수 있다',
      );
    }
  } catch {
    // ref를 못 읽으면 아래 검출기들이 같은 원인으로 각자 skipped를 남긴다
  }

  // ── 레포 안 검출기 ────────────────────────────────
  const identifiers =
    run('identifiers', () => extractIdentifiersFromGit(repoRoot, opts.base, opts.head)) ?? [];

  run('selfContamination', () => {
    const diff = git(repoRoot, ['diff', '--no-color', opts.base, opts.head]);
    addCandidates(findSelfContamination({ repoRoot, diff, repoName: repo }));
  });

  run('copyDrift', () => {
    const drift = findCopyDrift({
      repoRoot,
      base: opts.base,
      head: opts.head,
      repo,
      codeGraphDbPath: opts.codeGraphDbPath,
    });
    addCandidates(drift.candidates);
    limitations.push(...drift.limitations);
  });

  run('ruleIdListGap', () => {
    addCandidates(findRuleIdListGapsFromGit(repoRoot, opts.base, opts.head, repo));
  });

  run('ruleOverlap', () => {
    addCandidates(findRuleOverlapFromGit(repoRoot, opts.base, opts.head, repo));
  });

  // 역방향 검색은 관련 레포만 본다. 같은 레포 안에 남은 옛 이름은 여기서 찾는다
  run('selfReferences', () => {
    addCandidates(
      findSelfReferences({ repoRoot, base: opts.base, head: opts.head, repo, identifiers }),
    );
  });

  // ── 순방향 ────────────────────────────────────────
  run('forwardSearch', () => {
    const changed = git(repoRoot, ['diff', '--name-only', '--diff-filter=d', opts.base, opts.head])
      .split('\n')
      .filter((p) => p !== '' && (isHarnessPath(p) || isRuleDocPath(p)));
    const forward = forwardSearch({
      ownRepo: { repo, dir: repoRoot },
      otherRepos: repoDirs,
      files: changed,
      gh,
    });
    addCandidates(forward.candidates);
    limitations.push(...forward.limitations);
    noteBlocked('forwardSearch', forward.blocked);
  });
  if (repoDirs.length === 0) {
    limitations.push(
      '다른 레포 경로와 자리표시자는 --repo-dir로 받은 로컬 clone에서만 확인한다. 받은 clone이 없어 자기 레포만 봤다',
    );
  }

  // ── 역방향 ────────────────────────────────────────
  const backendUsed: SearchBackendKind = opts.backend === 'github' ? 'githubSearch' : 'localClone';
  let searchedRepos: string[] = [];
  let backward: BackwardSearchResult | undefined;
  let adapter: GithubCodeSearchAdapter | undefined;

  if (detectors.identifiers.status === 'skipped') {
    skip('backwardSearch', '식별자를 뽑지 못했다');
  } else if (opts.backend === 'github' && org === null) {
    skip('backwardSearch', 'GitHub 원격이 없어 검색할 조직을 모른다');
  } else {
    let backend: CodeSearchBackend;
    if (opts.backend === 'github' && found && org !== null) {
      adapter = new GithubCodeSearchAdapter({ owner: org, selfRepo: repo, gh, sleep: opts.sleep });
      // 관련 레포는 로컬 클론에서 찾고 GitHub 코드 검색(분당 10회)은 클론으로 못 덮는 자리에만 쓴다
      const cloneBase = opts.cloneRoot ?? defaultCloneRoot();
      // 이 워크트리의 쓴 시각을 먼저 갱신한다. 정리를 먼저 돌리면 오래 묵은 자기 클론을 지우고
      // 바로 다시 받는다
      const cloneRoot = worktreeCloneRoot(cloneBase, repoRoot);
      pruneWorktreeClones(cloneBase, { now: opts.now });
      const clones = prepareRelatedClones({
        targets: cloneTargets(found.relatedRepos, repoDirs, repo),
        cloneRoot,
        gh,
        git: opts.cloneGit,
        now: opts.now,
      });
      limitations.push(...clones.limitations);
      backend = new HybridSearchBackend({
        local: new LocalCloneBackend(clones.sources),
        localRepos: clones.sources.map((s) => s.repo),
        github: adapter,
        owner: org,
      });
      searchedRepos = [
        ...new Set([...relatedRepos, ...repoDirs.map((d) => d.repo)]),
        orgWildcard(org),
      ];
      limitations.push(...adapter.limitations);
    } else {
      backend = new LocalCloneBackend(repoDirs);
      searchedRepos = [...new Set([...relatedRepos, ...repoDirs.map((d) => d.repo)])];
      if (searchedRepos.length === 0) {
        limitations.push(
          '로컬 백엔드는 조직 전체를 못 찾는다. 관련 레포도 --repo-dir도 없어 역방향 검색 대상이 비었다',
        );
      }
    }
    searchedRepos = searchedRepos.filter((r) => r !== repo);
    try {
      backward = await backwardSearch({
        identifiers,
        repos: searchedRepos,
        backend,
        selfRepo: repo,
      });
      detectors.backwardSearch = { status: 'ok' };
    } catch (e) {
      skip('backwardSearch', errorMessage(e));
    }
    const scopedRepos = searchedRepos.filter((r) => !isOrgWildcard(r));
    if (backward && onlyOrgWideRateLimited(adapter?.blocked, backward.skipped, scopedRepos)) {
      // 관련 레포는 전부 찾았고 한도 때문에 조직 전체 검색만 덜 봤다. 막힘으로 올리면 이름이 수십 개인
      // PR은 라운드마다 막힌다. 대신 얼마나 봤는지를 남겨 리포트가 그대로 보이게 한다
      const ow = backward.coverage.orgWide;
      limitations.push(
        `조직 전체 검색은 질의 ${ow?.searched ?? 0}/${ow?.planned ?? 0}개만 봤다. 관련 레포는 전부 찾았다 (${adapter!.blocked!.detail})`,
      );
      backward.skipped = [];
    } else {
      noteBlocked('backwardSearch', adapter?.blocked);
    }
  }

  if (backward) {
    addCandidates(backward.backwardRefs);
    addCandidates(backward.knowledgeDocs);
    skippedRepos.push(...backward.skipped);
    for (const s of backward.skippedIdentifiers) {
      limitations.push(`식별자 ${s.identifier.value}: ${s.reason}`);
    }
  }

  const crossRepoSkipped = (['relatedRepos', 'forwardSearch', 'backwardSearch'] as const).some(
    (name) => detectors[name]?.status === 'skipped',
  );
  const counts = Object.fromEntries(
    REFERENCE_CANDIDATE_KINDS.map((k) => [k, candidates[k].length]),
  ) as Record<ReferenceCandidateKind, number>;

  return {
    version: 1,
    base: opts.base,
    head: opts.head,
    repo,
    org,
    backendUsed,
    relatedRepos,
    searchedRepos,
    identifiers,
    candidates,
    counts,
    needsLlmJudgment: backward?.needsLlmJudgment ?? [],
    lookupBlocked,
    noGitHubRemote,
    referenceCheckSkipped:
      noGitHubRemote || lookupBlocked.length > 0 || skippedRepos.length > 0 || crossRepoSkipped,
    skippedRepos,
    backwardSearchCoverage: backward?.coverage ?? null,
    detectors,
    limitations,
  };
}

/** 관련 레포와 `--repo-dir` 레포를 클론 대상으로 합친다. 같은 레포면 사람이 준 클론을 쓴다 */
function cloneTargets(
  related: { owner: string; name: string; defaultBranch?: string }[],
  repoDirs: RepoDir[],
  self: string,
): CloneTarget[] {
  const byKey = new Map<string, CloneTarget>();
  for (const r of related) {
    const key = `${r.owner}/${r.name}`.toLowerCase();
    byKey.set(key, { repo: `${r.owner}/${r.name}`, defaultBranch: r.defaultBranch });
  }
  for (const d of repoDirs) {
    const key = d.repo.toLowerCase();
    const prev = byKey.get(key);
    byKey.set(key, { ...(prev ?? { repo: d.repo }), userDir: d.dir });
  }
  byKey.delete(self.toLowerCase());
  return [...byKey.values()];
}

/**
 * 한도 때문에 조직 와일드카드만 덜 봤는지. 관련 레포가 하나도 없으면 와일드카드가 검색의 전부라
 * 여기에 안 든다. 받기만 하는 레포는 그 검색으로만 자기를 부르는 레포를 찾는다
 */
function onlyOrgWideRateLimited(
  blocked: { reason: BlockReason } | null | undefined,
  skipped: SkippedRepo[],
  scopedRepos: string[],
): boolean {
  return (
    blocked?.reason === 'rateLimited' &&
    scopedRepos.length > 0 &&
    skipped.length > 0 &&
    skipped.every((s) => isOrgWildcard(s.repo))
  );
}
