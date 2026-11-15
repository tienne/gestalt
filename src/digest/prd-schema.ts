import { z } from 'zod';
import { idSchema, SLUG_PATTERN, textSchema } from './schema-base.js';

/**
 * PRD 뷰 문서. 양식(섹션 이름과 순서)은 정하지 않고 블록 어휘만 준다.
 * 세션 LLM이 원문을 읽고 블록을 골라 JSON을 채우고 서버는 검사와 렌더만 한다.
 * 블록마다 원문 줄 범위(src)를 달아서 원문에 없는 내용을 지어냈는지 lint가 대조한다
 */

export const PRD_SCHEMA_VERSION = '1.0.0';

export const AUDIENCES = ['pm', 'dev', 'design', 'qa', 'data'] as const;
export type Audience = (typeof AUDIENCES)[number];

/** 원문 1-based 줄 범위 [시작, 끝]. 끝 줄도 포함한다 */
export const lineRangeSchema = z
  .tuple([z.number().int().min(1), z.number().int().min(1)])
  .refine(([a, b]) => a <= b, '줄 범위의 시작이 끝보다 크다');

export type LineRange = z.infer<typeof lineRangeSchema>;

const srcSchema = z.array(lineRangeSchema).min(1).max(8);

const base = {
  id: idSchema,
  src: srcSchema,
  /** 원문을 줄여 쓴 블록. 글자 대조를 건너뛰고 렌더러가 "요약" 배지를 단다 */
  summary: z.boolean().optional(),
  audience: z.array(z.enum(AUDIENCES)).min(1).max(AUDIENCES.length).optional(),
};

export const CLAIM_STATUSES = ['confirmed', 'assumed', 'open'] as const;
export const PHASES = ['mvp', 'later'] as const;
export const METRIC_ROLES = ['primary', 'secondary', 'guardrail'] as const;

export const blockSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('claim'), text: textSchema, status: z.enum(CLAIM_STATUSES) }),
  z.object({
    ...base,
    kind: z.literal('requirement'),
    title: textSchema,
    why: textSchema.optional(),
    boundary: textSchema.optional(),
    phase: z.enum(PHASES).optional(),
    metrics: z.array(idSchema).max(20).optional(),
    detail: z.array(textSchema).max(30).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('metric'),
    metricId: idSchema,
    name: textSchema,
    role: z.enum(METRIC_ROLES).optional(),
    denominator: textSchema.optional(),
    baseline: textSchema.optional(),
    target: textSchema.optional(),
    measure: textSchema.optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('decision'),
    decided: textSchema,
    why: textSchema.optional(),
    rejected: z
      .array(z.object({ option: textSchema, reason: textSchema.optional() }))
      .max(10)
      .optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('question'),
    item: textSchema,
    owner: textSchema.optional(),
    due: textSchema.optional(),
  }),
  z.object({ ...base, kind: z.literal('prose'), text: textSchema }),
]);

export type PrdBlock = z.infer<typeof blockSchema>;
export type BlockKind = PrdBlock['kind'];
export type BlockOf<K extends BlockKind> = Extract<PrdBlock, { kind: K }>;

export const BLOCK_KINDS = blockSchema.options.map((o) => o.shape.kind.value) as BlockKind[];

export const sectionSchema = z.object({
  id: idSchema,
  title: textSchema,
  blocks: z.array(blockSchema).min(1).max(200),
});

export const prdViewSchema = z
  .object({
    schemaVersion: z.literal(PRD_SCHEMA_VERSION),
    slug: z.string().regex(SLUG_PATTERN, 'slug는 영문 소문자, 숫자, -만 쓴다(64자까지)'),
    meta: z.object({
      title: textSchema,
      /** 원문 경로. 도구에 sourcePath를 안 주면 이 값을 읽는다 */
      source: textSchema,
      sourceSha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
      /** 원문에 있는 메타(일정, 오너, 링크 같은)만 옮긴다 */
      rows: z
        .array(z.object({ key: textSchema, value: textSchema, src: srcSchema }))
        .max(30)
        .default([]),
    }),
    sections: z.array(sectionSchema).min(1).max(60),
    /** 일부러 옮기지 않은 구간(변경 이력 같은). coverage 계산에서 빠진다 */
    omitted: z
      .array(z.object({ src: srcSchema, reason: textSchema }))
      .max(30)
      .default([]),
  })
  .strict();

