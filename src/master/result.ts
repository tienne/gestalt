import { log } from '../core/log.js';
import { normalizePrRef } from './pr-ref.js';
import {
  isNeedKind,
  isStopReason,
  isWorkerId,
  REPORT_STATUSES,
  type ReportStatus,
  type WorkerReport,
} from './types.js';

/**
 * 워커 결과 검증.
 *
 * 마스터는 요약과 참조만 받는다. diff나 스택 트레이스, 긴 로그가 요약에 섞여 들어오면
 * 그대로 마스터 대화에 쌓여 토큰이 많이 든다. 걸리면 받지 않고 워커에 요약을 다시 달라고
 * 돌려보낸다. 원문은 파일로 두고 경로만 refs에 적으면 된다.
 */

export const MAX_REFS = 20;
export const MAX_REF_CHARS = 500;
/** 요약이 이 줄 수를 넘으면 로그를 붙여 넣은 것으로 본다 */
export const MAX_SUMMARY_LINES = 20;

const RAW_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /^diff --git /m, label: 'diff 헤더' },
  { re: /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m, label: 'diff 덩어리' },
  { re: /^(?:\+\+\+ b\/|--- a\/)/m, label: 'diff 파일 표시' },
  { re: /^\s+at .+[:(]\d+:\d+\)?$/m, label: '스택 트레이스' },
  { re: /Traceback \(most recent call last\)/, label: '스택 트레이스' },
  { re: /^```/m, label: '코드 블록' },
];

export interface SummaryCheck {
  ok: boolean;
  problems: string[];
}

export function checkSummary(summary: string, maxChars: number): SummaryCheck {
  const problems: string[] = [];
  if (!summary.trim()) problems.push('요약이 비었어요');
  if (summary.length > maxChars) {
    problems.push(`요약이 ${summary.length}자라 상한 ${maxChars}자를 넘어요`);
  }
  const lines = summary.split('\n').length;
  if (lines > MAX_SUMMARY_LINES) {
    problems.push(`요약이 ${lines}줄이라 로그로 보여요. ${MAX_SUMMARY_LINES}줄 안으로 줄여 주세요`);
  }
  const seen = new Set<string>();
  for (const { re, label } of RAW_PATTERNS) {
    if (re.test(summary) && !seen.has(label)) {
      seen.add(label);
      problems.push(`요약에 ${label}가 섞였어요. 원문은 파일로 두고 경로만 refs에 적어 주세요`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export class ReportRejected extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`워커 결과를 받지 않았어요:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

/** JSON으로 들어온 결과를 검증해 꼴을 맞춘다. 걸리면 ReportRejected를 던진다 */
export function parseWorkerReport(raw: unknown, maxChars: number): WorkerReport {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReportRejected(['결과가 JSON 객체가 아니에요']);
  }
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];

  const workerId = typeof r['workerId'] === 'string' ? r['workerId'] : '';
  if (!workerId) problems.push('workerId가 없어요');
  else if (!isWorkerId(workerId)) problems.push('workerId는 영문, 숫자, -, _로 64자까지예요');
  const status = r['status'];
  if (typeof status !== 'string' || !(REPORT_STATUSES as readonly string[]).includes(status)) {
    problems.push(`status는 ${REPORT_STATUSES.join(', ')} 중 하나예요`);
  }
  const summary = typeof r['summary'] === 'string' ? r['summary'] : '';
  problems.push(...checkSummary(summary, maxChars).problems);

  const refsRaw = r['refs'] ?? [];
  const refs: string[] = [];
  if (!Array.isArray(refsRaw)) problems.push('refs는 문자열 배열이에요');
  else {
    if (refsRaw.length > MAX_REFS) problems.push(`refs는 ${MAX_REFS}개까지예요`);
    for (const ref of refsRaw) {
      if (
        typeof ref !== 'string' ||
        !ref.trim() ||
        ref.length > MAX_REF_CHARS ||
        ref.includes('\n')
      ) {
        problems.push('refs에는 한 줄짜리 경로나 주소만 적어 주세요');
        break;
      }
      refs.push(ref);
    }
  }

  const report: WorkerReport = { workerId, status: status as ReportStatus, summary, refs };
  if (typeof r['skill'] === 'string' && r['skill'].trim()) report.skill = r['skill'].trim();
  if (typeof r['prRef'] === 'string' && r['prRef'].trim()) {
    // 주문의 prRef는 PR 감시의 중복 판정 키라 꼴이 다르면 같은 PR을 다른 PR로 본다
    const prRef = normalizePrRef(r['prRef']);
    if (prRef) report.prRef = prRef;
    else
      log(`워커 ${workerId} 결과의 prRef를 못 알아봐 버려요: ${r['prRef'].trim().slice(0, 200)}`);
  }
  if (r['merged'] === true) report.merged = true;

  const stop = r['stopReason'];
  if (stop !== undefined) {
    if (typeof stop === 'string' && isStopReason(stop)) report.stopReason = stop;
    else problems.push(`stopReason을 모르겠어요: ${String(stop)}`);
  }
  const need = r['need'];
  if (need !== undefined) {
    const n = need as Record<string, unknown>;
    if (typeof n?.['kind'] === 'string' && isNeedKind(n['kind'])) {
      const detail = typeof n['detail'] === 'string' ? n['detail'] : '';
      problems.push(
        ...checkSummary(detail || '-', maxChars).problems.map((p) => `need.detail: ${p}`),
      );
      report.need = { kind: n['kind'], detail };
    } else problems.push('need.kind를 모르겠어요');
  }
  const spawn = r['spawnRequest'];
  if (spawn !== undefined) {
    const s = spawn as Record<string, unknown>;
    if (typeof s?.['title'] === 'string' && s['title'].trim()) {
      const detail = typeof s['detail'] === 'string' ? s['detail'] : '';
      problems.push(
        ...checkSummary(detail || '-', maxChars).problems.map((p) => `spawnRequest.detail: ${p}`),
      );
      report.spawnRequest = { title: s['title'].trim(), detail };
    } else problems.push('spawnRequest.title이 없어요');
  }

  if (report.status === 'stopped' && !report.stopReason) report.stopReason = 'unknown';
  if (report.status === 'needs' && !report.need)
    problems.push('status가 needs면 need가 있어야 해요');

  if (problems.length > 0) throw new ReportRejected(problems);
  return report;
}
