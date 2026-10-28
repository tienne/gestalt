/**
 * Resolution Calibration — 해상도 점수 구간과 서버 신호별 결과 표
 *
 * docs/proposals/resolution-calibration.md 파트 4. 기준값을 넘긴 스펙들 사이에서
 * 무엇이 나쁜 결과(rough)를 미리 알려주는지 보려고 표 두 장을 만든다.
 *
 * Usage:
 *   pnpm tsx benchmarks/resolution-calibration.ts <outcomes.csv>
 *
 * 입력 CSV 형식:
 *   첫 줄은 헤더다. 스펙 한 줄에 한 행이고 열은 이름으로 찾으므로 순서는 상관없다.
 *   outcome-feedback(`gestalt outcome export --format csv`)이 내는 열 뒤에 이 제안의 열을 붙인다.
 *
 *   outcome-feedback 열:
 *     spec_id, created_at, source_type, resolution_score, interview_rounds, evolve_generations,
 *     human_gates, first_score, final_score, goal_alignment, termination_reason, link_method,
 *     link_confidence, review_source, review_rounds, review_threads, changes_requested,
 *     unresolved_at_merge, revert_commits, fixup_commits, touching_commits, churn_ratio,
 *     window_days, status
 *   이 제안이 더하는 열 (인터뷰 없이 텍스트로 만든 스펙은 전부 빈 칸):
 *     answered_rounds, empty_rounds, deferred_rounds, unasked_confident_dims, overall_jump_max,
 *     contradictions, rescore_mode, rescore_overall, rescore_spread, threshold
 *
 *   이 스크립트가 실제로 읽는 열은 REQUIRED_COLUMNS다. 하나라도 없으면 멈춘다.
 *   빈 칸은 값이 없다는 뜻이다. threshold가 비면 기본 기준값 0.8로 본다.
 *   resolution_score가 빈 행(텍스트 스펙)과 status가 final이 아닌 행은 표에서 뺀다.
 *   pending 행은 재작업 수치가 아직 덜 쌓여 rough 비율을 낮춰 보이게 해서다.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_COLUMNS = [
  'resolution_score',
  'threshold',
  'status',
  'review_rounds',
  'revert_commits',
  'fixup_commits',
  'human_gates',
  'evolve_generations',
  'unasked_confident_dims',
  'deferred_rounds',
  'rescore_spread',
  'overall_jump_max',
] as const;

/** 칸 하나에 스펙이 이보다 적으면 결론을 내지 않는다 */
export const MIN_SAMPLE = 20;
const DEFAULT_THRESHOLD = 0.8;

export type CsvRow = Record<string, string>;

export interface OutcomeRow {
  resolutionScore: number;
  threshold: number;
  reviewRounds: number | null;
  reworkCommits: number;
  rough: boolean;
  unaskedConfidentDims: number | null;
  deferredRounds: number | null;
  rescoreSpread: number | null;
  overallJumpMax: number | null;
}

/** 따옴표로 감싼 칸과 칸 안의 `""`, 쉼표, 줄바꿈을 받는다 */
export function parseCsv(text: string): CsvRow[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((r) => r.some((cell) => cell.trim() !== ''));
  const header = nonEmpty[0]?.map((h) => h.trim()) ?? [];
  return nonEmpty
    .slice(1)
    .map((cells) => Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()])));
}

function num(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** outcome-feedback의 rough 정의: 리뷰 3라운드, 재작업 커밋 1개, 사람 게이트 1번, evolve 2세대 중 하나 */
export function isRough(row: CsvRow): boolean {
  const rework = (num(row.revert_commits) ?? 0) + (num(row.fixup_commits) ?? 0);
  return (
    (num(row.review_rounds) ?? 0) >= 3 ||
    rework >= 1 ||
    (num(row.human_gates) ?? 0) >= 1 ||
    (num(row.evolve_generations) ?? 0) >= 2
  );
}

export interface Selection {
  rows: OutcomeRow[];
  withoutScore: number;
  notFinal: number;
}

export function selectRows(csv: CsvRow[]): Selection {
  const first = csv[0];
  if (first) {
    const missing = REQUIRED_COLUMNS.filter((c) => !(c in first));
    if (missing.length > 0) throw new Error(`CSV에 열이 없습니다: ${missing.join(', ')}`);
  }

  const rows: OutcomeRow[] = [];
  let withoutScore = 0;
  let notFinal = 0;
  for (const row of csv) {
    const resolutionScore = num(row.resolution_score);
    if (resolutionScore === null) {
      withoutScore++;
      continue;
    }
    if (row.status !== 'final') {
      notFinal++;
      continue;
    }
    rows.push({
      resolutionScore,
      threshold: num(row.threshold) ?? DEFAULT_THRESHOLD,
      reviewRounds: num(row.review_rounds),
      reworkCommits: (num(row.revert_commits) ?? 0) + (num(row.fixup_commits) ?? 0),
      rough: isRough(row),
      unaskedConfidentDims: num(row.unasked_confident_dims),
      deferredRounds: num(row.deferred_rounds),
      rescoreSpread: num(row.rescore_spread),
      overallJumpMax: num(row.overall_jump_max),
    });
  }
  return { rows, withoutScore, notFinal };
}

export const SCORE_BANDS = [
  'force (< 기준값)',
  '기준값 ~ 0.85',
  '0.85 ~ 0.90',
  '0.90 이상',
] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];

