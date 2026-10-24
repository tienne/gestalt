import { z } from 'zod';
import { citeSchema, LANG_TAG_PATTERN, textSchema } from './schema-base.js';

/**
 * 확장 리포트(회의록, 퀴즈 같은 템플릿 결과)를 이루는 블록.
 * 템플릿은 이 중에서 쓸 블록을 고르고 렌더러가 타입마다 정해진 꼴로 그린다.
 * 요약 에이전트는 HTML이나 SVG를 쓰지 않고 이 구조만 채운다
 */
export const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const templateIdSchema = z
  .string()
  .regex(TEMPLATE_ID_PATTERN, '템플릿 id는 영문 소문자, 숫자, -만 쓴다');

export interface ListItem {
  text: string;
  cite?: z.infer<typeof citeSchema>;
  children?: ListItem[];
}

// 3단 이상은 lint가 경로와 함께 잡는다. Bullet과 같은 이유다
export const listItemSchema: z.ZodType<ListItem> = z.lazy(() =>
  z.object({
    text: textSchema,
    cite: citeSchema.optional(),
    children: z.array(listItemSchema).optional(),
  }),
);

export const headingBlockSchema = z.object({
  type: z.literal('heading'),
  text: textSchema,
});

export const textBlockSchema = z.object({
  type: z.literal('text'),
  text: textSchema,
  cite: citeSchema.optional(),
});

export const listBlockSchema = z.object({
  type: z.literal('list'),
  title: textSchema.optional(),
  items: z.array(listItemSchema).min(1),
});

/** 대사를 그대로 옮긴 인용. 영상 언어와 리포트 언어가 다르면 번역은 translation에 따로 둔다 */
export const quoteBlockSchema = z.object({
  type: z.literal('quote'),
  text: textSchema,
  translation: textSchema.optional(),
  speaker: textSchema.optional(),
  note: textSchema.optional(),
  cite: citeSchema,
});

/** 영상 목차. 시각은 cite.key 문장의 시작 시각을 쓴다 */
export const timestampsBlockSchema = z.object({
  type: z.literal('timestamps'),
  items: z
    .array(z.object({ title: textSchema, summary: textSchema.optional(), cite: citeSchema }))
    .min(1)
    .max(60),
});

export const actionsBlockSchema = z.object({
  type: z.literal('actions'),
  items: z
    .array(
      z.object({
        task: textSchema,
        owner: textSchema.optional(),
        due: textSchema.optional(),
        cite: citeSchema.optional(),
      }),
    )
    .min(1)
    .max(50),
});

export const qaBlockSchema = z.object({
  type: z.literal('qa'),
  items: z
    .array(z.object({ question: textSchema, answer: textSchema, cite: citeSchema.optional() }))
    .min(1)
    .max(40),
});

export const blockSchema = z.discriminatedUnion('type', [
  headingBlockSchema,
  textBlockSchema,
  listBlockSchema,
  quoteBlockSchema,
  timestampsBlockSchema,
  actionsBlockSchema,
  qaBlockSchema,
]);

export const BLOCK_TYPES = blockSchema.options.map((o) => o.shape.type.value);
export type BlockType = (typeof BLOCK_TYPES)[number];

export const extensionSchema = z.object({
  template: templateIdSchema,
  title: textSchema,
  lang: z.string().regex(LANG_TAG_PATTERN, '언어 태그(ko, en, pt-BR) 꼴이어야 한다').default('ko'),
  blocks: z.array(blockSchema).min(1),
});

export type HeadingBlock = z.infer<typeof headingBlockSchema>;
export type TextBlock = z.infer<typeof textBlockSchema>;
export type ListBlock = z.infer<typeof listBlockSchema>;
export type QuoteBlock = z.infer<typeof quoteBlockSchema>;
export type Block = z.infer<typeof blockSchema>;
export type Extension = z.infer<typeof extensionSchema>;

/**
 * 같은 템플릿이라도 언어가 다르면 다른 확장이다. 탭 id와 merge 키로 쓴다.
 * 템플릿 id와 언어 태그 둘 다 -를 쓰므로 둘 다 안 쓰는 .으로 잇는다
 */
export const extensionKey = (ext: Pick<Extension, 'template' | 'lang'>): string =>
  `${ext.template}.${ext.lang}`;
