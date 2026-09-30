import { runGh, type GhRunner } from '../review-loop/fetch.js';
import { classifyGhFailure, type BlockReason } from './github-backend.js';
import type { ConfirmationType, FoundByType, PrState, RelatedPR, RelatedRepo } from './types.js';

/**
 * 머지된 연관 PR 후보를 거슬러 찾는 기간. 이번 PR 생성 시각에서 센다. 실행 시각에서 세면
 * 오래 열린 PR이나 재현 실행에서 같은 시기에 머지된 PR이 전부 빠진다.
 * 사용자 결정으로 30일에 고정했고 설정으로 열지 않는다.
 * 0이나 끄기 값을 받을 자리를 두면 그게 탐색을 끄는 스위치가 된다.
 */
export const MERGED_LOOKBACK_DAYS = 30;

/** "비슷한 시기"의 폭. 이번 PR 생성 시각 앞뒤로 이만큼 안에 만들어진 PR만 본다 */
export const SAME_AUTHOR_NEARBY_DAYS = 14;

/**
 * 참조 대상을 건드리는 열린 PR 중 이번 PR보다 이만큼 먼저 열린 건 연관 후보로 안 본다.
 * 이번 작업이 시작되기 전부터 열려 있던 PR이라, 파일이 겹쳐도 함께 진행한 작업이 아니다.
 * 몇 달째 열린 PR 하나가 그 파일을 건드리는 모든 PR에 후보로 붙는 걸 막는다.
 * 머지된 PR은 이번 PR 앞뒤로 이만큼 안에 열린 것만 본다. 뒤쪽을 막지 않으면 오래 열린 PR이나
 * 재현 실행에서 최근 머지된 PR이 조회 결과를 다 채워 같은 시기 PR이 밀려난다.
 */
export const TOUCHES_TARGET_MAX_AGE_DAYS = 30;

/**
 * 한 단계에서 상세 조회까지 가는 후보 상한. 검색은 열린 PR과 머지된 PR로 나눠 두 번 하고
 * 이 상한도 각각에 건다. 합쳐서 자르면 열린 PR이 먼저 차서 머지된 PR이 밀려난다
 */
export const MAX_CANDIDATES_PER_STEP = 30;

/**
 * 검색 한 번에 받아오는 결과 수. 상세 조회 상한보다 넉넉히 받아 생성일 거리로 줄 세운 뒤 자른다.
 * GitHub 검색 기본 순서(best-match)대로 자르면 가까운 PR이 뒤로 밀려 빠진다
 */
export const SEARCH_FETCH_LIMIT = 100;

/** 본문에서 따라가는 링크 상한 */
export const MAX_BODY_LINKS = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 확정 기준 표의 열. ship은 내 PR이라 ⓐ 승인 단계에서 한 줄로 확인받고
 * review-loop는 남의 PR이라 작성자에게 질문으로 넘긴다.
 */
export const RELATED_PR_MODES = ['ship', 'reviewLoop'] as const;
export type RelatedPrMode = (typeof RELATED_PR_MODES)[number];

/** 이번에 보는 PR. ship은 아직 GitHub PR이 없을 수 있어 number와 createdAt을 비워도 된다 */
export interface CurrentPr {
  /** 'owner/name' */
  repo: string;
  number?: number;
  title: string;
  body: string;
  author: string;
  branch: string;
  createdAt?: string;
}

/** 참조 대상 파일. 역방향 검색(task-10) 결과의 repo와 path를 그대로 넘긴다 */
export interface ReferenceTarget {
  repo: string;
  path: string;
}

export interface RelatedPrCandidate extends RelatedPR {
  url: string;
  author: string;
  branch: string;
  /** 판정 근거. 우리가 만든 문장이고 PR 본문을 옮겨 적지 않는다 */
  evidence: string[];
  signals: RelatedPrSignals;
}

export interface RelatedPrSignals {
  bodyLink: boolean;
  sharedTicketKeys: string[];
  sameAuthor: boolean;
  sameBranch: boolean;
  touchedTargets: string[];
}