/** 기준값은 행마다 남은 값으로 가른다. 설정을 바꾼 스펙도 그때의 기준으로 force를 판정한다 */
export function scoreBand(row: OutcomeRow): ScoreBand {
  if (row.resolutionScore < row.threshold) return 'force (< 기준값)';
  if (row.resolutionScore < 0.85) return '기준값 ~ 0.85';
  if (row.resolutionScore < 0.9) return '0.85 ~ 0.90';
  return '0.90 이상';
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function roughRatio(rows: OutcomeRow[]): string {
  if (rows.length === 0) return '-';
  const pct = ((rows.filter((r) => r.rough).length / rows.length) * 100).toFixed(1);
  return `${pct}%`;
}

function short(rows: OutcomeRow[]): string {
  return rows.length < MIN_SAMPLE ? ' 표본 부족' : '';
}

function fmt(value: number | null, digits: number): string {
  return value === null ? '-' : value.toFixed(digits);
}

export function bandTable(rows: OutcomeRow[]): string {
  const lines = [
    '| 해상도 구간 | 스펙 수 | rough 비율 | 리뷰 라운드 중앙값 | 재작업 커밋 평균 |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const band of SCORE_BANDS) {
    const inBand = rows.filter((r) => scoreBand(r) === band);
    const reviews = inBand.map((r) => r.reviewRounds).filter((v): v is number => v !== null);
    const rework =
      inBand.length === 0
        ? null
        : inBand.reduce((sum, r) => sum + r.reworkCommits, 0) / inBand.length;
    lines.push(
      `| ${band} | ${inBand.length} | ${roughRatio(inBand)}${short(inBand)} | ${fmt(median(reviews), 1)} | ${fmt(rework, 2)} |`,
    );
  }
  return lines.join('\n');
}

interface SignalSplit {
  name: string;
  labelA: string;
  labelB: string;
  value: (row: OutcomeRow) => number | null;
  isB: (value: number) => boolean;
}

export const SIGNAL_SPLITS: SignalSplit[] = [
  {
    name: '안 물은 차원',
    labelA: '없음',
    labelB: '1개 이상',
    value: (r) => r.unaskedConfidentDims,
    isB: (v) => v >= 1,
  },
  {
    name: '위임 답변',
    labelA: '0',
    labelB: '1 이상',
    value: (r) => r.deferredRounds,
    isB: (v) => v >= 1,
  },
  {
    name: '다시 채점 흔들림',
    labelA: '0.2 이하',
    labelB: '0.2 초과',
    value: (r) => r.rescoreSpread,
    isB: (v) => v > 0.2,
  },
  {
    name: 'overall 점프',
    labelA: '0.3 이하',
    labelB: '0.3 초과',
    value: (r) => r.overallJumpMax,
    isB: (v) => v > 0.3,
  },
];

function signalCell(rows: OutcomeRow[]): string {
  return `${roughRatio(rows)} (${rows.length})${short(rows)}`;
}

/** 신호 값이 빈 행은 어느 칸에도 안 넣는다. 다시 채점을 안 받은 스펙이 흔들림 0으로 섞이면 안 돼서다 */
export function signalTable(rows: OutcomeRow[]): string {
  const lines = [
    '| 신호 | 칸 A | 칸 A rough 비율 (n) | 칸 B | 칸 B rough 비율 (n) |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const split of SIGNAL_SPLITS) {
    const a: OutcomeRow[] = [];
    const b: OutcomeRow[] = [];
    for (const row of rows) {
      const v = split.value(row);
      if (v === null) continue;
      (split.isB(v) ? b : a).push(row);
    }
    lines.push(
      `| ${split.name} | ${split.labelA} | ${signalCell(a)} | ${split.labelB} | ${signalCell(b)} |`,
    );
  }
  return lines.join('\n');
}

export function buildReport(csv: CsvRow[]): string {
  const { rows, withoutScore, notFinal } = selectRows(csv);
  const noRescore = rows.filter((r) => r.rescoreSpread === null).length;
  return [
    '## 해상도 구간별',
    '',
    bandTable(rows),
    '',
    '## 신호별',
    '',
    signalTable(rows),
    '',
    `표에 넣은 스펙 ${rows.length}개 중 다시 채점을 안 받은 스펙은 ${noRescore}개다. ` +
      `해상도 점수가 없는 행 ${withoutScore}개와 status가 final이 아닌 행 ${notFinal}개는 뺐다. ` +
      `n이 ${MIN_SAMPLE} 미만인 칸은 표본 부족이라 결론을 내지 않는다.`,
    '',
  ].join('\n');
}

const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write('Usage: pnpm tsx benchmarks/resolution-calibration.ts <outcomes.csv>\n');
    process.exit(1);
  }
  process.stdout.write(buildReport(parseCsv(readFileSync(path, 'utf-8'))));
}
