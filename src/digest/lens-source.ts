import { join } from 'node:path';
import { z } from 'zod';
import { idSchema, SLUG_PATTERN, textSchema } from './schema-base.js';
import { LENS_SOURCES } from './schema.js';
import { readRaw, type DigestStore } from './store.js';

export const LENS_SOURCE_FILE = 'source.json';
export const LENS_SOURCE_SCHEMA_VERSION = '1.0.0';

/** 뷰어가 상대 경로로 싣는다. 추출기가 쓰는 꼴만 받아서 폴더 밖이나 다른 확장자를 가리키지 못하게 한다 */
const assetPath = z.string().regex(/^(pages|figures|tables)\/[a-z0-9-]+\.(png|jpg)$/);
const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const sourcePageSchema = z.object({
  n: z.number().int().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
  image: assetPath,
});

/**
 * 원문 표. rows는 머리줄을 포함한 칸 글자 그대로다.
 * grid가 loose면 칸 경계를 잘못 읽었을 수 있어서 뷰어가 원문 크롭을 앞에 둔다
 */
export const sourceTableSchema = z.object({
  id: idSchema,
  number: z.string().min(1),
  caption: textSchema,
  page: z.number().int().positive().optional(),
  bbox: bboxSchema.optional(),
  rows: z.array(z.array(z.string())).min(1),
  grid: z.enum(['ok', 'loose']).default('ok'),
  image: assetPath.optional(),
  /** 캡션 문단 번호. 표를 출처로 걸 때 이 문단을 가리킨다 */
  unit: z.number().int().nonnegative(),
});

export const sourceFigureSchema = z.object({
  id: idSchema,
  number: z.string().min(1),
  caption: textSchema,
  page: z.number().int().positive().optional(),
  bbox: bboxSchema.optional(),
  image: assetPath.optional(),
  unit: z.number().int().nonnegative(),
  /** 원문 그림 안의 장면 수. 세션이 크롭을 보고 `gestalt lens panels`로 적는다. C 재구성의 칸 수 상한이다 */
  panels: z.number().int().min(1).max(10).optional(),
});

export const lensSourceSchema = z.object({
  schemaVersion: z.string().default(LENS_SOURCE_SCHEMA_VERSION),
  slug: z.string().regex(SLUG_PATTERN),
  kind: z.enum(LENS_SOURCES),
  pages: z.array(sourcePageSchema).default([]),
  tables: z.array(sourceTableSchema).default([]),
  figures: z.array(sourceFigureSchema).default([]),
});

export type SourcePage = z.infer<typeof sourcePageSchema>;
export type SourceTable = z.infer<typeof sourceTableSchema>;
export type SourceFigure = z.infer<typeof sourceFigureSchema>;
export type LensSource = z.infer<typeof lensSourceSchema>;

export function lensSourcePath(store: DigestStore, slug: string): string {
  return join(store.dir(slug), LENS_SOURCE_FILE);
}

/** 없거나 형식이 틀리면 null. lint는 null이면 표와 그림 출처를 하나도 받지 않는다 */
export function readLensSource(store: DigestStore, slug: string): LensSource | null {
  const raw = readRaw(lensSourcePath(store, slug));
  if (raw.kind !== 'ok') return null;
  const parsed = lensSourceSchema.safeParse(raw.value);
  return parsed.success ? parsed.data : null;
}

/** 칸 글자에서 숫자 하나를 읽는다. 천 단위 쉼표는 지운다. 숫자가 아니거나 둘 이상이면 null */
export function cellNumber(text: string): number | null {
  const t = text.trim().replace(/(?<=\d),(?=\d{3}\b)/g, '');
  if (!/^[-+−]?\d+(?:\.\d+)?%?$/.test(t)) return null;
  return Number(t.replace('−', '-').replace('%', ''));
}

export function tableCell(
  source: LensSource,
  ref: { table: string; row: number; col: number },
): string | undefined {
  return source.tables.find((t) => t.id === ref.table)?.rows[ref.row]?.[ref.col];
}
