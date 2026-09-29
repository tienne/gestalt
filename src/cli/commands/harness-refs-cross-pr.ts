import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../../core/config.js';
import { parseRepoDirs } from '../../harness-review/collect.js';
import {
  buildFollowUpMarker,
  matchFollowUp,
  parseFollowUpMarkers,
  isFulfilled,
  type FollowUpMatch,
} from '../../harness-review/follow-up-marker.js';
import { classifyGhFailure } from '../../harness-review/github-backend.js';
import {
  MERGED_LOOKBACK_DAYS,
  RELATED_PR_MODES,
  confirmedRelatedPrs,
  findRelatedPrs,
  type CurrentPr,
  type FindRelatedPrsResult,
  type ReferenceTarget,
  type RelatedPrMode,
  type RelatedPrSkip,
} from '../../harness-review/related-pr.js';
import { readOriginRepo } from '../../harness-review/related-repos.js';
import {
  judgeThreeState,
  type GitRunner,
  type ThreeStateJudgment,
} from '../../harness-review/three-state.js';
import {
  CHANGE_TYPES,
  CONFIRMATION_TYPES,
  FOUND_BY_TYPES,
  IDENTIFIER_KINDS,
  PR_STATES,
  type ConfirmationType,
  type FollowUpMarker,
  type FoundByType,
  type Identifier,
  type PrState,
  type RelatedPR,
} from '../../harness-review/types.js';
import { runGh, type GhRunner } from '../../review-loop/fetch.js';
import { parseTarget } from '../../review-loop/target.js';

/**
 * `gestalt harness-refs related-prs | three-state | followup build | followup find | followup check`.
 *
 * ship, review-loop, review 스킬이 셸에서 부른다. --json이면 stdout에는 JSON 한 줄만 나간다.
 * 인자나 입력 파일이 틀렸을 때만 stdout을 비우고 1로 끝난다. gh 조회가 막힌 건 결과의
 * status 'blocked'로 싣고 0으로 끝난다. 막힘이 빈 결과로 읽히면 "연관 PR 없음"이나
 * "문제 없음"으로 넘어가기 때문이다.
 *
 * 연관 PR 본문과 코멘트는 링크, 티켓 키, 마커를 뽑는 데만 쓰고 출력에 옮겨 적지 않는다.
 */

export interface CrossPrDeps {
  gh?: GhRunner;
  runGit?: GitRunner;
  cwd?: string;
  now?: Date;
  /** gestalt.json relatedRepos. 테스트에서 바꾼다 */
  configRepos?: () => string[];
}

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;
// gh 응답에서 온 브랜치 이름을 git 인자로 넘긴다. 옵션처럼 읽히는 값과 상위 경로를 막는다
const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
const GH_BLOCK_REASONS = new Set(['notLoggedIn', 'noPermission', 'rateLimited']);
const DAY_MS = 24 * 60 * 60 * 1000;

/** 세 상태 판정 쌍 상한. 식별자와 레포 곱이 커져도 git 호출 수가 묶인다 */
export const MAX_THREE_STATE_PAIRS = 100;
/** 후속 마커를 찾으려고 레포마다 훑는 머지된 PR 상한 */
export const MAX_FOLLOWUP_PRS_PER_REPO = 30;

export type CrossPrStatus = 'blocked' | 'found' | 'none';

const defaultRunGit: GitRunner = (dir, args) => {
  const r = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status ?? 1, stdout: r.stdout };
};

function configRelatedRepos(deps: CrossPrDeps): string[] {
  if (deps.configRepos) return deps.configRepos();
  try {
    return loadConfig({}, { skipDotEnv: true }).relatedRepos;
  } catch (e) {
    // 설정이 깨져도 다른 입력으로 돈다. 빠진 레포는 stderr로만 알린다
    console.error('[gestalt] gestalt.json의 relatedRepos를 읽지 못했다:', e);
    return [];
  }
}

function assertRepo(value: string, label: string): string {
  if (!REPO_RE.test(value)) throw new Error(`${label}는 owner/name 꼴이어야 한다: ${value}`);
  return value;
}

function uniqueRepos(repos: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const r of repos) if (!seen.has(r.toLowerCase())) seen.set(r.toLowerCase(), r);
  return [...seen.values()];
}

function readTextFile(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch (e) {
    throw new Error(`${label} 파일을 못 읽었다: ${path}`, { cause: e });
  }
}

function readJsonFile(path: string, label: string): unknown {
  const text = readTextFile(path, label);
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(`${label} 파일이 JSON이 아니다: ${path}`, { cause: e });
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function ghFailure(e: unknown): { reason: string; detail: string } {
  const { stderr, message } = (isRecord(e) ? e : {}) as { stderr?: unknown; message?: unknown };
  const detail = [stderr, message]
    .filter((v) => v !== undefined && v !== null)
    .map(String)
    .join('\n')
    .trim();
  return { reason: classifyGhFailure(detail) ?? 'unknown', detail: detail || String(e) };
}

/** collect 결과 JSON에서 이 CLI가 쓰는 부분만 읽는다 */
interface CollectInput {
  repo: string;
  relatedRepos: string[];
  identifiers: Identifier[];
  candidates: Record<string, unknown[]>;
}

function readCollectResult(path: string): CollectInput {
  const raw = readJsonFile(path, '--candidates');
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.candidates)) {
    throw new Error(`--candidates는 harness-refs collect --json 결과여야 한다: ${path}`);
  }
  const candidates: Record<string, unknown[]> = {};
  for (const [k, v] of Object.entries(raw.candidates)) if (Array.isArray(v)) candidates[k] = v;
  return {
    repo: typeof raw.repo === 'string' ? raw.repo : '',
    relatedRepos: Array.isArray(raw.relatedRepos)
      ? raw.relatedRepos.filter((r): r is string => typeof r === 'string' && REPO_RE.test(r))
      : [],
    identifiers: Array.isArray(raw.identifiers)
      ? raw.identifiers.flatMap((i) => {
          const id = toIdentifier(i);
          return id ? [id] : [];
        })
      : [],
    candidates,
  };
}

