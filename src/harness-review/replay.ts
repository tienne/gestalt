import { COLLECT_BACKENDS, type CollectBackend } from './collect.js';
import { REFERENCE_CANDIDATE_KINDS } from './types.js';

/**
 * 과거 하네스 PR 재현 스크립트(scripts/local/replay-harness-prs.ts)의 순수 로직.
 *
 * 스크립트는 사내 레포를 다루므로 gitignore 자리에 두고 커밋하지 않는다. 테스트가 그 경로를
 * import하면 CI에서 파일이 없어 깨지니 인자 해석과 리포트 조립만 여기로 뺐다. 이 모듈은
 * 측정값을 표로 옮길 뿐 합격이나 불합격을 가르지 않는다. 기준 수치는 첫 측정을 본 뒤에 정한다.
 */

export const DEFAULT_OLD_VERSION = '0.83.2';

/**
 * 새 버전 칸의 이름. package.json 버전은 배포 전까지 옛 버전과 같은 번호라 커밋으로 가른다.
 * 미커밋 변경이 있으면 그 커밋과도 다른 코드가 돈 것이라 따로 적는다.
 */
export function checkoutLabel(shortSha: string | null, dirty = false): string {
  const parts = [shortSha ?? '커밋 모름', ...(dirty ? ['미커밋 변경 포함'] : [])];
  return `현재 체크아웃(${parts.join(', ')})`;
}