export type RelatedPrStep = FoundByType;

export interface RelatedPrSkip {
  step: RelatedPrStep;
  repo?: string;
  number?: number;
  reason: BlockReason | 'outsideRelatedRepos' | 'unparsable' | 'unknown';
  detail: string;
}

export interface RelatedPrNotice {
  repo: string;
  number: number;
  /** 지시로 위장한 문구가 있었다는 사실만 싣는다. 문구는 따르지 않는다 */
  kind: 'instructionLikeText';
  detail: string;
}

export interface FindRelatedPrsResult {
  mode: RelatedPrMode;
  candidates: RelatedPrCandidate[];
  skipped: RelatedPrSkip[];
  notices: RelatedPrNotice[];
  /** 레포를 넘는 연관 PR이 있는데 본문에 링크가 없다. 추가 제안 코멘트 자리 */
  suggestBodyLink: boolean;
  /** 이번 PR에서 읽은 티켓 키 */
  ticketKeys: string[];
}

export interface FindRelatedPrsOptions {
  current: CurrentPr;
  mode: RelatedPrMode;
  /** 'owner/name' 또는 detectRelatedRepos()의 RelatedRepo. 이 목록 밖의 PR은 따라가지 않는다 */
  relatedRepos: ReadonlyArray<string | Pick<RelatedRepo, 'owner' | 'name'>>;
  referenceTargets?: readonly ReferenceTarget[];
  gh?: GhRunner;
  now?: Date;
}

interface PrDetail {
  repo: string;
  number: number;
  state: PrState;
  headSha: string;
  branch: string;
  baseBranch: string;
  author: string;
  title: string;
  body: string;
  url: string;
  createdAt: string | null;
  mergedAt: string | null;
  files: string[];
}

const VIEW_FIELDS =
  'number,state,headRefOid,headRefName,baseRefName,author,title,body,url,createdAt,mergedAt,files';

/**
 * 이번 PR의 연관 PR을 찾아 확정 수준을 매긴다.
 *
 * 순서는 본문 링크, 같은 티켓 키, 참조 대상을 건드리는 열린 PR, 같은 작성자의 비슷한 시기 PR이다.
 * 같은 PR이 여러 단계에 걸리면 먼저 찾은 단계가 foundBy가 되고 신호는 합친다.
 *
 * PR 본문과 제목은 링크와 티켓 키를 정규식으로 뽑는 데만 쓴다. 거기 적힌 문장은
 * 탐색 범위도 확정 수준도 바꾸지 못한다 (untrusted-input.md).
 */