function toIdentifier(raw: unknown): Identifier | null {
  if (!isRecord(raw)) return null;
  const { kind, value, changeType, extractedBy } = raw;
  if (typeof kind !== 'string' || !(IDENTIFIER_KINDS as readonly string[]).includes(kind))
    return null;
  if (typeof value !== 'string' || value === '') return null;
  return {
    kind: kind as Identifier['kind'],
    value,
    changeType: (CHANGE_TYPES as readonly unknown[]).includes(changeType)
      ? (changeType as Identifier['changeType'])
      : 'modified',
    extractedBy: (extractedBy === 'llm' ? 'llm' : 'pattern') as Identifier['extractedBy'],
  };
}

// 다른 레포에 있는 참조 대상. 역방향 검색 결과의 repo와 path를 그대로 쓴다
function referenceTargetsOf(collect: CollectInput, selfRepo: string): ReferenceTarget[] {
  const out: ReferenceTarget[] = [];
  const seen = new Set<string>();
  for (const list of Object.values(collect.candidates)) {
    for (const c of list) {
      if (!isRecord(c) || typeof c.targetRepo !== 'string' || typeof c.targetPath !== 'string')
        continue;
      if (c.targetPath === '' || c.targetRepo.toLowerCase() === selfRepo.toLowerCase()) continue;
      if (!REPO_RE.test(c.targetRepo)) continue;
      const key = `${c.targetRepo.toLowerCase()}\0${c.targetPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ repo: c.targetRepo, path: c.targetPath });
    }
  }
  return out;
}

function resolveCurrentRepo(
  explicit: string | undefined,
  fromTarget: string | undefined,
  cwd: string,
  fallback?: string,
): string {
  if (fromTarget && explicit && fromTarget.toLowerCase() !== explicit.toLowerCase()) {
    throw new Error(`--pr URL의 레포(${fromTarget})와 --repo(${explicit})가 다르다`);
  }
  const chosen = fromTarget ?? explicit;
  if (chosen) return assertRepo(chosen, '--repo');
  if (fallback && REPO_RE.test(fallback)) return fallback;
  const origin = readOriginRepo(cwd);
  if (origin) return `${origin.owner}/${origin.name}`;
  throw new Error('이번 PR의 레포를 못 정했다. --repo owner/name을 준다');
}

function parsePr(value: string | undefined): { number?: number; repo?: string } {
  if (value === undefined) return {};
  const t = parseTarget(value);
  return { number: t.prNumber, repo: t.owner && t.repo ? `${t.owner}/${t.repo}` : undefined };
}

// ─── related-prs ────────────────────────────────────────────────────────────

export interface RelatedPrsCliOptions {
  mode: string;
  pr?: string;
  repo?: string;
  candidates?: string;
  relatedRepo?: string[];
  branch?: string;
  author?: string;
  title?: string;
  bodyFile?: string;
  json?: boolean;
}

export interface RelatedPrsCliResult extends FindRelatedPrsResult {
  version: 1;
  status: CrossPrStatus;
  current: { repo: string; number: number | null; branch: string; author: string };
  relatedRepos: string[];
  confirmed: RelatedPR[];
  /** 답을 받기 전엔 판정 근거로 못 쓰는 후보. 있으면 approve-gate에 relatedPrUnconfirmed를 넘긴다 */
  unconfirmed: { repo: string; number: number; confirmation: ConfirmationType }[];
  relatedPrUnconfirmed: boolean;
  /** gh 조회가 막혀 일부 단계를 못 봤다. 후보가 0건이어도 연관 PR 없음으로 읽지 않는다 */
  lookupBlocked: boolean;
  limitations: string[];
}

export function runRelatedPrs(
  opts: RelatedPrsCliOptions,
  deps: CrossPrDeps = {},
): RelatedPrsCliResult {
  if (!(RELATED_PR_MODES as readonly string[]).includes(opts.mode)) {
    throw new Error(`--mode는 ${RELATED_PR_MODES.join('|')} 중 하나다: ${opts.mode}`);
  }
  const mode = opts.mode as RelatedPrMode;
  const gh = deps.gh ?? runGh;
  const cwd = deps.cwd ?? process.cwd();
  const pr = parsePr(opts.pr);
  const collect = opts.candidates ? readCollectResult(opts.candidates) : null;
  const extra = (opts.relatedRepo ?? []).map((r) => assertRepo(r, '--related-repo'));
  const body = opts.bodyFile ? readTextFile(opts.bodyFile, '--body-file') : undefined;
  const repo = resolveCurrentRepo(opts.repo, pr.repo, cwd, collect?.repo);

  const relatedRepos = uniqueRepos([
    ...(collect?.relatedRepos ?? []),
    ...configRelatedRepos(deps),
    ...extra,
  ]).filter((r) => r.toLowerCase() !== repo.toLowerCase());
  const limitations: string[] = [];

  const blockedResult = (reason: string, detail: string): RelatedPrsCliResult => ({
    version: 1,
    mode,
    status: 'blocked',
    current: {
      repo,
      number: pr.number ?? null,
      branch: opts.branch ?? '',
      author: opts.author ?? '',
    },
    relatedRepos,
    candidates: [],
    skipped: [
      {
        step: 'bodyLink',
        repo,
        number: pr.number,
        reason: reason as RelatedPrSkip['reason'],
        detail,
      },
    ],
    notices: [],
    suggestBodyLink: false,
    ticketKeys: [],
    confirmed: [],
    unconfirmed: [],
    relatedPrUnconfirmed: false,
    lookupBlocked: true,
    limitations: ['이번 PR 정보를 못 읽어 연관 PR 탐색을 시작하지 못했다'],
  });

  let current: CurrentPr;
  if (pr.number !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(
        gh([
          'pr',
          'view',
          String(pr.number),
          '--repo',
          repo,
          '--json',
          'number,title,body,author,headRefName,createdAt',
        ]),
      );
    } catch (e) {
      const f = ghFailure(e);
      return blockedResult(f.reason, f.detail);
    }
    if (!isRecord(raw)) return blockedResult('unparsable', 'gh pr view 응답 형식이 다르다');
    current = {
      repo,
      number: pr.number,
      title: typeof raw.title === 'string' ? raw.title : '',
      body: body ?? (typeof raw.body === 'string' ? raw.body : ''),
      author:
        opts.author ??
        (isRecord(raw.author) && typeof raw.author.login === 'string' ? raw.author.login : ''),
      branch: opts.branch ?? (typeof raw.headRefName === 'string' ? raw.headRefName : ''),
      ...(typeof raw.createdAt === 'string' ? { createdAt: raw.createdAt } : {}),
    };
  } else {
    // ship은 GitHub PR이 아직 없다. 브랜치와 작성자를 로컬에서 채운다
    let author = opts.author;
    if (author === undefined) {
      try {
        author = gh(['api', 'user', '--jq', '.login']).trim();
      } catch {
        author = '';
        limitations.push(
          'gh 로그인을 못 읽어 같은 작성자 단계를 건너뛰었다. --author로 줄 수 있다',
        );
      }
    }
    current = {
      repo,
      title: opts.title ?? '',
      body: body ?? '',
      author,
      branch: opts.branch ?? currentBranch(cwd),
    };
  }

  const result = findRelatedPrs({
    current,
    mode,
    relatedRepos,
    referenceTargets: collect ? referenceTargetsOf(collect, repo) : [],
    gh,
    now: deps.now,
  });

  const lookupBlocked = result.skipped.some((s) => GH_BLOCK_REASONS.has(s.reason));
  const incomplete = result.skipped.some((s) => s.reason !== 'outsideRelatedRepos');
  if (incomplete && !lookupBlocked) limitations.push('일부 조회가 실패해 후보가 빠졌을 수 있다');
  if (relatedRepos.length === 0) limitations.push('관련 레포가 없어 본문 링크 밖은 찾지 않았다');

  const unconfirmed = result.candidates
    .filter((c) => c.confirmation !== 'confirmed')
    .map((c) => ({ repo: c.repo, number: c.number, confirmation: c.confirmation }));

  return {
    version: 1,
    ...result,
    status: lookupBlocked ? 'blocked' : result.candidates.length > 0 ? 'found' : 'none',
    current: {
      repo,
      number: current.number ?? null,
      branch: current.branch,
      author: current.author,
    },
    relatedRepos,
    confirmed: confirmedRelatedPrs(result.candidates).map(toRelatedPr),
    unconfirmed,
    relatedPrUnconfirmed: unconfirmed.length > 0,
    lookupBlocked,
    limitations,
  };
}

function toRelatedPr(c: RelatedPR): RelatedPR {
  return {
    repo: c.repo,
    number: c.number,
    headSha: c.headSha,
    state: c.state,
    ...(c.mergedBranch ? { mergedBranch: c.mergedBranch } : {}),
    foundBy: c.foundBy,
    confirmation: c.confirmation,
  };
}

function currentBranch(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

// ─── three-state ────────────────────────────────────────────────────────────

export interface ThreeStateCliOptions {
  candidates: string;
  relatedPrs: string;
  repo?: string;
  repoDir?: string[];
  defaultBranch?: string[];
  confirm?: string[];
  json?: boolean;
}

export type ThreeStateStatus = 'ok' | 'mergeOrder' | 'defect' | 'relatedRemovesUsed' | 'blocked';

export interface ThreeStateCliJudgment extends ThreeStateJudgment {
  /** blocked는 상태를 못 봤다는 뜻이다. 막힘이고 재확인이 필요하다 */
  status: ThreeStateStatus;
}

export interface ThreeStateFetch {
  repo: string;
  ref: string;
  ok: boolean;
  detail?: string;
}

export interface ThreeStateCliResult {
  version: 1;
  currentRepo: string;
  judgments: ThreeStateCliJudgment[];
  counts: Record<ThreeStateStatus, number>;
  /** 못 본 판정이 있거나 연관 PR 조회가 막혔다. 참조 문제 없음으로 읽지 않는다 */
  needsRecheck: boolean;
  /** 확정 안 된 연관 PR이 있다. approve-gate --issue relatedPrUnconfirmed로 넘긴다 */
  relatedPrUnconfirmed: boolean;
  unconfirmedRelatedPrs: { repo: string; number: number }[];
  /** 재리뷰가 같은 기준으로 다시 보도록 판정에 쓴 연관 PR head */
  relatedPrHeads: { repo: string; number: number; state: PrState; headSha: string }[];
  relatedPrLookupBlocked: boolean;
  fetches: ThreeStateFetch[];
  limitations: string[];
}

interface RelatedPrsInput {
  prs: RelatedPR[];
  lookupBlocked: boolean;
  invalid: number;
}

function readRelatedPrs(path: string): RelatedPrsInput {
  const raw = readJsonFile(path, '--related-prs');
  if (!isRecord(raw) || !Array.isArray(raw.candidates)) {
    throw new Error(`--related-prs는 harness-refs related-prs --json 결과여야 한다: ${path}`);
  }
  let invalid = 0;
  const prs = raw.candidates.flatMap((c): RelatedPR[] => {
    const pr = toRelatedPrInput(c);
    if (!pr) invalid++;
    return pr ? [pr] : [];
  });
  return { prs, lookupBlocked: raw.lookupBlocked === true || raw.status === 'blocked', invalid };
}

function toRelatedPrInput(c: unknown): RelatedPR | null {
  if (!isRecord(c)) return null;
  const { repo, number, headSha, state, mergedBranch, foundBy, confirmation } = c;
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) return null;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return null;
  if (typeof headSha !== 'string' || !SHA_RE.test(headSha)) return null;
  if (typeof state !== 'string' || !(PR_STATES as readonly string[]).includes(state)) return null;
  if (typeof foundBy !== 'string' || !(FOUND_BY_TYPES as readonly string[]).includes(foundBy))
    return null;
  if (
    typeof confirmation !== 'string' ||
    !(CONFIRMATION_TYPES as readonly string[]).includes(confirmation)
  )
    return null;
  if (
    mergedBranch !== undefined &&
    (typeof mergedBranch !== 'string' || !BRANCH_RE.test(mergedBranch))
  )
    return null;
  return {
    repo,
    number,
    headSha,
    state: state as PrState,
    ...(mergedBranch ? { mergedBranch } : {}),
    foundBy: foundBy as FoundByType,
    confirmation: confirmation as ConfirmationType,
  };
}

function parseConfirm(values: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+)#(\d+)$/.exec(v);
    if (!m) throw new Error(`--confirm은 owner/name#번호 꼴이어야 한다: ${v}`);
    out.add(`${m[1]!.toLowerCase()}#${Number(m[2]!)}`);
  }
  return out;
}

function parseDefaultBranches(values: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of values) {
    const eq = v.indexOf('=');
    const repo = eq > 0 ? v.slice(0, eq) : '';
    const branch = v.slice(eq + 1);
    if (!REPO_RE.test(repo) || !BRANCH_RE.test(branch)) {
      throw new Error(`--default-branch는 owner/name=브랜치 꼴이어야 한다: ${v}`);
    }
    out.set(repo.toLowerCase(), branch);
  }
  return out;
}

