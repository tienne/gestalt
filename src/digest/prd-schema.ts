import { z } from 'zod';
import { idSchema, SLUG_PATTERN, textSchema } from './schema-base.js';

/**
 * PRD 뷰 문서. 양식(섹션 이름과 순서)은 정하지 않고 블록 어휘만 준다.
 * 세션 LLM이 원문을 읽고 블록을 골라 JSON을 채우고 서버는 검사와 렌더만 한다.
 * 블록마다 원문 줄 범위(src)를 달아서 원문에 없는 내용을 지어냈는지 lint가 대조한다
 */

export const PRD_SCHEMA_VERSION = '1.1.0';

export const AUDIENCES = ['pm', 'dev', 'design', 'qa', 'data'] as const;
export type Audience = (typeof AUDIENCES)[number];

/** 원문 1-based 줄 범위 [시작, 끝]. 끝 줄도 포함한다 */
export const lineRangeSchema = z
  .tuple([z.number().int().min(1), z.number().int().min(1)])
  .refine(([a, b]) => a <= b, '줄 범위의 시작이 끝보다 크다');

export type LineRange = z.infer<typeof lineRangeSchema>;

const srcSchema = z.array(lineRangeSchema).min(1).max(8);

export const sourcedTextSchema = z.object({ text: textSchema, src: srcSchema });

export const REQUIREMENT_SLOTS = [
  'precondition',
  'trigger',
  'behavior',
  'result',
  'exception',
  'display',
  'permission',
  'businessRule',
  'data',
] as const;
export type RequirementSlot = (typeof REQUIREMENT_SLOTS)[number];

const slotsSchema = z
  .object({
    precondition: sourcedTextSchema.optional(),
    trigger: sourcedTextSchema.optional(),
    behavior: sourcedTextSchema.optional(),
    result: sourcedTextSchema.optional(),
    exception: sourcedTextSchema.optional(),
    display: sourcedTextSchema.optional(),
    permission: sourcedTextSchema.optional(),
    businessRule: sourcedTextSchema.optional(),
    data: sourcedTextSchema.optional(),
  })
  .strict();

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
export const QUOTE_ORIGINS = ['voc', 'virtual', 'unknown'] as const;
export const CALLOUT_TONES = ['info', 'warn', 'danger'] as const;

const blockUnion = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('claim'), text: textSchema, status: z.enum(CLAIM_STATUSES) }),
  z.object({
    ...base,
    kind: z.literal('requirement'),
    title: textSchema,
    parent: idSchema.optional(),
    acceptance: z.array(sourcedTextSchema).max(40).optional(),
    slots: slotsSchema.optional(),
    priority: textSchema.optional(),
    questions: z.array(idSchema).max(40).optional(),
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
  z.object({ ...base, kind: z.literal('risk'), text: textSchema, response: textSchema.optional() }),
  z.object({ ...base, kind: z.literal('prose'), text: textSchema }),
  z.object({
    ...base,
    kind: z.literal('compare'),
    labels: z.tuple([textSchema, textSchema]),
    rows: z
      .array(
        z.object({
          label: textSchema.optional(),
          left: textSchema.optional(),
          right: textSchema.optional(),
        }),
      )
      .min(1)
      .max(40),
  }),
  z.object({ ...base, kind: z.literal('scope'), out: z.array(textSchema).min(1).max(40) }),
  z.object({
    ...base,
    kind: z.literal('quote'),
    text: textSchema,
    origin: z.enum(QUOTE_ORIGINS),
    by: textSchema.optional(),
  }),
  z.object({ ...base, kind: z.literal('flow'), steps: z.array(textSchema).min(2).max(20) }),
  z.object({
    ...base,
    kind: z.literal('stateMatrix'),
    rows: z.array(textSchema).min(1).max(30),
    cols: z.array(textSchema).min(1).max(12),
    /** cells[행][열]. 원문에 빈 칸이면 null */
    cells: z.array(z.array(textSchema.nullable()).max(12)).max(30),
  }),
  z.object({
    ...base,
    kind: z.literal('timeline'),
    items: z
      .array(z.object({ date: textSchema, what: textSchema }))
      .min(1)
      .max(40),
  }),
  z.object({
    ...base,
    kind: z.literal('glossary'),
    terms: z
      .array(z.object({ term: textSchema, meaning: textSchema }))
      .min(1)
      .max(60),
  }),
  z.object({
    ...base,
    kind: z.literal('callout'),
    text: textSchema,
    tone: z.enum(CALLOUT_TONES),
  }),
]);

// discriminatedUnion 안의 객체에는 refine을 걸 수 없어서 표 모양 검사는 union 바깥에서 한다
export const blockSchema = blockUnion.superRefine((b, ctx) => {
  if (b.kind !== 'stateMatrix') return;
  if (b.cells.length !== b.rows.length || b.cells.some((r) => r.length !== b.cols.length)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cells'],
      message: 'cells는 rows 수만큼의 행과 cols 수만큼의 열이어야 한다',
    });
  }
});