export function findRelatedPrs(opts: FindRelatedPrsOptions): FindRelatedPrsResult {
  const gh = opts.gh ?? runGh;
  const now = opts.now ?? new Date();
  const { current, mode } = opts;
  const allowed = new Set(opts.relatedRepos.map(repoKey));
  const selfKey = current.repo.toLowerCase();

  const found = new Map<
    string,
    { detail: PrDetail; foundBy: FoundByType; signals: RelatedPrSignals }
  >();
  const skipped: RelatedPrSkip[] = [];
  const notices: RelatedPrNotice[] = [];
  const ticketKeys = extractTicketKeys([current.title, current.body, current.branch].join('\n'));
  const center = current.createdAt ? new Date(current.createdAt) : now;
  const mergedSinceMs = center.getTime() - MERGED_LOOKBACK_DAYS * DAY_MS;
  const mergedSince = isoDate(new Date(mergedSinceMs));
  const distanceMs = (createdAt: string | null) => {
    const t = createdAt ? Date.parse(createdAt) : NaN;
    return Number.isFinite(t) ? Math.abs(t - center.getTime()) : Number.POSITIVE_INFINITY;
  };

  // ship은 PR 번호가 아직 없을 수 있어 같은 레포의 같은 브랜치도 자기 자신으로 본다
  const isSelf = (repo: string, number: number, branch?: string) =>
    repo.toLowerCase() === selfKey &&
    (number === current.number || (current.number === undefined && branch === current.branch));

  const targetsByRepo = new Map<string, Set<string>>();
  for (const t of opts.referenceTargets ?? []) {
    const repo = t.repo.toLowerCase();
    if (!allowed.has(repo)) {
      skipped.push({
        step: 'touchesTarget',
        repo: t.repo,
        reason: 'outsideRelatedRepos',
        detail: '관련 레포 목록 밖이라 따라가지 않는다',
      });
      continue;
    }
    const set = targetsByRepo.get(repo) ?? new Set<string>();
    set.add(t.path);
    targetsByRepo.set(repo, set);
  }
  const record = (step: FoundByType, detail: PrDetail, patch: Partial<RelatedPrSignals>) => {
    const key = `${detail.repo.toLowerCase()}#${detail.number}`;
    let entry = found.get(key);
    if (!entry) {
      entry = { detail, foundBy: step, signals: baseSignals(current, detail, ticketKeys) };
      // 머지된 PR도 참조 대상을 건드렸는지 본다. 확정 수준은 안 바꾸고 순서에만 쓴다
      const targets = targetsByRepo.get(detail.repo.toLowerCase());
      if (targets) entry.signals.touchedTargets = detail.files.filter((f) => targets.has(f));
      found.set(key, entry);
      const notice = scanInstructionLikeText(detail);
      if (notice) notices.push(notice);
    }
    if (patch.bodyLink) entry.signals.bodyLink = true;
    for (const t of patch.touchedTargets ?? []) {
      if (!entry.signals.touchedTargets.includes(t)) entry.signals.touchedTargets.push(t);
    }
  };

  const view = (step: FoundByType, repo: string, number: number): PrDetail | null => {
    const run = runJson(gh, ['pr', 'view', String(number), '--repo', repo, '--json', VIEW_FIELDS]);
    if (!run.ok) {
      skipped.push({ step, repo, number, reason: run.reason, detail: run.detail });
      return null;
    }
    const detail = toPrDetail(repo, run.value);
    if (!detail)
      skipped.push({ step, repo, number, reason: 'unparsable', detail: 'PR 응답 형식이 다르다' });
    return detail;
  };

  // 1. 본문 링크
  const links = extractPrLinks(current.body).slice(0, MAX_BODY_LINKS);
  let hasBodyLink = false;
  for (const link of links) {
    if (isSelf(link.repo, link.number)) continue;
    if (!allowed.has(link.repo.toLowerCase())) {
      skipped.push({
        step: 'bodyLink',
        repo: link.repo,
        number: link.number,
        reason: 'outsideRelatedRepos',
        detail: '관련 레포 목록 밖이라 따라가지 않는다',
      });
      continue;
    }
    const detail = view('bodyLink', link.repo, link.number);
    if (!detail) continue;
    hasBodyLink = true;
    record('bodyLink', detail, { bodyLink: true });
  }

  const repos = [...allowed];
  const searchStep = (step: FoundByType, baseArgs: string[], accept: (d: PrDetail) => boolean) => {
    if (repos.length === 0) return;
    const repoArgs = repos.flatMap((r) => ['--repo', r]);
    const variants = [
      ['--state', 'open'],
      ['--merged', `--merged-at=>=${mergedSince}`],
    ];
    const hits: SearchHit[] = [];
    for (const variant of variants) {
      const run = runJson(gh, [
        'search',
        'prs',
        ...baseArgs,
        ...repoArgs,
        ...variant,
        '--json',
        'number,repository,createdAt',
        '--limit',
        String(SEARCH_FETCH_LIMIT),
      ]);
      if (!run.ok) {
        skipped.push({ step, reason: run.reason, detail: run.detail });
        continue;
      }
      const nearest = parseSearchHits(run.value)
        .sort((a, b) => distanceMs(a.createdAt) - distanceMs(b.createdAt))
        .slice(0, MAX_CANDIDATES_PER_STEP);
      hits.push(...nearest);
    }
    for (const hit of dedupeHits(hits)) {
      if (!allowed.has(hit.repo.toLowerCase()) || isSelf(hit.repo, hit.number)) continue;
      const existing = found.get(`${hit.repo.toLowerCase()}#${hit.number}`);
      const detail = existing?.detail ?? view(step, hit.repo, hit.number);
      if (!detail || isSelf(detail.repo, detail.number, detail.branch)) continue;
      if (!isWithinWindow(detail, mergedSinceMs) || !accept(detail)) continue;
      record(step, detail, {});
    }
  };

  // 2. 같은 티켓 키. 검색은 넓게 걸리므로 키가 제목, 본문, 브랜치에 실제로 있는지 다시 본다
  for (const key of ticketKeys) {
    searchStep('ticketKey', [key], (d) =>
      extractTicketKeys([d.title, d.body, d.branch].join('\n')).includes(key),
    );
  }

  // 3. 참조 대상을 건드리는 PR. 목록 조회가 files를 함께 주므로 상세 조회 없이 거른다
  const openedSince = center.getTime() - TOUCHES_TARGET_MAX_AGE_DAYS * DAY_MS;
  const openedUntil = center.getTime() + TOUCHES_TARGET_MAX_AGE_DAYS * DAY_MS;
  const listVariants: { state: 'open' | 'merged'; args: string[] }[] = [
    { state: 'open', args: ['--state', 'open', '--limit', String(MAX_CANDIDATES_PER_STEP)] },
    {
      state: 'merged',
      args: [
        '--state',
        'merged',
        '--search',
        `merged:>=${mergedSince} created:${isoDate(new Date(openedSince))}..${isoDate(new Date(openedUntil))}`,
        '--limit',
        String(SEARCH_FETCH_LIMIT),
      ],
    },
  ];
  for (const [repo, paths] of targetsByRepo) {
    for (const variant of listVariants) {
      const run = runJson(gh, [
        'pr',
        'list',
        '--repo',
        repo,
        ...variant.args,
        '--json',
        VIEW_FIELDS,
      ]);
      if (!run.ok) {
        skipped.push({ step: 'touchesTarget', repo, reason: run.reason, detail: run.detail });
        continue;
      }
      if (!Array.isArray(run.value)) {
        skipped.push({
          step: 'touchesTarget',
          repo,
          reason: 'unparsable',
          detail: '배열이 아니다',
        });
        continue;
      }
      const hits: { detail: PrDetail; touched: string[] }[] = [];
      for (const raw of run.value) {
        const detail = toPrDetail(repo, raw);
        if (!detail || detail.state !== variant.state) continue;
        if (isSelf(detail.repo, detail.number, detail.branch)) continue;
        const opened = detail.createdAt ? Date.parse(detail.createdAt) : NaN;
        if (Number.isFinite(opened) && opened < openedSince) continue;
        if (variant.state === 'merged') {
          if (Number.isFinite(opened) && opened > openedUntil) continue;
          if (!isWithinWindow(detail, mergedSinceMs)) continue;
        }
        const touched = detail.files.filter((f) => paths.has(f));
        if (touched.length > 0) hits.push({ detail, touched });
      }
      hits
        .sort((a, b) => distanceMs(a.detail.createdAt) - distanceMs(b.detail.createdAt))
        .slice(0, MAX_CANDIDATES_PER_STEP)
        .forEach(({ detail, touched }) =>
          record('touchesTarget', detail, { touchedTargets: touched }),
        );
    }
  }

  const distance = (d: PrDetail) => distanceMs(d.createdAt);

  // 4. 같은 작성자의 비슷한 시기 PR
  if (current.author) {
    const from = isoDate(new Date(center.getTime() - SAME_AUTHOR_NEARBY_DAYS * DAY_MS));
    const to = isoDate(new Date(center.getTime() + SAME_AUTHOR_NEARBY_DAYS * DAY_MS));
    searchStep(
      'sameAuthorNearby',
      [`--author=${current.author}`, `--created=${from}..${to}`],
      (d) => sameLogin(d.author, current.author),
    );
  }

  // 기본 브랜치는 머지된 후보가 있는 레포만 한 번씩 묻는다. 못 알아내면 묻는 쪽으로 남긴다
  const defaultBranches = new Map<string, string | null>();
  const defaultBranchOf = (repo: string, step: FoundByType): string | null => {
    const key = repo.toLowerCase();
    if (defaultBranches.has(key)) return defaultBranches.get(key)!;
    const run = runJson(gh, ['repo', 'view', repo, '--json', 'defaultBranchRef']);
    let branch: string | null = null;
    if (!run.ok) skipped.push({ step, repo, reason: run.reason, detail: run.detail });
    else if (isRecord(run.value) && isRecord(run.value.defaultBranchRef)) {
      const name = run.value.defaultBranchRef.name;
      if (typeof name === 'string' && name) branch = name;
    }
    if (run.ok && branch === null)
      skipped.push({ step, repo, reason: 'unparsable', detail: '기본 브랜치를 못 읽었다' });
    defaultBranches.set(key, branch);
    return branch;
  };

  // 열린 PR과 머지된 PR을 나눠 세운다. 머지된 PR이 열린 PR을 뒤로 밀지 않게 한다
  const candidates = [...found.values()]
    .sort(
      (a, b) =>
        stateGroup(a.detail.state) - stateGroup(b.detail.state) ||
        rankOf(a.signals) - rankOf(b.signals) ||
        distance(a.detail) - distance(b.detail),
    )
    .map(({ detail, foundBy, signals }) => {
      const confirmation = decideConfirmation(signals, mode);
      const inDefault =
        confirmation !== 'confirmed' &&
        detail.state === 'merged' &&
        detail.baseBranch === defaultBranchOf(detail.repo, foundBy);
      return toCandidate(detail, foundBy, signals, inDefault ? 'inDefaultBranch' : confirmation);
    });

  return {
    mode,
    candidates,
    skipped,
    notices,
    suggestBodyLink: !hasBodyLink && candidates.length > 0,
    ticketKeys,
  };
}