interface Pair {
  identifier: Identifier;
  targetRepo: string;
}

// 판정할 (식별자, 대상 레포) 쌍. 역방향 참조, 다른 레포 경로를 가리키는 순방향 참조,
// 그리고 연관 PR이 있는 레포마다 이번 PR의 식별자를 짝지은 쌍 순이다
function threeStatePairs(
  collect: CollectInput,
  selfRepo: string,
  reposWithPrs: readonly string[],
): Pair[] {
  const pairs: Pair[] = [];
  const seen = new Set<string>();
  const add = (identifier: Identifier, targetRepo: string) => {
    if (targetRepo.toLowerCase() === selfRepo.toLowerCase() || !REPO_RE.test(targetRepo)) return;
    const key = `${targetRepo.toLowerCase()}\0${identifier.kind}\0${identifier.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ identifier, targetRepo });
  };
  for (const c of collect.candidates.backwardRef ?? []) {
    if (!isRecord(c) || typeof c.targetRepo !== 'string') continue;
    const id = toIdentifier(c.identifier);
    if (id) add(id, c.targetRepo);
  }
  for (const c of collect.candidates.forwardRef ?? []) {
    if (!isRecord(c) || typeof c.targetRepo !== 'string' || typeof c.targetPath !== 'string')
      continue;
    if (c.targetPath === '') continue;
    add(
      { kind: 'path', value: c.targetPath, changeType: 'modified', extractedBy: 'pattern' },
      c.targetRepo,
    );
  }
  for (const repo of reposWithPrs) {
    for (const id of collect.identifiers) if (id.extractedBy !== 'llm') add(id, repo);
  }
  return pairs;
}

function detectDefaultBranch(dir: string, runGit: GitRunner): string {
  const r = runGit(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const ref = r.status === 0 ? r.stdout.trim() : '';
  const branch = ref.startsWith('origin/') ? ref.slice('origin/'.length) : '';
  return BRANCH_RE.test(branch) ? branch : 'main';
}

function hasCommit(dir: string, sha: string, runGit: GitRunner): boolean {
  return runGit(dir, ['cat-file', '-e', `${sha}^{commit}`]).status === 0;
}

// judgeThreeState는 fetch를 안 한다. 기본 브랜치, 머지된 브랜치, 연관 PR head를 여기서 먼저 받아 둔다
function fetchRefs(
  repo: string,
  dir: string,
  defaultBranch: string,
  prs: readonly RelatedPR[],
  runGit: GitRunner,
): ThreeStateFetch[] {
  const fetches: ThreeStateFetch[] = [];
  const fetch = (ref: string, refspec: string) => {
    let r: { status: number; stdout: string };
    try {
      r = runGit(dir, ['fetch', '--quiet', '--no-tags', 'origin', refspec]);
    } catch (e) {
      fetches.push({ repo, ref, ok: false, detail: e instanceof Error ? e.message : String(e) });
      return;
    }
    fetches.push(
      r.status === 0
        ? { repo, ref, ok: true }
        : { repo, ref, ok: false, detail: `git fetch status ${r.status}` },
    );
  };
  const branches = new Set([defaultBranch]);
  for (const pr of prs) if (pr.mergedBranch) branches.add(pr.mergedBranch);
  for (const b of branches) fetch(b, `+refs/heads/${b}:refs/remotes/origin/${b}`);
  for (const pr of prs) {
    if (hasCommit(dir, pr.headSha, runGit)) continue;
    fetch(`pull/${pr.number}/head`, `refs/pull/${pr.number}/head`);
  }
  return fetches;
}

function statusOf(j: ThreeStateJudgment): ThreeStateStatus {
  if (!j.checked) return 'blocked';
  if (!j.verdict) return 'ok';
  return j.verdict.verdict === 'notDefect_mergeOrder' ? 'mergeOrder' : j.verdict.verdict;
}

export async function runThreeState(
  opts: ThreeStateCliOptions,
  deps: CrossPrDeps = {},
): Promise<ThreeStateCliResult> {
  const runGit = deps.runGit ?? defaultRunGit;
  const collect = readCollectResult(opts.candidates);
  const related = readRelatedPrs(opts.relatedPrs);
  const confirmedByUser = parseConfirm(opts.confirm ?? []);
  const defaultBranches = parseDefaultBranches(opts.defaultBranch ?? []);
  const currentRepo = resolveCurrentRepo(
    opts.repo,
    undefined,
    deps.cwd ?? process.cwd(),
    collect.repo,
  );
  const repoDirs = new Map(
    parseRepoDirs(opts.repoDir ?? [], currentRepo.split('/')[0] ?? null).map((d) => [
      d.repo.toLowerCase(),
      d,
    ]),
  );
  const limitations: string[] = [];
  if (related.invalid > 0) limitations.push(`형식이 틀린 연관 PR ${related.invalid}개를 뺐다`);

  // ship ⓐ에서 사용자가 확인한 후보만 확정으로 올린다. 목록에 없는 PR을 새로 만들지는 않는다
  const prs = related.prs.map((pr) =>
    confirmedByUser.has(`${pr.repo.toLowerCase()}#${pr.number}`)
      ? { ...pr, confirmation: 'confirmed' as const }
      : pr,
  );

  const reposWithPrs = uniqueRepos(prs.map((p) => p.repo));
  let pairs = threeStatePairs(collect, currentRepo, reposWithPrs);
  if (pairs.length > MAX_THREE_STATE_PAIRS) {
    limitations.push(
      `판정 쌍이 ${pairs.length}개라 앞의 ${MAX_THREE_STATE_PAIRS}개만 봤다. 나머지는 재확인이 필요하다`,
    );
    pairs = pairs.slice(0, MAX_THREE_STATE_PAIRS);
  }

  const fetches: ThreeStateFetch[] = [];
  const targets = new Map<string, { repo: string; dir: string; defaultBranch: string } | null>();
  for (const repo of uniqueRepos(pairs.map((p) => p.targetRepo))) {
    const key = repo.toLowerCase();
    const dir = repoDirs.get(key);
    if (!dir) {
      targets.set(key, null);
      continue;
    }
    const defaultBranch = defaultBranches.get(key) ?? detectDefaultBranch(dir.dir, runGit);
    const usable = prs.filter(
      (p) => p.repo.toLowerCase() === key && p.confirmation === 'confirmed' && p.state !== 'closed',
    );
    fetches.push(...fetchRefs(repo, dir.dir, defaultBranch, usable, runGit));
    targets.set(key, { repo: dir.repo, dir: dir.dir, defaultBranch });
  }

  const judgments: ThreeStateCliJudgment[] = [];
  for (const pair of pairs) {
    const target = targets.get(pair.targetRepo.toLowerCase());
    if (!target) {
      judgments.push({
        identifier: pair.identifier,
        targetRepo: pair.targetRepo,
        checked: false,
        states: null,
        verdict: null,
        basis: null,
        unconfirmedRelatedPrs: prs
          .filter(
            (p) =>
              p.repo.toLowerCase() === pair.targetRepo.toLowerCase() &&
              p.confirmation !== 'confirmed',
          )
          .map((p) => ({ repo: p.repo, number: p.number })),
        limitations: [`${pair.targetRepo}의 로컬 clone이 없다. --repo-dir로 준다`],
        status: 'blocked',
      });
      continue;
    }
    const results = await judgeThreeState({
      currentRepo,
      identifier: pair.identifier,
      target: { ...target, repo: pair.targetRepo },
      relatedPrs: prs,
      runGit,
    });
    for (const j of results) judgments.push({ ...j, status: statusOf(j) });
  }

  const counts: Record<ThreeStateStatus, number> = {
    ok: 0,
    mergeOrder: 0,
    defect: 0,
    relatedRemovesUsed: 0,
    blocked: 0,
  };
  for (const j of judgments) counts[j.status]++;

  const unconfirmedMap = new Map<string, { repo: string; number: number }>();
  for (const p of prs) {
    if (p.confirmation !== 'confirmed')
      unconfirmedMap.set(`${p.repo.toLowerCase()}#${p.number}`, { repo: p.repo, number: p.number });
  }
  const heads = new Map<string, ThreeStateCliResult['relatedPrHeads'][number]>();
  for (const j of judgments) {
    const r = j.basis?.relatedPr;
    if (r) heads.set(`${r.repo.toLowerCase()}#${r.number}`, r);
  }

  return {
    version: 1,
    currentRepo,
    judgments,
    counts,
    needsRecheck: counts.blocked > 0 || related.lookupBlocked,
    relatedPrUnconfirmed: unconfirmedMap.size > 0,
    unconfirmedRelatedPrs: [...unconfirmedMap.values()],
    relatedPrHeads: [...heads.values()],
    relatedPrLookupBlocked: related.lookupBlocked,
    fetches,
    limitations,
  };
}

