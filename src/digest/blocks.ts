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

/** 앞면을 누르면 뒷면이 열린다. HTML은 details라 스크립트 없이 뒤집힌다 */
export const flashcardsBlockSchema = z.object({
  type: z.literal('flashcards'),
  cards: z
    .array(z.object({ front: textSchema, back: textSchema, cite: citeSchema.optional() }))
    .min(1)
    .max(60),
});

/** answer는 choices의 0부터 센 자리다. 범위 밖이면 lint가 오류로 막는다 */
export const quizBlockSchema = z.object({
  type: z.literal('quiz'),
  questions: z
    .array(
      z.object({
        question: textSchema,
        choices: z.array(textSchema).min(2).max(6),
        answer: z.number().int().min(0),
        explanation: textSchema,
        cite: citeSchema.optional(),
      }),
    )
    .min(1)
    .max(30),
});

export interface MindmapNode {
  label: string;
  cite?: z.infer<typeof citeSchema>;
  children?: MindmapNode[];
}

/** 깊이와 노드 수 상한은 lint가 경로와 함께 잡는다. 그림이 화면을 넘지 않게 하려는 것이다 */
export const mindmapNodeSchema: z.ZodType<MindmapNode> = z.lazy(() =>
  z.object({
    label: textSchema,
    cite: citeSchema.optional(),
    children: z.array(mindmapNodeSchema).max(12).optional(),
  }),
);

/** SVG 원문은 받지 않는다. 트리 구조만 받고 그림은 렌더러가 그린다 */
export const mindmapBlockSchema = z.object({
  type: z.literal('mindmap'),
  root: mindmapNodeSchema,
});

export const COMMENT_TONES = ['positive', 'negative', 'neutral', 'question'] as const;

/** yt-dlp가 주는 댓글 id. 영숫자와 -, _, .만 온다 */
export const commentIdSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,120}$/);

/** 댓글을 성격별로 묶은 분석. examples.text는 댓글 원문이고 lint가 comments.json과 대조한다 */
export const commentsBlockSchema = z.object({
  type: z.literal('comments'),
  total: z.number().int().min(0),
  overview: textSchema,
  groups: z
    .array(
      z.object({
        title: textSchema,
        tone: z.enum(COMMENT_TONES),
        count: z.number().int().min(0),
        summary: textSchema,
        examples: z
          .array(z.object({ id: commentIdSchema, text: textSchema }))
          .max(3)
          .default([]),
      }),
    )
    .min(1)
    .max(12),
});

export const blockSchema = z.discriminatedUnion('type', [
  headingBlockSchema,
  textBlockSchema,
  listBlockSchema,
  quoteBlockSchema,
  timestampsBlockSchema,
  actionsBlockSchema,
  qaBlockSchema,
  flashcardsBlockSchema,
  quizBlockSchema,
  mindmapBlockSchema,
  commentsBlockSchema,
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
export type QuizBlock = z.infer<typeof quizBlockSchema>;
export type MindmapBlock = z.infer<typeof mindmapBlockSchema>;
export type CommentsBlock = z.infer<typeof commentsBlockSchema>;
export type Block = z.infer<typeof blockSchema>;
export type Extension = z.infer<typeof extensionSchema>;

/**
 * 같은 템플릿이라도 언어가 다르면 다른 확장이다. 탭 id와 merge 키로 쓴다.
 * 템플릿 id와 언어 태그 둘 다 -를 쓰므로 둘 다 안 쓰는 .으로 잇는다
 */
export const extensionKey = (ext: Pick<Extension, 'template' | 'lang'>): string =>
  `${ext.template}.${ext.lang}`;
