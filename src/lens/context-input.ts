import { findReport, initialReportIndex } from '../digest/reports.js';
import { parseDigest, type Report } from '../digest/schema.js';
import { DigestStore } from '../digest/store.js';

export interface ContextInput {
  /** links 키를 뺀 리포트 사본. 연결 카드는 이 사본이 아니라 노트에서 따로 만든다 */
  report: Omit<Report, 'links'>;
  transcript?: Array<{ i: number; text: string }>;
}

/**
 * 연결 카드를 쓰는 에이전트에게 줄 리포트 사본을 만든다. 이미 붙은 links에는 노트 경로가 들어 있어서
 * 그대로 주면 새 카드가 옛 카드를 따라 쓴다. 리포트는 attach의 --report와 같은 규칙으로 고른다
 */
export function buildContextInput(
  repoRoot: string,
  slug: string,
  key?: string,
  opts: { withTranscript?: boolean } = {},
): ContextInput {
  const store = new DigestStore(repoRoot);
  const raw = store.readDigestFile(slug);
  if (raw.kind !== 'ok')
    throw new Error(`digest.json이 없어요. 리포트를 먼저 merge해 주세요: ${slug}`);
  const digest = parseDigest(raw.value);
  if (!digest.ok) throw digest.error;
  const report = key
    ? findReport(digest.value, key)
    : digest.value.reports[initialReportIndex(digest.value.reports)];
  if (!report) throw new Error(`리포트 ${key}가 없어요`);
  const { links: _links, ...rest } = report;
  const out: ContextInput = { report: rest };
  if (opts.withTranscript) {
    const t = store.readTranscript(slug);
    if (!t.ok) throw new Error(t.message);
    out.transcript = t.transcript.segments.map((s) => ({ i: s.i, text: s.text }));
  }
  return out;
}
