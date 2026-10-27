import { z } from 'zod';
import { citeSchema, idSchema, textSchema } from './schema-base.js';

/**
 * 읽기 렌즈(논문, 웹 글, 팟캐스트)가 리포트에 더하는 칸.
 * 영상 리포트와 같은 reports[]에 들어가서 전부 선택 칸이고 자료 종류별로 반드시 있어야 하는 칸은 lint가 본다
 */

/** 원문 표의 한 칸. row와 col은 머리줄까지 센 0부터의 자리다 */
export const cellRefSchema = z.object({
  table: idSchema,
  row: z.number().int().nonnegative(),
  col: z.number().int().nonnegative(),
});

/** 의심 표시와 한계 단락의 근거. 원문 표 칸이나 원문 문단 범위다 */
export const evidenceSchema = z.union([cellRefSchema, z.object({ cite: citeSchema })]);

/**
 * 본문 문장의 주장과 같은 원문의 표나 다른 문단이 어긋나는 자리. 바깥 자료로 하는 반론은 여기 두지 않는다.
 * 숫자끼리 어긋난 자리만 받는다. note의 숫자가 근거 칸이나 문단에 있는지 lint가 본다
 */
export const doubtSchema = z.object({
  note: textSchema,
  evidence: z.array(evidenceSchema).min(1),
});

export const GLANCE_KINDS = [
  'problem',
  'method',
  'result',
  'limit',
  'claim',
  'evidence',
  'topic',
] as const;

/** 한눈에 보기 한 칸. 자료 종류마다 들어가야 할 kind는 lint가 정한다 */
export const glanceSchema = z.object({
  kind: z.enum(GLANCE_KINDS),
  text: textSchema,
  cite: citeSchema,
});

/** 원문 표나 그림을 소섹션에 싣는다. 칸 내용은 source.json에서 렌더러가 옮겨서 모델이 숫자를 다시 적지 않는다 */
export const sourceRefSchema = z.object({
  ref: idSchema,
  note: textSchema.optional(),
});

/** 검증 안 된 부분 한 줄. 근거가 원문이면 evidence, 바깥 맥락 카드에서 나왔으면 card에 그 id를 적는다 */
export const limitSchema = z.object({
  text: textSchema,
  evidence: z.array(evidenceSchema).default([]),
  card: idSchema.optional(),
});

export type CellRef = z.infer<typeof cellRefSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Doubt = z.infer<typeof doubtSchema>;
export type Glance = z.infer<typeof glanceSchema>;
export type GlanceKind = (typeof GLANCE_KINDS)[number];
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type Limit = z.infer<typeof limitSchema>;

export const isCellRef = (e: Evidence): e is CellRef => 'table' in e;