// ─── followup find ──────────────────────────────────────────────────────────

export interface FollowupFindCliOptions {
  repo?: string;
  pr?: string;
  candidates?: string;
  relatedRepo?: string[];
  trustedAuthor?: string[];
  json?: boolean;
}

export interface FollowupMarkerHit {
  marker: FollowUpMarker;
  source: { repo: string; number: number; url: string; author: string };
}

export interface FollowupSkip {
  repo: string;
  number?: number;
  reason: string;
  detail: string;
}

export interface FollowupFindResult {
  version: 1;
  status: CrossPrStatus;
  repo: string;
  pr: number | null;
  scannedRepos: string[];
  scannedPrs: number;
  markers: FollowupMarkerHit[];
  /** 신뢰 안 하는 작성자이거나 마커가 가리키는 원래 PR이 코멘트 위치와 다르다. 내용은 싣지 않는다 */
  ignored: { repo: string; number: number; reason: 'untrustedAuthor' | 'originMismatch' }[];
  skipped: FollowupSkip[];
  lookupBlocked: boolean;
  limitations: string[];
}

interface CommentRow {
  body: string;
  login: string;
  url: string;
}

function listComments(
  gh: GhRunner,
  repo: string,
  number: number,
  kind: 'pulls' | 'issues',
): CommentRow[] {
  const out = gh([
    'api',
    '--paginate',
    `repos/${repo}/${kind}/${number}/comments`,
    '--jq',
    '.[] | {body: .body, login: .user.login, url: .html_url}',
  ]);
  return out
    .split('\n')
    .filter((l) => l.trim() !== '')
    .flatMap((line) => {
      try {
        const v = JSON.parse(line) as unknown;
        if (!isRecord(v) || typeof v.body !== 'string') return [];
        return [
          {
            body: v.body,
            login: typeof v.login === 'string' ? v.login : '',
            url: typeof v.url === 'string' ? v.url : '',
          },
        ];
      } catch {
        return [];
      }
    });
}