/**
 * 확정 기준 표. ship과 review-loop가 갈리는 자리가 여기 하나다.
 * - 본문 링크: 양쪽 다 확정
 * - 같은 작성자 + 같은 티켓: 양쪽 다 확정. review-loop는 근거를 리포트에 싣는다
 * - 같은 작성자 + 같은 브랜치명: ship만 확정
 * - 그 밖(참조 대상만 건드림, 같은 작성자만 등): ship은 ⓐ에서 확인, review-loop는 작성자 질문
 * 확정 못 한 후보가 이미 기본 브랜치에 머지됐으면 findRelatedPrs가 inDefaultBranch로 바꾼다.
 * 기본 브랜치 조회가 gh를 타야 해서 이 함수 밖에 둔다
 */
export function decideConfirmation(
  signals: RelatedPrSignals,
  mode: RelatedPrMode,
): ConfirmationType {
  if (signals.bodyLink) return 'confirmed';
  if (signals.sameAuthor && signals.sharedTicketKeys.length > 0) return 'confirmed';
  if (mode === 'ship' && signals.sameAuthor && signals.sameBranch) return 'confirmed';
  return mode === 'ship' ? 'needsShipConfirm' : 'needsAuthorAnswer';
}

/** 답 전까지 판정 근거로 쓰면 안 되는 후보를 거른다. confirmed만 세 상태 판정으로 넘긴다 */
export function confirmedRelatedPrs(
  candidates: readonly RelatedPrCandidate[],
): RelatedPrCandidate[] {
  return candidates.filter((c) => c.confirmation === 'confirmed');
}

