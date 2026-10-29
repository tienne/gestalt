import { z } from 'zod';
import { contextCardSchema, knowledgeLinkSchema, limitSchema } from '../digest/lens-schema.js';
import { mergeReport, type MergeResult } from '../digest/merge.js';
import { findReport, initialReportIndex } from '../digest/reports.js';
import { DigestStore } from '../digest/store.js';
import { parseDigest } from '../digest/schema.js';

/** lens-context의 카드(cards)와 한계 줄(limits), lens-link의 연결 카드(links)를 스킬이 한 파일로 합친 것이다 */
export const contextFileSchema = z.object({
  cards: z.array(contextCardSchema).max(4).default([]),
  links: z.array(knowledgeLinkSchema).max(6).default([]),
  limits: z
    .array(limitSchema)
    .default([])
    .refine((ls) => ls.every((l) => l.card), '카드 파일의 한계 줄은 card id를 단다'),
});

export type ContextFile = z.infer<typeof contextFileSchema>;

/** --cards 파일: 카드와 카드에서 나온 한계 줄. 빈 객체는 카드를 비우는 뜻이다 */
export const cardsFileSchema = contextFileSchema.pick({ cards: true, limits: true });
/** --links 파일: 연결 카드만. 빈 객체는 연결 카드를 비우는 뜻이다 */
export const linksFileSchema = contextFileSchema.pick({ links: true });

/** 필드별로 나눠 받는 입력. 값은 파싱한 JSON이고 file은 옛 한 파일 꼴이다 */
export interface AttachInput {
  file?: unknown;
  cards?: unknown;
  links?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 옛 호출은 cards와 links가 배열인 한 파일 객체를 그대로 넘겼다. 그 꼴이면 file로 본다 */
function normalizeInput(input: unknown): AttachInput {
  if (!isRecord(input)) return { file: input };
  const fieldForm =
    ('file' in input || 'cards' in input || 'links' in input) &&
    !('limits' in input) &&
    !Array.isArray(input.cards) &&
    !Array.isArray(input.links);
  return fieldForm ? (input as AttachInput) : { file: input };
}

function parseOrThrow<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`맥락 파일 형식 오류: ${issues.join('; ')}`);
  }
  return parsed.data;
}

/**
 * 이미 합친 리포트에 맥락 카드와 연결 카드를 붙인다. 카드에서 온 옛 한계 줄은 지우고 새 줄로 바꾼다.
 * cards만 주면 cards와 카드 한계 줄만, links만 주면 links만 바꾸고 나머지는 기존 리포트 값을 둔다.
 * 합치기는 merge를 그대로 거쳐서 카드 출처와 연결 카드 인용 검사를 받는다
 */
export function attachContext(
  repoRoot: string,
  slug: string,
  input: unknown,
  key?: string,
): MergeResult {
  const { file, cards, links } = normalizeInput(input);
  if (file === undefined && cards === undefined && links === undefined) {
    throw new Error('붙일 파일이 없어요. file, cards, links 중 하나는 있어야 해요');
  }
  const fileCtx = file === undefined ? undefined : parseOrThrow(contextFileSchema, file);
  const cardsCtx = cards === undefined ? undefined : parseOrThrow(cardsFileSchema, cards);
  const linksCtx = links === undefined ? undefined : parseOrThrow(linksFileSchema, links);
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
  // 같은 필드를 file과 개별 파일이 함께 주면 개별 파일이 이긴다
  const cardSide = cardsCtx ?? fileCtx;
  const linkSide = linksCtx ?? fileCtx;
  const next = { ...report };
  if (cardSide) {
    next.cards = cardSide.cards;
    next.limits = [...(report.limits ?? []).filter((l) => !l.card), ...cardSide.limits];
  }
  if (linkSide) next.links = linkSide.links;
  return mergeReport(repoRoot, slug, next);
}