export interface ReplayArgs {
  prList: string;
  repoDir: string;
  oldVersion: string;
  repeat: number;
  backend: CollectBackend;
  /** collect의 `--repo-dir`로 그대로 넘긴다 (`owner/name=<path>` 또는 `<path>`) */
  relatedDirs: string[];
  /** 리뷰 리포트를 만드는 셸 명령. 없으면 collect 후보만 잰다 */
  reviewCmd: string | null;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const REPLAY_USAGE = [
  'usage: tsx scripts/local/replay-harness-prs.ts --pr-list <file> [options]',
  '  --pr-list <file>        재현할 PR 목록 JSON (로컬 전용)',
  '  --repo-dir <path>       PR이 있는 레포 체크아웃 (기본: 현재 디렉토리)',
  `  --old-version <ver>     비교할 배포 버전 (기본: ${DEFAULT_OLD_VERSION})`,
  '  --repeat <n>            버전마다 돌릴 횟수 (기본: 3)',
  '  --backend local|github  역방향 검색 백엔드 (기본: local)',
  '  --related-dir <spec>    collect --repo-dir로 넘길 관련 레포 (여러 번)',
  '  --review-cmd <shell>    워크트리에서 돌릴 리뷰 명령. $GESTALT_REPLAY_OUT에 JSON을 쓴다',
].join('\n');

function isPositiveInteger(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

export function parseReplayArgs(argv: string[], cwd: string): ParseResult<ReplayArgs> {
  const args: ReplayArgs = {
    prList: '',
    repoDir: cwd,
    oldVersion: DEFAULT_OLD_VERSION,
    repeat: 3,
    backend: 'local',
    relatedDirs: [],
    reviewCmd: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--help' || flag === '-h') return { ok: false, error: REPLAY_USAGE };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, error: `${flag} 뒤에 값이 없다` };
    }
    i++;
    switch (flag) {
      case '--pr-list':
        args.prList = value;
        break;
      case '--repo-dir':
        args.repoDir = value;
        break;
      case '--old-version':
        if (!/^\d+\.\d+\.\d+([-.][\w.]+)?$/.test(value)) {
          return { ok: false, error: `--old-version은 x.y.z 꼴이어야 한다: ${value}` };
        }
        args.oldVersion = value;
        break;
      case '--repeat':
        if (!isPositiveInteger(value)) {
          return { ok: false, error: `--repeat는 1 이상의 정수다: ${value}` };
        }
        args.repeat = Number(value);
        break;
      case '--backend':
        if (!(COLLECT_BACKENDS as readonly string[]).includes(value)) {
          return {
            ok: false,
            error: `--backend는 ${COLLECT_BACKENDS.join('|')} 중 하나다: ${value}`,
          };
        }
        args.backend = value as CollectBackend;
        break;
      case '--related-dir':
        args.relatedDirs.push(value);
        break;
      case '--review-cmd':
        args.reviewCmd = value;
        break;
      default:
        return { ok: false, error: `모르는 옵션: ${flag}` };
    }
  }
  if (!args.prList) return { ok: false, error: '--pr-list가 필요하다' };
  return { ok: true, value: args };
}

/** fix가 따라온 PR에서 리뷰가 잡았어야 하는 자리 하나 */
export interface ReplayExpectation {
  id: string;
  description: string;
  /** 코멘트가 달린 파일이나 후보가 가리키는 파일 중 하나와 같아야 한다 */
  path?: string;
  line?: number;
  /** 줄 번호를 몇 줄까지 어긋나도 같은 자리로 볼지. 없으면 정확히 같아야 한다 */
  lineTolerance?: number;
  /** 코멘트 본문에 들어 있어야 하는 글자 */
  text?: string;
}

export interface ReplayEntry {
  id: string;
  pr: number | null;
  /** `gh pr view --repo`로 넘긴다. 없으면 레포 디렉토리의 원격을 따른다 */
  repo: string | null;
  base: string | null;
  head: string | null;
  followedByFix: boolean;
  expected: ReplayExpectation[];
  note: string | null;
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

// git 인자로 들어가므로 옵션처럼 읽히는 값을 막는다
function isSafeRev(value: string): boolean {
  return value.length > 0 && !value.startsWith('-') && !/\s/.test(value);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function optionalString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function parseExpectation(raw: unknown, where: string): ParseResult<ReplayExpectation> {
  const r = asRecord(raw);
  if (!r) return { ok: false, error: `${where}: 객체가 아니다` };
  const id = optionalString(r.id);
  if (!id) return { ok: false, error: `${where}: id가 필요하다` };
  const exp: ReplayExpectation = { id, description: optionalString(r.description) ?? id };
  const path = optionalString(r.path);
  if (path) exp.path = path;
  const text = optionalString(r.text);
  if (text) exp.text = text;
  if (r.line !== undefined) {
    if (!Number.isInteger(r.line) || (r.line as number) < 1) {
      return { ok: false, error: `${where}: line은 1 이상의 정수다` };
    }
    exp.line = r.line as number;
  }
  if (r.lineTolerance !== undefined) {
    if (!Number.isInteger(r.lineTolerance) || (r.lineTolerance as number) < 0) {
      return { ok: false, error: `${where}: lineTolerance는 0 이상의 정수다` };
    }
    exp.lineTolerance = r.lineTolerance as number;
  }
  if (!exp.path && !exp.text) {
    return { ok: false, error: `${where}: path나 text 중 하나는 있어야 맞춰볼 수 있다` };
  }
  return { ok: true, value: exp };
}

/**
 * PR 목록 파일을 읽는다. 배열이거나 `{ "entries": [...] }`다.
 *
 * 항목마다 `pr`(번호) 또는 `base`와 `head`(커밋)가 있어야 한다. `followedByFix`를 안 적으면
 * `expected`가 있는지로 정한다.
 */
export function parseReplayList(text: string): ParseResult<ReplayEntry[]> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `PR 목록이 JSON이 아니다: ${(e as Error).message}` };
  }
  const list = Array.isArray(json) ? json : asRecord(json)?.entries;
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, error: 'PR 목록이 비었다 (배열 또는 { "entries": [...] })' };
  }
  const entries: ReplayEntry[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of list.entries()) {
    const where = `entries[${i}]`;
    const r = asRecord(raw);
    if (!r) return { ok: false, error: `${where}: 객체가 아니다` };

    let pr: number | null = null;
    if (r.pr !== undefined) {
      if (!Number.isInteger(r.pr) || (r.pr as number) < 1) {
        return { ok: false, error: `${where}: pr은 1 이상의 정수다` };
      }
      pr = r.pr as number;
    }
    const repo = optionalString(r.repo);
    if (repo && !REPO_PATTERN.test(repo)) {
      return { ok: false, error: `${where}: repo는 owner/name 꼴이다: ${repo}` };
    }
    const base = optionalString(r.base);
    const head = optionalString(r.head);
    for (const [name, rev] of [
      ['base', base],
      ['head', head],
    ] as const) {
      if (rev !== null && !isSafeRev(rev)) {
        return { ok: false, error: `${where}: ${name}에 쓸 수 없는 값: ${rev}` };
      }
    }
    if (pr === null && (base === null || head === null)) {
      return { ok: false, error: `${where}: pr이 없으면 base와 head가 둘 다 필요하다` };
    }

    const expected: ReplayExpectation[] = [];
    if (r.expected !== undefined) {
      if (!Array.isArray(r.expected)) return { ok: false, error: `${where}: expected는 배열이다` };
      for (const [j, e] of r.expected.entries()) {
        const parsed = parseExpectation(e, `${where}.expected[${j}]`);
        if (!parsed.ok) return parsed;
        expected.push(parsed.value);
      }
    }
    let followedByFix = expected.length > 0;
    if (r.followedByFix !== undefined) {
      if (typeof r.followedByFix !== 'boolean') {
        return { ok: false, error: `${where}: followedByFix는 true나 false다` };
      }
      followedByFix = r.followedByFix;
    }

    const id =
      optionalString(r.id) ??
      (pr !== null ? `pr-${pr}` : `${base!.slice(0, 7)}..${head!.slice(0, 7)}`);
    if (seen.has(id)) return { ok: false, error: `${where}: id가 겹친다: ${id}` };
    seen.add(id);
    entries.push({
      id,
      pr,
      repo,
      base,
      head,
      followedByFix,
      expected,
      note: optionalString(r.note),
    });
  }
  return { ok: true, value: entries };
}

