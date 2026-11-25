import { createHash } from 'node:crypto';
import { formatTime } from './format.js';
import type { Digest, Report, ReportOptions, Segment } from './schema.js';

export const LENGTH_LABEL: Record<ReportOptions['length'], string> = {
  short: '짧게',
  default: '기본',
  long: '길게',
};

export const DIFFICULTY_LABEL: Record<ReportOptions['difficulty'], string> = {
  normal: '보통',
  easy: '쉽게',
};

/**
 * 리포트를 가르는 키. 뷰어 툴바와 merge가 이 값으로 같은 리포트인지 본다.
 * prompt는 그대로 넣으면 길고 HTML 속성에 실리므로 해시 앞 8자만 쓴다
 */
export function reportKey(options: ReportOptions): string {
  const parts = [options.length, options.difficulty, options.lang];
  if (options.range) {
    parts.push(`r${options.range[0]}-${options.range[1]}`);
  }
  if (options.prompt) {
    parts.push(`p${createHash('sha256').update(options.prompt).digest('hex').slice(0, 8)}`);
  }
  return parts.join('-');
}

/** 구간 리포트가 덮어야 하는 문장 번호. startSec이 [시작, 끝)에 드는 문장들이다 */
export function rangeSpan(
  range: readonly [number, number],
  segments: readonly Segment[],
): { from: number; to: number } | null {
  let from = -1;
  let to = -1;
  for (const s of segments) {
    if (s.startSec < range[0] || s.startSec >= range[1]) continue;
    if (from < 0) from = s.i;
    to = s.i;
  }
  return from < 0 ? null : { from, to };
}

/**
 * 분량과 난이도만으로 가려지는 리포트인지 본다. 툴바의 쉽게 보기 토글이 이 리포트끼리 오간다.
 * 구간이나 프롬프트가 붙었거나 첫 리포트와 언어가 다르면 따로 고르는 리포트다
 */
export function isPreset(options: ReportOptions, base: ReportOptions): boolean {
  return !options.range && !options.prompt && options.lang === base.lang;
}

/**
 * 쉽게 보기 토글이 오갈 짝의 자리. 난이도만 반대고 분량, 언어, 구간, 요청이 같아야 짝이라 키로 비교한다. 없으면 -1
 */
export function pairIndex(reports: readonly Report[], i: number): number {
  const options = reports[i]?.options;
  if (!options) return -1;
  const want = reportKey({
    ...options,
    difficulty: options.difficulty === 'easy' ? 'normal' : 'easy',
  });
  return reports.findIndex((r) => reportKey(r.options) === want);
}

/**
 * 처음 볼 리포트. 스킬이 길게와 보통을 바탕으로 만들므로 그 조합을 먼저 찾고 없으면 첫 리포트를 연다.
 * 읽기 렌즈 뷰어는 쉬운 리포트가 기본이라 prefer로 길게와 쉽게를 먼저 찾고 없으면 보통으로 돌아간다.
 * 카드를 붙일 리포트를 고르는 자리(attach)는 보통 리포트를 봐야 해서 prefer를 넘기지 않는다
 */
export function initialReportIndex(
  reports: readonly Report[],
  prefer: ReportOptions['difficulty'] = 'normal',
): number {
  const base = reports[0]?.options;
  if (!base) return 0;
  const find = (difficulty: ReportOptions['difficulty']) =>
    reports.findIndex(
      (r) =>
        isPreset(r.options, base) &&
        r.options.length === 'long' &&
        r.options.difficulty === difficulty,
    );
  const preferred = find(prefer);
  if (preferred >= 0) return preferred;
  const normal = find('normal');
  return normal >= 0 ? normal : 0;
}

export function reportLabel(options: ReportOptions, withHours = false): string {
  const parts = [`${LENGTH_LABEL[options.length]}, ${DIFFICULTY_LABEL[options.difficulty]}`];
  if (options.range) {
    parts.push(
      `${formatTime(options.range[0], withHours)}~${formatTime(options.range[1], withHours)}`,
    );
  }
  parts.push(options.lang);
  if (options.prompt) parts.push('요청 반영');
  return parts.join(' / ');
}

export function findReport(digest: Digest, key: string): Report | undefined {
  return digest.reports.find((r) => reportKey(r.options) === key);
}

/** 같은 키의 리포트가 있으면 그 자리에 바꿔 끼우고 없으면 뒤에 붙인다 */
export function upsertReport(
  digest: Digest,
  report: Report,
): { digest: Digest; replaced: boolean } {
  const key = reportKey(report.options);
  const at = digest.reports.findIndex((r) => reportKey(r.options) === key);
  const reports = [...digest.reports];
  if (at >= 0) reports[at] = report;
  else reports.push(report);
  return { digest: { ...digest, reports }, replaced: at >= 0 };
}