const PR_URL_RE = /https?:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/g;
const PR_SHORT_RE = /(?<![\w/.-])([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#(\d+)\b/g;

/** 본문에서 PR 링크를 뽑는다. 전체 URL과 owner/name#N 꼴만 본다 */
export function extractPrLinks(text: string): { repo: string; number: number }[] {
  const out: { repo: string; number: number }[] = [];
  const seen = new Set<string>();
  const push = (owner: string, name: string, num: string) => {
    const repo = `${owner}/${name.replace(/\.git$/, '')}`;
    const number = Number(num);
    const key = `${repo.toLowerCase()}#${number}`;
    if (!Number.isSafeInteger(number) || number <= 0 || seen.has(key)) return;
    seen.add(key);
    out.push({ repo, number });
  };
  for (const m of text.matchAll(PR_URL_RE)) push(m[1]!, m[2]!, m[3]!);
  for (const m of text.matchAll(PR_SHORT_RE)) push(m[1]!, m[2]!, m[3]!);
  return out;
}

const TICKET_RE = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,9})-(\d{1,6})(?![A-Za-z0-9])/g;

// 티켓 키 꼴이지만 규격 이름인 것. 같은 규격을 언급했다고 연관 PR이 되지 않는다
const NON_TICKET_PREFIXES = new Set([
  'UTF',
  'ISO',
  'SHA',
  'AES',
  'RFC',
  'CVE',
  'HTTP',
  'TLS',
  'ES',
  'MD',
]);