export type PrdView = z.infer<typeof prdViewSchema>;

export type ParsePrdResult = { ok: true; value: PrdView } | { ok: false; issues: string[] };

export function parsePrdView(input: unknown): ParsePrdResult {
  const parsed = prdViewSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

/** 문서 안의 블록을 섹션 순서대로 꺼낸다 */
export function* allBlocks(
  view: PrdView,
): Generator<{ block: PrdBlock; path: string; sectionId: string }> {
  for (const [si, section] of view.sections.entries()) {
    for (const [bi, block] of section.blocks.entries()) {
      yield { block, path: `sections.${si}.blocks.${bi}`, sectionId: section.id };
    }
  }
}

export interface BlockDoc {
  kind: BlockKind;
  stage: number;
  purpose: string;
  fields: Record<string, string>;
}

/** guide 액션이 돌려주는 블록 어휘 설명. 키가 Record라 블록을 더하고 설명을 빼먹으면 타입 에러가 난다 */
export const BLOCK_DOCS: Record<BlockKind, Omit<BlockDoc, 'kind'>> = {
  claim: {
    stage: 1,
    purpose: '문제 정의나 배경처럼 한 문장으로 서는 주장. 확정인지 가정인지 미정인지 상태를 단다',
    fields: { text: '원문 문장', status: "'confirmed' | 'assumed' | 'open'" },
  },
  requirement: {
    stage: 1,
    purpose: '무엇을 만드는지. 요구사항, 기능, 유저 스토리 하나가 블록 하나다',
    fields: {
      title: '무엇을 만드는지 한 줄',
      why: '가설이나 이유(원문에 있을 때만)',
      boundary: '이번에 안 하는 것(원문에 있을 때만)',
      phase: "'mvp' | 'later'",
      metrics: '연결된 metric 블록의 metricId 배열',
      detail: '본문 문장 배열',
    },
  },
  metric: {
    stage: 1,
    purpose: '성공 지표 하나. 원문에 없는 칸은 비워 둔다(지어내지 않는다)',
    fields: {
      metricId: '원문의 지표 id(M1 같은). 없으면 원문 순서대로 M1부터',
      name: '지표 이름',
      role: "'primary' | 'secondary' | 'guardrail'",
      denominator: '분모',
      baseline: '현재 값',
      target: '목표 값',
      measure: '측정 방법이나 이벤트',
    },
  },
  decision: {
    stage: 1,
    purpose: '정한 것과 이유, 버린 안',
    fields: { decided: '결정 내용', why: '이유', rejected: '[{ option, reason? }] 버린 안' },
  },
  question: {
    stage: 1,
    purpose: '아직 안 정한 것, 확인할 것',
    fields: { item: '질문', owner: '담당', due: '기한' },
  },
  prose: {
    stage: 1,
    purpose: '맞는 블록이 없을 때 쓰는 문단. 다른 블록으로 표현할 수 있으면 그쪽을 쓴다',
    fields: { text: '문단' },
  },
};

export const COMMON_FIELD_DOCS: Record<string, string> = {
  id: '문서 안에서 겹치지 않는 id(영문, 숫자, -, _)',
  src: '원문 줄 범위 배열 [[시작, 끝], ...]. 1-based이고 끝 줄도 포함한다. source 액션의 줄 번호를 쓴다',
  summary: '원문을 줄여 쓴 블록이면 true. 글자 대조를 건너뛰고 화면에 "요약" 배지가 붙는다',
  audience: "읽을 사람 태그 배열 'pm' | 'dev' | 'design' | 'qa' | 'data'. 비우면 모두에게 보인다",
};
