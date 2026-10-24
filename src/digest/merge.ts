import { lintDigest, lintErrors, type DigestIssue } from './lint.js';
import { reportKey, upsertReport } from './reports.js';
import { DIGEST_SCHEMA_VERSION, type Digest, parseDigest, reportSchema } from './schema.js';
import { DigestStore } from './store.js';

export interface MergeResult {
  slug: string;
  key: string;
  /** 합친 뒤 그 리포트의 자리. lint와 prose 항목 path의 `reports.<index>.`가 이 값이다 */
  index: number;
  replaced: boolean;
  saved: boolean;
  digestPath: string;
  issues: DigestIssue[];
}

/**
 * 새로 만든 리포트 한 벌을 digest.json에 합친다. 같은 키가 있으면 바꿔 끼운다.
 * 합친 결과가 lint 오류를 내면 저장하지 않는다. 원래 digest.json을 깨뜨리지 않으려는 것이다
 */
export function mergeReport(repoRoot: string, slug: string, input: unknown): MergeResult {
  const store = new DigestStore(repoRoot);
  const t = store.readTranscript(slug);
  if (!t.ok) throw new Error(t.message);
  const parsedReport = reportSchema.safeParse(input);
  if (!parsedReport.success) {
    const issues = parsedReport.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`리포트 형식 오류: ${issues.join('; ')}`);
  }
  const report = parsedReport.data;
  const raw = store.readDigestFile(slug);
  let base: Digest | null = null;
  if (raw.kind === 'ok') {
    const parsed = parseDigest(raw.value);
    if (!parsed.ok) throw parsed.error;
    base = parsed.value;
  } else if (raw.kind !== 'missing') {
    throw new Error(raw.message);
  }
  const { digest, replaced } = base
    ? upsertReport(base, report)
    : {
        digest: { schemaVersion: DIGEST_SCHEMA_VERSION, slug, reports: [report] },
        replaced: false,
      };
  const merged: Digest = {
    ...digest,
    schemaVersion: DIGEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
  };
  const issues = lintDigest(merged, t.transcript);
  const saved = lintErrors(issues).length === 0;
  const digestPath = saved ? store.saveDigest(merged) : store.digestPath(slug);
  const key = reportKey(report.options);
  const index = merged.reports.findIndex((r) => reportKey(r.options) === key);
  return { slug, key, index, replaced, saved, digestPath, issues };
}