export type ReplayCommentSource = 'collect' | 'review';

/** 한 회차가 낸 코멘트 하나. collect 후보와 리뷰 리포트 이슈를 같은 모양으로 맞춘다 */
export interface ReplayComment {
  source: ReplayCommentSource;
  kind: string;
  path: string;
  line: number | null;
  /** 후보가 가리키는 다른 자리. 리뷰 코멘트면 null */
  relatedPath: string | null;
  /** relatedPath 안의 줄. 후보가 줄을 안 주면 null */
  relatedLine: number | null;
  body: string;
}

function lineOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

/** `gestalt harness-refs collect --json` 출력에서 후보를 꺼낸다. 모양이 다르면 빈 배열이다 */
export function commentsFromCollect(json: unknown): ReplayComment[] {
  const candidates = asRecord(asRecord(json)?.candidates);
  if (!candidates) return [];
  const out: ReplayComment[] = [];
  for (const kind of REFERENCE_CANDIDATE_KINDS) {
    const list = candidates[kind];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const c = asRecord(raw);
      if (!c) continue;
      const targetRepo = optionalString(c.targetRepo);
      const targetPath = optionalString(c.targetPath);
      const target = [targetRepo, targetPath].filter(Boolean).join(':');
      out.push({
        source: 'collect',
        kind,
        path: optionalString(c.sourceFile) ?? '',
        line: lineOf(c.sourceLine),
        relatedPath: targetPath,
        relatedLine: lineOf(c.targetLine),
        body: [target, optionalString(c.matchedText)].filter(Boolean).join(' — '),
      });
    }
  }
  return out;
}

/**
 * 리뷰 명령이 쓴 JSON에서 코멘트를 꺼낸다.
 *
 * ReviewIssue 배열, `{ issues }`나 `{ comments }`, ReviewResult 배열 중 무엇이든 받는다.
 * 이 텍스트는 세어서 표에 옮길 뿐 재현 절차에 영향을 주지 않는다.
 */
export function commentsFromReview(json: unknown): ReplayComment[] {
  const items: unknown[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    const r = asRecord(v);
    if (!r) return;
    const nested = r.issues ?? r.comments ?? r.findings;
    if (Array.isArray(nested)) {
      visit(nested);
      return;
    }
    items.push(r);
  };
  visit(json);

  const out: ReplayComment[] = [];
  for (const raw of items) {
    const r = raw as Record<string, unknown>;
    const body =
      optionalString(r.message) ??
      optionalString(r.body) ??
      optionalString(r.comment) ??
      optionalString(r.description);
    if (!body) continue;
    out.push({
      source: 'review',
      kind:
        optionalString(r.category) ??
        optionalString(r.kind) ??
        optionalString(r.reportedBy) ??
        'review',
      path: optionalString(r.file) ?? optionalString(r.path) ?? '',
      line: lineOf(r.line) ?? lineOf(r.startLine),
      relatedPath: null,
      relatedLine: null,
      body,
    });
  }
  return out;
}

/** 회차를 넘어 같은 코멘트로 묶을 때 쓰는 키. 본문 공백 차이는 무시한다 */
export function commentFingerprint(c: ReplayComment): string {
  return [c.source, c.kind, c.path, c.line ?? '', c.body.replace(/\s+/g, ' ').trim()].join('|');
}

