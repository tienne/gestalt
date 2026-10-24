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
 * 툴바의 분량과 난이도 버튼으로 고를 수 있는 리포트인지 본다.
 * 구간이나 프롬프트가 붙었거나 첫 리포트와 언어가 다르면 따로 고르는 리포트다
 */
export function isPreset(options: ReportOptions, base: ReportOptions): boolean {
  return !options.range && !options.prompt && options.lang === base.lang;
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