export type PrdBlock = z.infer<typeof blockSchema>;
export type BlockKind = PrdBlock['kind'];
export type BlockOf<K extends BlockKind> = Extract<PrdBlock, { kind: K }>;

export const BLOCK_KINDS = blockUnion.options.map((o) => o.shape.kind.value) as BlockKind[];

export const sectionSchema = z.object({
  id: idSchema,
  title: textSchema,
  blocks: z.array(blockSchema).min(1).max(200),
});

export const prdViewSchema = z
  .object({
    schemaVersion: z.enum(['1.0.0', PRD_SCHEMA_VERSION]),
    slug: z.string().regex(SLUG_PATTERN, 'slug는 영문 소문자, 숫자, -만 쓴다(64자까지)'),
    meta: z.object({
      title: textSchema,
      roles: z.array(sourcedTextSchema).max(30).optional(),
      platforms: z.array(sourcedTextSchema).max(30).optional(),
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
      boundary: '범위 밖이나 제약, 아직 정하지 않은 경계(원문에 있을 때만)',
      parent: '상위 requirement id. 그룹과 기능 2단까지만 허용',
      acceptance: '[{ text, src }] 원문 수용 기준',
      slots:
        '{ precondition?, trigger?, behavior?, result?, exception?, display?, permission?, businessRule?, data? }. 값은 { text, src }',
      priority: '원문에 적힌 중요도 문자열',
      questions: '연결된 question 블록 id 배열',
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
  risk: {
    stage: 1,
    purpose: '리스크와 원문에 적힌 대응',
    fields: { text: '리스크 문장', response: '대응 문자열(원문에 있을 때만)' },
  },
  prose: {
    stage: 1,
    purpose: '맞는 블록이 없을 때 쓰는 문단. 다른 블록으로 표현할 수 있으면 그쪽을 쓴다',
    fields: { text: '문단' },
  },
  compare: {
    stage: 3,
    purpose: 'AS-IS와 TO-BE, A안과 B안처럼 두 쪽을 행마다 나란히 놓는 비교',
    fields: {
      labels: '[왼쪽 이름, 오른쪽 이름]',
      rows: '[{ label?, left?, right? }] 원문에 빈 칸이면 필드를 뺀다',
    },
  },
  scope: {
    stage: 3,
    purpose: '이번에 안 하는 것 목록. requirement 하나에 딸린 경계는 requirement.boundary에 둔다',
    fields: { out: '안 하는 것 문장 배열' },
  },
  quote: {
    stage: 3,
    purpose: '유저 말투 그대로의 인용. 실제 VOC인지 기획자가 지어낸 가상 화법인지 출처를 단다',
    fields: {
      text: '인용문',
      origin: "'voc'(실제 유저 목소리) | 'virtual'(가상 화법) | 'unknown'(원문이 안 밝힘)",
      by: '말한 사람이나 출처(원문에 있을 때만)',
    },
  },
  flow: {
    stage: 3,
    purpose: '화면이나 단계가 순서대로 이어지는 흐름. 단계 두 개 이상',
    fields: { steps: '단계 이름 배열' },
  },
  stateMatrix: {
    stage: 3,
    purpose: '상태와 조건을 행과 열로 놓은 표. 원문 표를 그대로 옮긴다',
    fields: {
      rows: '행 이름 배열',
      cols: '열 이름 배열',
      cells: '[행][열] 2차원 배열. rows와 cols 수에 맞춘다. 원문에 빈 칸이면 null',
    },
  },
  timeline: {
    stage: 3,
    purpose: '일정. 날짜와 할 일',
    fields: { items: '[{ date, what }] date는 원문 글자 그대로' },
  },
  glossary: {
    stage: 3,
    purpose: '용어 정의',
    fields: { terms: '[{ term, meaning }]' },
  },
  callout: {
    stage: 3,
    purpose: '원문이 강조한 주의 문단. 원문에 경고나 참고 표시가 있을 때만',
    fields: { text: '문단', tone: "'info' | 'warn' | 'danger'" },
  },
};

export const COMMON_FIELD_DOCS: Record<string, string> = {
  id: '문서 안에서 겹치지 않는 id(영문, 숫자, -, _)',
  src: '원문 줄 범위 배열 [[시작, 끝], ...]. 1-based이고 끝 줄도 포함한다. source 액션의 줄 번호를 쓴다',
  summary: '원문을 줄여 쓴 블록이면 true. 글자 대조를 건너뛰고 화면에 "요약" 배지가 붙는다',
  audience: "읽을 사람 태그 배열 'pm' | 'dev' | 'design' | 'qa' | 'data'. 비우면 모두에게 보인다",
};
