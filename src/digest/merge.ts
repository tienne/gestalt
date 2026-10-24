import { extensionKey, extensionSchema, type Extension } from './blocks.js';
import { commentsMap } from './comments.js';
import { lintDigest, lintErrors, type DigestIssue } from './lint.js';
import type { ExtensionLintOptions } from './lint-extension.js';
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
        digest: { schemaVersion: DIGEST_SCHEMA_VERSION, slug, reports: [report], extensions: [] },
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

export interface ExtensionMergeResult {
  slug: string;
  key: string;
  /** 합친 뒤 그 확장의 자리. lint와 prose 항목 path의 `extensions.<index>.`가 이 값이다 */
  index: number;
  replaced: boolean;
  saved: boolean;
  digestPath: string;
  issues: DigestIssue[];
}

/** 같은 템플릿과 언어의 확장이 있으면 그 자리에 바꿔 끼우고 없으면 뒤에 붙인다 */
export function upsertExtension(
  digest: Digest,
  ext: Extension,
): { digest: Digest; replaced: boolean } {
  const key = extensionKey(ext);
  const at = digest.extensions.findIndex((x) => extensionKey(x) === key);
  const extensions = [...digest.extensions];
  if (at >= 0) extensions[at] = ext;
  else extensions.push(ext);
  return { digest: { ...digest, extensions }, replaced: at >= 0 };
}

/**
 * 템플릿으로 만든 확장 리포트 한 벌을 digest.json에 합친다.
 * 확장은 요약 리포트에 기대지 않지만 뷰어가 요약 탭을 먼저 열어서 digest.json이 있어야 한다
 */
export function mergeExtension(
  repoRoot: string,
  slug: string,
  input: unknown,
  opts: ExtensionLintOptions = {},
): ExtensionMergeResult {
  const store = new DigestStore(repoRoot);
  const t = store.readTranscript(slug);
  if (!t.ok) throw new Error(t.message);
  const parsedExt = extensionSchema.safeParse(input);
  if (!parsedExt.success) {
    const issues = parsedExt.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`확장 리포트 형식 오류: ${issues.join('; ')}`);
  }
  const ext = parsedExt.data;
  const raw = store.readDigestFile(slug);
  if (raw.kind === 'missing') {
    throw new Error(`digest.json이 없어요. 요약 리포트를 먼저 합쳐 주세요: ${slug}`);
  }
  if (raw.kind !== 'ok') throw new Error(raw.message);
  const parsed = parseDigest(raw.value);
  if (!parsed.ok) throw parsed.error;
  const { digest, replaced } = upsertExtension(parsed.value, ext);
  const merged: Digest = {
    ...digest,
    schemaVersion: DIGEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
  };
  // 댓글 예시는 받아 둔 댓글과 맞아야 합친다. 파일이 없으면 null이라 댓글 블록이 오류로 걸린다
  const issues = lintDigest(merged, t.transcript, {
    ...opts,
    comments: opts.comments !== undefined ? opts.comments : commentsMap(store, slug),
    strictVerbatim: true,
  });
  const saved = lintErrors(issues).length === 0;
  const digestPath = saved ? store.saveDigest(merged) : store.digestPath(slug);
  const key = extensionKey(ext);
  const index = merged.extensions.findIndex((x) => extensionKey(x) === key);
  return { slug, key, index, replaced, saved, digestPath, issues };
}