export function runFollowupFind(
  opts: FollowupFindCliOptions,
  deps: CrossPrDeps = {},
): FollowupFindResult {
  const gh = deps.gh ?? runGh;
  const now = deps.now ?? new Date();
  const pr = parsePr(opts.pr);
  const collect = opts.candidates ? readCollectResult(opts.candidates) : null;
  const extra = (opts.relatedRepo ?? []).map((r) => assertRepo(r, '--related-repo'));
  const repo = resolveCurrentRepo(opts.repo, pr.repo, deps.cwd ?? process.cwd(), collect?.repo);
  const scannedRepos = uniqueRepos([
    repo,
    ...(collect?.relatedRepos ?? []),
    ...configRelatedRepos(deps),
    ...extra,
  ]);
  const since = new Date(now.getTime() - MERGED_LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
  const selfRef = pr.number !== undefined ? `${repo}#${pr.number}`.toLowerCase() : null;

  const trustedBase = new Set((opts.trustedAuthor ?? []).map((a) => a.toLowerCase()));
  const limitations = [`머지된 지 ${MERGED_LOOKBACK_DAYS}일 안의 PR만 훑는다`];
  try {
    const me = gh(['api', 'user', '--jq', '.login']).trim();
    if (me) trustedBase.add(me.toLowerCase());
  } catch {
    limitations.push('gh 로그인을 못 읽어 내 코멘트를 신뢰 목록에 못 넣었다');
  }

  const skipped: FollowupSkip[] = [];
  const ignored: FollowupFindResult['ignored'] = [];
  const byThread = new Map<string, { open?: FollowupMarkerHit; fulfilledElsewhere: boolean }>();
  let scannedPrs = 0;

  for (const r of scannedRepos) {
    let hits: { number: number; author: string }[];
    try {
      const raw = JSON.parse(
        gh([
          'search',
          'prs',
          '--repo',
          r,
          '--merged',
          `--merged-at=>=${since}`,
          '--json',
          'number,author',
          '--limit',
          String(MAX_FOLLOWUP_PRS_PER_REPO),
        ]),
      ) as unknown;
      hits = Array.isArray(raw)
        ? raw.flatMap((h) =>
            isRecord(h) && typeof h.number === 'number'
              ? [
                  {
                    number: h.number,
                    author:
                      isRecord(h.author) && typeof h.author.login === 'string'
                        ? h.author.login
                        : '',
                  },
                ]
              : [],
          )
        : [];
    } catch (e) {
      const f = ghFailure(e);
      skipped.push({ repo: r, reason: f.reason, detail: f.detail });
      continue;
    }

    for (const hit of hits) {
      if (`${r}#${hit.number}`.toLowerCase() === selfRef) continue;
      scannedPrs++;
      let comments: CommentRow[];
      try {
        comments = [
          ...listComments(gh, r, hit.number, 'pulls'),
          ...listComments(gh, r, hit.number, 'issues'),
        ];
      } catch (e) {
        const f = ghFailure(e);
        skipped.push({ repo: r, number: hit.number, reason: f.reason, detail: f.detail });
        continue;
      }
      // 마커는 원래 PR 작성자나 이 세션 사용자가 남긴 것만 믿는다. 다른 사람이 흉내 낸 마커가 요구를 만들지 못하게 한다
      const trusted = new Set(trustedBase);
      if (hit.author) trusted.add(hit.author.toLowerCase());
      for (const c of comments) {
        const markers = parseFollowUpMarkers(c.body);
        if (markers.length === 0) continue;
        if (!trusted.has(c.login.toLowerCase())) {
          ignored.push({ repo: r, number: hit.number, reason: 'untrustedAuthor' });
          continue;
        }
        for (const m of markers) {
          if (m.originRepo.toLowerCase() !== r.toLowerCase() || m.originPrNumber !== hit.number) {
            ignored.push({ repo: r, number: hit.number, reason: 'originMismatch' });
            continue;
          }
          if (m.targetRepo.toLowerCase() !== repo.toLowerCase()) continue;
          const key = `${m.originRepo.toLowerCase()}#${m.originPrNumber}\0${m.threadId}`;
          const entry = byThread.get(key) ?? { fulfilledElsewhere: false };
          if (isFulfilled(m) && m.fulfilledByPr!.toLowerCase() !== selfRef) {
            entry.fulfilledElsewhere = true;
          } else {
            entry.open = {
              marker: m,
              source: { repo: r, number: hit.number, url: c.url, author: c.login },
            };
          }
          byThread.set(key, entry);
        }
      }
    }
  }

  const markers = [...byThread.values()].flatMap((e) =>
    e.open && !e.fulfilledElsewhere ? [e.open] : [],
  );
  const lookupBlocked = skipped.some((s) => GH_BLOCK_REASONS.has(s.reason));
  if (skipped.length > 0 && !lookupBlocked)
    limitations.push('일부 조회가 실패해 마커가 빠졌을 수 있다');

  return {
    version: 1,
    status: lookupBlocked ? 'blocked' : markers.length > 0 ? 'found' : 'none',
    repo,
    pr: pr.number ?? null,
    scannedRepos,
    scannedPrs,
    markers,
    ignored,
    skipped,
    lookupBlocked,
    limitations,
  };
}

// ─── followup check ─────────────────────────────────────────────────────────

export interface FollowupCheckCliOptions {
  markers: string;
  pr?: string;
  repo?: string;
  bodyFile?: string;
  diffFile?: string;
  json?: boolean;
}

/** askBodyMention: 후속 PR 본문에 원래 PR을 적어 달라는 코멘트. missingWork: 예정한 작업이 안 보인다는 코멘트 */
export type FollowupAction = 'askBodyMention' | 'missingWork' | 'wrongRepo';

export interface FollowupCheckItem extends FollowupMarkerHit {
  match: FollowUpMatch;
  actions: FollowupAction[];
}

export interface FollowupCheckResult {
  version: 1;
  status: 'blocked' | 'needsComment' | 'ok';
  repo: string;
  pr: number | null;
  results: FollowupCheckItem[];
  needsBodyMention: boolean;
  unmetCount: number;
  /** find 단계가 막혔었다. 결과가 비어도 후속 작업 없음으로 읽지 않는다 */
  upstreamBlocked: boolean;
  lookupBlocked: boolean;
  limitations: string[];
}

function readMarkers(path: string): { hits: FollowupMarkerHit[]; blocked: boolean } {
  const raw = readJsonFile(path, '--markers');
  if (!isRecord(raw) || !Array.isArray(raw.markers)) {
    throw new Error(`--markers는 harness-refs followup find --json 결과여야 한다: ${path}`);
  }
  const hits = raw.markers.flatMap((h): FollowupMarkerHit[] => {
    if (!isRecord(h) || !isRecord(h.source) || !isRecord(h.marker)) return [];
    // 파일을 거친 마커도 정해진 형식으로 다시 걸러 필드가 섞여 들어오지 못하게 한다
    const m = h.marker;
    if (typeof m.plannedWork !== 'string' || typeof m.targetRepo !== 'string') return [];
    const reparsed = parseFollowUpMarkers(buildFollowUpMarker(m as unknown as FollowUpMarker))[0];
    const { repo, number, url, author } = h.source;
    if (!reparsed || typeof repo !== 'string' || typeof number !== 'number') return [];
    return [
      {
        marker: reparsed,
        source: {
          repo,
          number,
          url: typeof url === 'string' ? url : '',
          author: typeof author === 'string' ? author : '',
        },
      },
    ];
  });
  return { hits, blocked: raw.lookupBlocked === true || raw.status === 'blocked' };
}

export function runFollowupCheck(
  opts: FollowupCheckCliOptions,
  deps: CrossPrDeps = {},
): FollowupCheckResult {
  const gh = deps.gh ?? runGh;
  const pr = parsePr(opts.pr);
  const { hits, blocked: upstreamBlocked } = readMarkers(opts.markers);
  if (pr.number === undefined && opts.bodyFile === undefined) {
    throw new Error('--pr 또는 --body-file 중 하나를 준다');
  }
  const repo = resolveCurrentRepo(opts.repo, pr.repo, deps.cwd ?? process.cwd());
  const limitations: string[] = [];

  let body = opts.bodyFile ? readTextFile(opts.bodyFile, '--body-file') : undefined;
  let diff = opts.diffFile ? readTextFile(opts.diffFile, '--diff-file') : undefined;
  const base = { version: 1 as const, repo, pr: pr.number ?? null, upstreamBlocked };

  if (pr.number !== undefined && (body === undefined || diff === undefined)) {
    try {
      if (body === undefined) {
        const raw = JSON.parse(
          gh(['pr', 'view', String(pr.number), '--repo', repo, '--json', 'body']),
        ) as unknown;
        body = isRecord(raw) && typeof raw.body === 'string' ? raw.body : '';
      }
      if (diff === undefined) diff = gh(['pr', 'diff', String(pr.number), '--repo', repo]);
    } catch (e) {
      const f = ghFailure(e);
      return {
        ...base,
        status: 'blocked',
        results: [],
        needsBodyMention: false,
        unmetCount: 0,
        lookupBlocked: true,
        limitations: [`후속 PR 본문이나 diff를 못 읽었다 (${f.reason})`],
      };
    }
  }
  if (diff === undefined) limitations.push('diff 없이 본문만 보고 작업 이행을 판정했다');

  const results = hits.map((h): FollowupCheckItem => {
    const match = matchFollowUp(h.marker, {
      repo,
      number: pr.number ?? 0,
      body: body ?? '',
      diff: diff ?? '',
    });
    const actions: FollowupAction[] = [];
    if (match.status === 'wrongRepo') actions.push('wrongRepo');
    else {
      if (!match.mentionsOrigin) actions.push('askBodyMention');
      if (match.status === 'unmet') actions.push('missingWork');
    }
    return { ...h, match, actions };
  });

  const needsBodyMention = results.some((r) => r.actions.includes('askBodyMention'));
  const unmetCount = results.filter((r) => r.actions.includes('missingWork')).length;
  const needsComment = results.some((r) => r.actions.length > 0);
  return {
    ...base,
    status: upstreamBlocked ? 'blocked' : needsComment ? 'needsComment' : 'ok',
    results,
    needsBodyMention,
    unmetCount,
    lookupBlocked: false,
    limitations,
  };
}

// ─── followup build ─────────────────────────────────────────────────────────

export interface FollowupBuildCliOptions {
  repo?: string;
  pr: string;
  threadId: string;
  targetRepo: string;
  work?: string;
  /** 스킬은 작업 문장을 셸 인자 대신 파일로 넘긴다. 따옴표나 백틱이 섞이면 인자 경계가 무너진다 */
  workFile?: string;
  json?: boolean;
}

export interface FollowupBuildResult {
  version: 1;
  marker: FollowUpMarker;
  /** resolve 답글 끝에 그대로 붙이는 두 줄. 첫 줄은 기계가 읽는 주석, 둘째 줄은 사람이 읽는 문장 */
  text: string;
}

/**
 * review-loop가 '다음 PR에서 한다' 스레드를 resolve할 때 답글에 붙일 마커를 만든다.
 * 원래 PR은 지금 리뷰 중인 PR이다. find가 코멘트 위치와 originRepo, originPrNumber를 맞춰 보므로
 * 다른 PR 번호를 넣으면 후속 PR 리뷰에서 그 마커는 버려진다.
 */
export function runFollowupBuild(
  opts: FollowupBuildCliOptions,
  deps: CrossPrDeps = {},
): FollowupBuildResult {
  const pr = parsePr(opts.pr);
  if (pr.number === undefined) throw new Error(`--pr는 PR 번호나 URL이어야 한다: ${opts.pr}`);
  const originRepo = resolveCurrentRepo(opts.repo, pr.repo, deps.cwd ?? process.cwd());
  const marker: FollowUpMarker = {
    originRepo,
    originPrNumber: pr.number,
    threadId: opts.threadId,
    targetRepo: assertRepo(opts.targetRepo, '--target-repo'),
    plannedWork: plannedWorkOf(opts),
  };
  const text = buildFollowUpMarker(marker);
  // 읽는 쪽이 버릴 마커를 게시하면 이어받기가 조용히 끊긴다. 쓰는 자리에서 같은 파서로 걸러 인자 오류로 돌려준다
  const reparsed = parseFollowUpMarkers(text)[0];
  if (!reparsed) {
    throw new Error('--thread-id와 --work는 비어 있지 않고 500자 이하여야 한다');
  }
  return { version: 1, marker: reparsed, text };
}

function plannedWorkOf(opts: FollowupBuildCliOptions): string {
  if ((opts.work === undefined) === (opts.workFile === undefined)) {
    throw new Error('--work와 --work-file 중 하나만 준다');
  }
  return opts.work ?? readTextFile(opts.workFile!, '--work-file').trim();
}

// ─── 커맨드 진입점 ──────────────────────────────────────────────────────────

function formatStatus(label: string, status: string, extra: string[]): string {
  const head = status === 'blocked' ? `${label}: 막힘, 재확인 필요` : `${label}: ${status}`;
  return [head, ...extra].join('\n');
}

async function emit<T>(
  json: boolean | undefined,
  body: () => T | Promise<T>,
  summary: (r: T) => string,
): Promise<void> {
  let result: T;
  try {
    result = await body();
  } catch (e) {
    // 실패하면 stdout을 비운다. 빈 출력이 "없음"으로 읽히지 않게 종료 코드로 답한다
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  console.log(json ? JSON.stringify(result) : summary(result));
}

export function harnessRefsRelatedPrsCommand(opts: RelatedPrsCliOptions): Promise<void> {
  return emit(
    opts.json,
    () => runRelatedPrs(opts),
    (r) =>
      formatStatus('연관 PR', r.status, [
        `확정 ${r.confirmed.length}, 미확정 ${r.unconfirmed.length}`,
        ...r.limitations,
      ]),
  );
}

export function harnessRefsThreeStateCommand(opts: ThreeStateCliOptions): Promise<void> {
  return emit(
    opts.json,
    () => runThreeState(opts),
    (r) =>
      formatStatus('세 상태', r.needsRecheck ? 'blocked' : 'done', [
        `결함 ${r.counts.defect}, 머지 순서 ${r.counts.mergeOrder}, 연관 PR이 지움 ${r.counts.relatedRemovesUsed}, 못 봄 ${r.counts.blocked}`,
        ...(r.relatedPrUnconfirmed ? ['확정 안 된 연관 PR이 있다'] : []),
        ...r.limitations,
      ]),
  );
}

export function harnessRefsFollowupFindCommand(opts: FollowupFindCliOptions): Promise<void> {
  return emit(
    opts.json,
    () => runFollowupFind(opts),
    (r) =>
      formatStatus('후속 마커', r.status, [
        `마커 ${r.markers.length}, 훑은 PR ${r.scannedPrs}`,
        ...r.limitations,
      ]),
  );
}

export function harnessRefsFollowupBuildCommand(opts: FollowupBuildCliOptions): Promise<void> {
  return emit(
    opts.json,
    () => runFollowupBuild(opts),
    (r) => r.text,
  );
}

export function harnessRefsFollowupCheckCommand(opts: FollowupCheckCliOptions): Promise<void> {
  return emit(
    opts.json,
    () => runFollowupCheck(opts),
    (r) =>
      formatStatus('후속 작업', r.status, [
        `본문 명시 요청 ${r.needsBodyMention ? '필요' : '없음'}, 빠진 작업 ${r.unmetCount}`,
      ]),
  );
}
