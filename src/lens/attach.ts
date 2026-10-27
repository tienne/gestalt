import { z } from 'zod';
import { contextCardSchema, knowledgeLinkSchema, limitSchema } from '../digest/lens-schema.js';
import { mergeReport, type MergeResult } from '../digest/merge.js';
import { findReport, initialReportIndex } from '../digest/reports.js';
import { DigestStore } from '../digest/store.js';
import { parseDigest } from '../digest/schema.js';

/** lens-context가 쓰는 파일. 카드와 연결 카드, 카드에서 나온 한계 줄이다 */
export const contextFileSchema = z.object({
  cards: z.array(contextCardSchema).max(4).default([]),
  links: z.array(knowledgeLinkSchema).max(6).default([]),
  limits: z
    .array(limitSchema)
    .default([])
    .refine((ls) => ls.every((l) => l.card), '카드 파일의 한계 줄은 card id를 단다'),
});

export type ContextFile = z.infer<typeof contextFileSchema>;

/**
 * 이미 합친 리포트에 맥락 카드와 연결 카드를 붙인다. 카드에서 온 옛 한계 줄은 지우고 새 줄로 바꾼다.
 * 합치기는 merge를 그대로 거쳐서 카드 출처와 연결 카드 인용 검사를 받는다
 */
export function attachContext(
  repoRoot: string,
  slug: string,
  input: unknown,
  key?: string,
): MergeResult {
  const parsed = contextFileSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`맥락 파일 형식 오류: ${issues.join('; ')}`);
  }
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
  const ctx = parsed.data;
  return mergeReport(repoRoot, slug, {
    ...report,
    cards: ctx.cards,
    links: ctx.links,
    limits: [...(report.limits ?? []).filter((l) => !l.card), ...ctx.limits],
  });
}