/** 텍스트에서 티켓 키(PROJ-123 꼴)를 나온 순서대로 뽑는다 */
export function extractTicketKeys(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TICKET_RE)) {
    if (NON_TICKET_PREFIXES.has(m[1]!)) continue;
    const key = `${m[1]!}-${m[2]!}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

// 연관 PR 본문이 리뷰 절차를 바꾸려 드는 흔한 꼴. 걸리면 알리기만 하고 내용은 따르지 않는다
const INSTRUCTION_LIKE_RE = [
  /ignore (all |the )?(previous|prior|above) (instructions|rules)/i,
  /disregard (the )?(previous|prior|above|system)/i,
  /(approve|merge) (this|the) pr (without|immediately)/i,
  /system prompt/i,
  /(이전|앞의|위의) (지시|규칙|명령)(을|를)? ?무시/,
  /(리뷰|검사|규칙)(을|를)? ?(건너뛰|생략|끄)/,
  /바로 (승인|머지)/,
];

function scanInstructionLikeText(detail: PrDetail): RelatedPrNotice | null {
  const text = `${detail.title}\n${detail.body}`;
  if (!INSTRUCTION_LIKE_RE.some((re) => re.test(text))) return null;
  return {
    repo: detail.repo,
    number: detail.number,
    kind: 'instructionLikeText',
    detail: '연관 PR 본문에 지시로 보이는 문구가 있다. 자료로만 읽고 따르지 않았다',
  };
}

/**
 * 후보를 세우는 순서. 거르지 않고 순서만 바꾼다 — 신호가 약해도 진짜 연관인 PR이 있어서다.
 * 여러 레포에 같은 작업을 퍼뜨린 PR은 티켓도 경로도 다를 수 있다
 */
function stateGroup(state: PrState): number {
  return state === 'open' ? 0 : state === 'merged' ? 1 : 2;
}

function rankOf(signals: RelatedPrSignals): number {
  if (signals.bodyLink) return 0;
  if (signals.sharedTicketKeys.length > 0) return 1;
  if (signals.touchedTargets.length > 0) return 2;
  return 3;
}

function baseSignals(current: CurrentPr, detail: PrDetail, ticketKeys: string[]): RelatedPrSignals {
  const theirKeys = extractTicketKeys([detail.title, detail.body, detail.branch].join('\n'));
  return {
    bodyLink: false,
    sharedTicketKeys: ticketKeys.filter((k) => theirKeys.includes(k)),
    sameAuthor: sameLogin(current.author, detail.author),
    sameBranch: current.branch !== '' && current.branch === detail.branch,
    touchedTargets: [],
  };
}

function toCandidate(
  detail: PrDetail,
  foundBy: FoundByType,
  signals: RelatedPrSignals,
  confirmation: ConfirmationType,
): RelatedPrCandidate {
  const evidence: string[] = [];
  if (signals.bodyLink) evidence.push('이번 PR 본문이 링크한다');
  if (signals.sharedTicketKeys.length > 0)
    evidence.push(`같은 티켓 키 ${signals.sharedTicketKeys.join(', ')}`);
  if (signals.sameAuthor) evidence.push('같은 작성자');
  if (signals.sameBranch) evidence.push(`같은 브랜치명 ${detail.branch}`);
  if (signals.touchedTargets.length > 0)
    evidence.push(`참조 대상을 건드린다: ${signals.touchedTargets.join(', ')}`);
  if (detail.state === 'merged') evidence.push(`${detail.baseBranch}에 머지됨`);

  return {
    repo: detail.repo,
    number: detail.number,
    headSha: detail.headSha,
    state: detail.state,
    ...(detail.state === 'merged' ? { mergedBranch: detail.baseBranch } : {}),
    foundBy,
    confirmation,
    url: detail.url,
    author: detail.author,
    branch: detail.branch,
    evidence,
    signals,
  };
}

// 머지된 PR만 기간을 본다. 열린 PR은 기간 제한이 없고 닫힌 PR은 본문 링크로만 들어온다
function isWithinWindow(detail: PrDetail, mergedSinceMs: number): boolean {
  if (detail.state === 'open') return true;
  if (detail.state !== 'merged' || !detail.mergedAt) return false;
  const merged = Date.parse(detail.mergedAt);
  return Number.isFinite(merged) && merged >= mergedSinceMs;
}

type RunResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: RelatedPrSkip['reason']; detail: string };

function runJson(gh: GhRunner, args: string[]): RunResult {
  let raw: string;
  try {
    raw = gh(args);
  } catch (e) {
    const detail = failureText(e);
    return { ok: false, reason: classifyGhFailure(detail) ?? 'unknown', detail };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, reason: 'unparsable', detail: 'gh 응답이 JSON이 아니다' };
  }
}

function failureText(e: unknown): string {
  if (typeof e !== 'object' || e === null) return String(e);
  const { stderr, message } = e as { stderr?: unknown; message?: unknown };
  return [stderr, message]
    .filter((v) => v !== undefined && v !== null)
    .map(String)
    .join('\n');
}

function toPrDetail(fallbackRepo: string, raw: unknown): PrDetail | null {
  if (!isRecord(raw)) return null;
  const number = raw.number;
  const headSha = raw.headRefOid;
  if (typeof number !== 'number' || typeof headSha !== 'string') return null;
  const state = normalizeState(raw.state);
  if (!state) return null;
  const author =
    isRecord(raw.author) && typeof raw.author.login === 'string' ? raw.author.login : '';
  return {
    repo: fallbackRepo,
    number,
    state,
    headSha,
    branch: str(raw.headRefName),
    baseBranch: str(raw.baseRefName),
    author,
    title: str(raw.title),
    body: str(raw.body),
    url: str(raw.url),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    mergedAt: typeof raw.mergedAt === 'string' && raw.mergedAt !== '' ? raw.mergedAt : null,
    files: fileList(raw),
  };
}

function normalizeState(v: unknown): PrState | null {
  if (typeof v !== 'string') return null;
  const s = v.toLowerCase();
  return s === 'open' || s === 'merged' || s === 'closed' ? s : null;
}

interface SearchHit {
  repo: string;
  number: number;
  createdAt: string | null;
}

function parseSearchHits(value: unknown): SearchHit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((h) => {
    if (!isRecord(h) || typeof h.number !== 'number' || !isRecord(h.repository)) return [];
    const repo = h.repository.nameWithOwner;
    const createdAt = typeof h.createdAt === 'string' ? h.createdAt : null;
    return typeof repo === 'string' ? [{ repo, number: h.number, createdAt }] : [];
  });
}

function dedupeHits(hits: SearchHit[]) {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = `${h.repo.toLowerCase()}#${h.number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fileList(raw: unknown): string[] {
  if (!isRecord(raw) || !Array.isArray(raw.files)) return [];
  return raw.files.flatMap((f) => (isRecord(f) && typeof f.path === 'string' ? [f.path] : []));
}

function repoKey(r: string | Pick<RelatedRepo, 'owner' | 'name'>): string {
  return (typeof r === 'string' ? r : `${r.owner}/${r.name}`).toLowerCase();
}

function sameLogin(a: string, b: string): boolean {
  return a !== '' && a.toLowerCase() === b.toLowerCase();
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