// 옛 버전에도 있던 코멘트인지 볼 때 쓴다. LLM 리뷰는 회차마다 문장이 달라지니 본문은 뺀다
function commentPlace(c: ReplayComment): string {
  return [c.source, c.kind, c.path, c.line ?? ''].join('|');
}

// 자기오염 후보는 룰 자리(path)와 오염된 자리(relatedPath)를 함께 든다.
// 기대 항목은 대개 오염된 자리를 적으므로 줄 번호도 그 자리의 줄과 맞춰 본다
export function matchesExpectation(c: ReplayComment, e: ReplayExpectation): boolean {
  const places = [{ path: c.path, line: c.line }];
  if (c.relatedPath) places.push({ path: c.relatedPath, line: c.relatedLine });
  const placed = places.some(
    (p) =>
      (e.path === undefined || p.path === e.path) &&
      (e.line === undefined ||
        (p.line !== null && Math.abs(p.line - e.line) <= (e.lineTolerance ?? 0))),
  );
  if (!placed) return false;
  if (e.text !== undefined && !c.body.includes(e.text)) return false;
  return true;
}

export const STEP_STATUSES = ['ok', 'unsupported', 'failed', 'skipped'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface ReplayStep {
  status: StepStatus;
  detail?: string;
}

export type ReplayVersion = 'old' | 'new';

export interface ReplayRun {
  version: ReplayVersion;
  iteration: number;
  collect: ReplayStep & { referenceCheckSkipped?: boolean; lookupBlocked?: number };
  review: ReplayStep;
  comments: ReplayComment[];
}

export interface ReplayEntryResult {
  entry: ReplayEntry;
  base: string | null;
  head: string | null;
  /** base와 head를 못 구했거나 워크트리를 못 만든 경우. 이때 runs는 비어 있다 */
  error: string | null;
  runs: ReplayRun[];
}

export interface ReplayReportInput {
  runId: string;
  createdAt: string;
  repoLabel: string;
  backend: CollectBackend;
  repeat: number;
  reviewCmdGiven: boolean;
  versions: Record<ReplayVersion, string>;
  results: ReplayEntryResult[];
}

export interface VersionSummary {
  counts: number[];
  mean: number | null;
  notes: string[];
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

function stepNote(label: string, runs: ReplayRun[], pick: (r: ReplayRun) => ReplayStep): string[] {
  const notes: string[] = [];
  for (const status of ['unsupported', 'failed', 'skipped'] as const) {
    const hit = runs.filter((r) => pick(r).status === status);
    if (hit.length === 0) continue;
    const word = { unsupported: '명령 없음', failed: '실패', skipped: '안 돌림' }[status];
    notes.push(`${label} ${word} ${hit.length}/${runs.length}회`);
  }
  return notes;
}

export function summarizeVersion(runs: ReplayRun[], version: ReplayVersion): VersionSummary {
  const mine = runs.filter((r) => r.version === version).sort((a, b) => a.iteration - b.iteration);
  const counts = mine.map((r) => r.comments.length);
  const notes = [
    ...stepNote('collect', mine, (r) => r.collect),
    ...stepNote('리뷰', mine, (r) => r.review),
  ];
  const skippedRefs = mine.filter((r) => r.collect.referenceCheckSkipped).length;
  if (skippedRefs > 0) notes.push(`참조 검사 일부 못 봄 ${skippedRefs}/${mine.length}회`);
  return { counts, mean: mean(counts), notes };
}

function formatMean(v: number | null): string {
  return v === null ? '-' : v.toFixed(1);
}

function formatDiff(oldMean: number | null, newMean: number | null): string {
  if (oldMean === null || newMean === null) return '-';
  const d = newMean - oldMean;
  return `${d > 0 ? '+' : ''}${d.toFixed(1)}`;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function rangeLabel(r: ReplayEntryResult): string {
  if (!r.base || !r.head) return '-';
  return `\`${r.base.slice(0, 7)}..${r.head.slice(0, 7)}\``;
}

function countsCell(s: VersionSummary): string {
  if (s.counts.length === 0) return '-';
  return `${s.counts.join(', ')} (평균 ${formatMean(s.mean)})`;
}

export interface ExpectationHits {
  expectation: ReplayExpectation;
  hits: Record<ReplayVersion, { runs: number; total: number }>;
}

export function expectationHits(result: ReplayEntryResult): ExpectationHits[] {
  return result.entry.expected.map((expectation) => {
    const hits = {} as ExpectationHits['hits'];
    for (const version of ['old', 'new'] as const) {
      const mine = result.runs.filter((r) => r.version === version);
      hits[version] = {
        runs: mine.filter((r) => r.comments.some((c) => matchesExpectation(c, expectation))).length,
        total: mine.length,
      };
    }
    return { expectation, hits };
  });
}

/** 측정 리포트 본문. 숫자와 회차별 상태만 적고 통과 여부는 적지 않는다 */
export function buildReplayReport(input: ReplayReportInput): string {
  const { versions } = input;
  const lines: string[] = [
    `# 하네스 PR 재현 리포트 (${input.runId})`,
    '',
    `- 레포: ${input.repoLabel}`,
    `- 만든 시각: ${input.createdAt}`,
    `- 비교: ${versions.old} (옛 버전) / ${versions.new}`,
    `- 버전마다 ${input.repeat}회, 역방향 검색 백엔드 ${input.backend}`,
    `- 리뷰 명령: ${input.reviewCmdGiven ? '돌림' : '안 줌. collect 후보만 셌다'}`,
    '- GitHub에는 아무것도 게시하지 않았다. 판정 기준 수치는 아직 정하지 않았으므로 측정값만 싣는다.',
    '',
  ];

  const failed = input.results.filter((r) => r.error);
  const clean = input.results.filter((r) => !r.error && !r.entry.followedByFix);
  const fixed = input.results.filter((r) => !r.error && r.entry.followedByFix);

  lines.push('## fix가 안 따라온 PR', '');
  if (clean.length === 0) {
    lines.push('없음', '');
  } else {
    lines.push(
      `| 항목 | 범위 | ${versions.old} 코멘트 수 | ${versions.new} 코멘트 수 | 평균 차이 | 비고 |`,
      '|---|---|---|---|---|---|',
    );
    for (const r of clean) {
      const o = summarizeVersion(r.runs, 'old');
      const n = summarizeVersion(r.runs, 'new');
      const notes = [
        ...o.notes.map((x) => `${versions.old} ${x}`),
        ...n.notes.map((x) => `${versions.new} ${x}`),
      ];
      lines.push(
        `| ${cell(r.entry.id)} | ${rangeLabel(r)} | ${countsCell(o)} | ${countsCell(n)} | ${formatDiff(o.mean, n.mean)} | ${cell(notes.join('; ') || '-')} |`,
      );
    }
    lines.push('');
  }

  lines.push('## fix가 따라온 PR', '');
  if (fixed.length === 0) {
    lines.push('없음', '');
  }
  for (const r of fixed) {
    const o = summarizeVersion(r.runs, 'old');
    const n = summarizeVersion(r.runs, 'new');
    const hits = expectationHits(r);
    lines.push(`### ${r.entry.id} ${rangeLabel(r)}`, '');
    if (r.entry.note) lines.push(`${r.entry.note}`, '');
    lines.push(
      `- 코멘트 수: ${versions.old} ${countsCell(o)} / ${versions.new} ${countsCell(n)} / 평균 차이 ${formatDiff(o.mean, n.mean)}`,
    );
    for (const x of [
      ...o.notes.map((y) => `${versions.old} ${y}`),
      ...n.notes.map((y) => `${versions.new} ${y}`),
    ]) {
      lines.push(`- ${x}`);
    }
    for (const version of ['old', 'new'] as const) {
      const caught = hits.filter((h) => h.hits[version].runs > 0).length;
      lines.push(
        `- ${versions[version]}: 한 번이라도 잡은 항목 ${caught}개, 한 번도 못 잡은 항목 ${hits.length - caught}개`,
      );
    }
    lines.push('');
    if (hits.length > 0) {
      lines.push(
        `| 기대 항목 | 설명 | 자리 | ${versions.old} 잡은 회차 | ${versions.new} 잡은 회차 |`,
        '|---|---|---|---|---|',
      );
      for (const h of hits) {
        const e = h.expectation;
        const place = [
          e.path,
          e.line !== undefined ? `:${e.line}` : '',
          e.text ? ` "${e.text}"` : '',
        ]
          .join('')
          .trim();
        lines.push(
          `| ${cell(e.id)} | ${cell(e.description)} | ${cell(place || '-')} | ${h.hits.old.runs}/${h.hits.old.total} | ${h.hits.new.runs}/${h.hits.new.total} |`,
        );
      }
      lines.push('');
    }
  }

  if (failed.length > 0) {
    lines.push('## 재현하지 못한 항목', '');
    for (const r of failed) lines.push(`- ${r.entry.id}: ${r.error}`);
    lines.push('');
  }
  return lines.join('\n');
}

export interface LabelItem {
  entryId: string;
  comment: ReplayComment;
  /** 새 버전 회차 중 이 코멘트가 나온 횟수 */
  seenRuns: number;
  totalRuns: number;
  inOldVersion: boolean;
}

/** 새 버전이 낸 코멘트를 회차를 넘어 중복 없이 모은다 */
export function collectLabelItems(results: ReplayEntryResult[]): LabelItem[] {
  const items: LabelItem[] = [];
  for (const r of results) {
    const newRuns = r.runs.filter((x) => x.version === 'new');
    const oldPlaces = new Set(
      r.runs.filter((x) => x.version === 'old').flatMap((x) => x.comments.map(commentPlace)),
    );
    const byFp = new Map<string, LabelItem>();
    for (const run of newRuns) {
      const seenThisRun = new Set<string>();
      for (const c of run.comments) {
        const fp = commentFingerprint(c);
        if (seenThisRun.has(fp)) continue;
        seenThisRun.add(fp);
        const found = byFp.get(fp);
        if (found) {
          found.seenRuns++;
          continue;
        }
        byFp.set(fp, {
          entryId: r.entry.id,
          comment: c,
          seenRuns: 1,
          totalRuns: newRuns.length,
          inOldVersion: oldPlaces.has(commentPlace(c)),
        });
      }
    }
    items.push(...byFp.values());
  }
  return items;
}

export const LABEL_PREFIX = 'label:';

/** 사용자가 코멘트마다 correct나 incorrect를 적는 시트 */
export function buildLabelSheet(input: ReplayReportInput): string {
  const items = collectLabelItems(input.results.filter((r) => !r.error));
  const lines: string[] = [
    `# 새 버전 코멘트 라벨 (${input.runId})`,
    '',
    `각 코멘트의 \`${LABEL_PREFIX}\` 뒤에 \`correct\`나 \`incorrect\`를 적는다. 모르면 비워둔다.`,
    `${input.versions.new}가 낸 코멘트를 회차를 넘어 하나로 묶었다. 모두 ${items.length}개.`,
    '',
  ];
  items.forEach((item, i) => {
    const c = item.comment;
    const place = `${c.path || '(파일 없음)'}${c.line !== null ? `:${c.line}` : ''}`;
    lines.push(
      `## ${i + 1}. ${item.entryId} \`${place}\``,
      '',
      `- 종류: ${c.source} / ${c.kind}`,
      `- 나온 회차: ${item.seenRuns}/${item.totalRuns}`,
      `- ${input.versions.old}에도 같은 자리: ${item.inOldVersion ? '예' : '아니오'}`,
      '',
      ...c.body.split(/\r?\n/).map((l) => `> ${l}`),
      '',
      `${LABEL_PREFIX} `,
      '',
    );
  });
  return lines.join('\n');
}

const GH_READ_ONLY: Record<string, readonly string[] | null> = {
  auth: ['status'],
  search: null,
  pr: ['view', 'list', 'diff', 'checks', 'status'],
  repo: ['view', 'list'],
  issue: ['view', 'list'],
  api: null,
};

const GH_API_WRITE_FLAGS = ['-f', '-F', '--field', '--raw-field', '--input'];

/**
 * 재현 중 자식 프로세스가 부르는 gh가 읽기만 하는지 본다.
 *
 * 리뷰 명령이 review 스킬을 돌리면 PR 대상일 때 코멘트를 게시하려 한다. 재현은 게시 없이
 * 리포트만 내야 하므로 스크립트가 PATH 앞에 둔 gh 가림막이 이 함수로 쓰기 호출을 끊는다.
 */
export function isReadOnlyGhCall(args: string[]): boolean {
  const [group, sub] = args;
  if (group === undefined || !(group in GH_READ_ONLY)) return false;
  const allowed = GH_READ_ONLY[group];
  if (allowed && (sub === undefined || !allowed.includes(sub))) return false;
  if (group !== 'api') return true;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (GH_API_WRITE_FLAGS.some((f) => a === f || a.startsWith(`${f}=`))) return false;
    if (a === '-X' || a === '--method') {
      if ((args[i + 1] ?? '').toUpperCase() !== 'GET') return false;
    } else if (
      /^(-X|--method=)/.test(a) &&
      a.replace(/^(-X|--method=)/, '').toUpperCase() !== 'GET'
    ) {
      return false;
    }
  }
  return true;
}
