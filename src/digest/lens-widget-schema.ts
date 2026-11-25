import { z } from 'zod';
import { cellRefSchema } from './lens-schema.js';
import { stepsSchema } from './lens-steps.js';
import { citeSchema, idSchema, textSchema } from './schema-base.js';

/**
 * 읽기 렌즈 인터랙티브 그림. 모델은 미리 정한 종류 가운데 하나를 고르고 데이터 JSON만 채운다.
 * 렌더러가 상태마다 그림을 미리 그려 두고 뷰어 스크립트는 어느 상태를 보일지만 바꾼다.
 * 그래서 난수나 단계 사이 보간으로 값을 만드는 자리가 없다
 *
 * - A 원문 데이터 그림: 값마다 원문 표 칸이나 문단을 출처로 단다. lint가 칸 숫자와 대조한다
 * - B 개념 설명 그림: 원문 데이터를 빌리지 않는 설명용 예시다. 숫자와 결과 지표, 원문 이름을 쓰지 않는다
 * - C 원문 그림 재구성: 원문 그림 옆에 둔다. 장면 수를 넘지 않고 원문과 다르게 그린 점을 적는다
 * - D 원문 서술 그림: 원문이 글로 설명한 절차나 사례를 옮긴다. 이름은 원문에 있고 숫자는 출처 문단에 있어야 한다.
 *   원문에 없는 요소는 illustrative를 달고 B 규칙을 받는다
 */

export const WIDGET_CLASSES = ['A', 'B', 'C', 'D'] as const;
export const WIDGET_KINDS = [
  'stepSlider',
  'toggleBars',
  'heatmap',
  'beforeAfter',
  'laneGraph',
  'calendar',
  'stepper',
  'analogyMap',
  'stateMachine',
  'sequence',
  'swimlane',
] as const;

const label = z.string().min(1).max(40);

/** 그림 속 값 하나. src는 원문 표 칸이나 원문 문단이다 */
export const widgetValueSchema = z.object({
  value: z.number(),
  src: z.union([cellRefSchema, z.object({ cite: citeSchema })]).optional(),
});

const base = {
  id: idSchema,
  class: z.enum(WIDGET_CLASSES),
  title: textSchema,
  /** 무엇을 설명하는 그림인지 원문 문단 출처 */
  cite: citeSchema,
  caption: textSchema.optional(),
  /** C가 다시 그린 원문 그림 id */
  figure: idSchema.optional(),
  /** C와 D가 원문과 다르게 그린 점. 뷰어가 배지 아래 펼쳐 둔다. C는 필수, D는 선택이다 */
  differences: z.array(z.string()).optional(),
};

/** D 그림에서 원문에 없는 요소. 렌더러가 점선과 "예시" 꼬리표로 그리고 lint는 B 규칙으로 본다 */
const illustrative = z.boolean().optional();

const sideSchema = z.object({
  title: label,
  items: z
    .array(z.object({ label, value: widgetValueSchema.optional(), illustrative }))
    .min(1)
    .max(8),
});

const axisSchema = z.object({ title: label.optional(), labels: z.array(label).min(1).max(8) });

/** 원문 말과 비유를 나란히 놓은 표. 배지는 구분과 상관없이 비유로 고정이고 B만 받는다 */
export const analogyMapSchema = z.object({
  ...base,
  kind: z.literal('analogyMap'),
  domain: label,
  rows: z
    .array(z.object({ term: label, termCite: citeSchema, analog: z.string().min(1).max(80) }))
    .min(3)
    .max(8),
  /** 비유가 원문과 안 맞는 지점. 비어 있으면 lint가 막는다 */
  breaks: z.array(z.string().max(200)).max(4),
});

export const widgetSchema = z.discriminatedUnion('kind', [
  z.object({
    ...base,
    kind: z.literal('toggleBars'),
    toggle: z.object({ off: label, on: label }),
    items: z
      .array(z.object({ label, off: widgetValueSchema, on: widgetValueSchema }))
      .min(1)
      .max(12),
  }),
  z.object({
    ...base,
    kind: z.literal('heatmap'),
    x: axisSchema,
    y: axisSchema,
    cells: z.array(z.array(widgetValueSchema).min(1).max(8)).min(1).max(8),
    /** 어느 쪽이 좋은 값인지. 색 진하기는 늘 값 크기를 따르고 범례 글자만 바뀐다 */
    better: z.enum(['low', 'high']).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('stepSlider'),
    steps: z
      .array(
        z.object({
          label,
          note: textSchema.optional(),
          /** 이 단계가 옮긴 원문 문단. D는 단계마다 단다 */
          cite: citeSchema.optional(),
          nodes: z
            .array(z.object({ id: idSchema, label, illustrative }))
            .min(2)
            .max(12),
          edges: z
            .array(z.object({ from: idSchema, to: idSchema, strength: z.enum(['strong', 'weak']) }))
            .max(40),
        }),
      )
      .min(2)
      .max(12),
  }),
  z.object({ ...base, kind: z.literal('beforeAfter'), before: sideSchema, after: sideSchema }),
  /** 줄(브랜치, 트랙)마다 놓인 점과 부모 연결, 복사 관계. 가로 순서는 nodes 배열 순서다 */
  z.object({
    ...base,
    kind: z.literal('laneGraph'),
    lanes: z
      .array(z.object({ id: idSchema, label }))
      .min(1)
      .max(6),
    nodes: z
      .array(
        z.object({
          id: idSchema,
          lane: idSchema,
          label,
          parents: z.array(idSchema).max(3).optional(),
          /** rebase나 cherry-pick처럼 다른 점을 복사해 새로 쌓은 점 */
          copyOf: idSchema.optional(),
          cite: citeSchema.optional(),
          illustrative,
        }),
      )
      .min(1)
      .max(40),
    steps: stepsSchema.optional(),
  }),
  /** 칸(요일, 날짜) 위에 놓인 기간 막대와 한 칸짜리 사건 */
  z.object({
    ...base,
    kind: z.literal('calendar'),
    columns: z.array(label).min(2).max(14),
    tracks: z
      .array(z.object({ id: idSchema, label }))
      .min(1)
      .max(6),
    spans: z
      .array(
        z.object({
          id: idSchema.optional(),
          track: idSchema,
          from: z.number().int().nonnegative().optional(),
          to: z.number().int().nonnegative().optional(),
          at: z.number().int().nonnegative().optional(),
          label,
          cite: z.union([citeSchema, cellRefSchema]).optional(),
          marker: z.enum(['release', 'warn']).optional(),
          illustrative,
        }),
      )
      .min(1)
      .max(30),
    note: textSchema.optional(),
    steps: stepsSchema.optional(),
  }),
  /** 번호 없는 단계 카드와 되돌아가는 화살표. 순번은 렌더러가 붙인다 */
  z.object({
    ...base,
    kind: z.literal('stepper'),
    items: z
      .array(
        z.object({
          id: idSchema,
          label,
          detail: textSchema.optional(),
          cite: citeSchema.optional(),
          optional: z.boolean().optional(),
          illustrative,
        }),
      )
      .min(2)
      .max(12),
    loops: z
      .array(z.object({ from: idSchema, to: idSchema, label: label.optional() }))
      .max(4)
      .optional(),
    steps: stepsSchema.optional(),
  }),
  analogyMapSchema,
  /** 상태와 전이. 자리는 렌더러가 시작 상태에서 층을 나눠 잡고 pos가 있으면 따른다 */
  z.object({
    ...base,
    kind: z.literal('stateMachine'),
    states: z
      .array(
        z.object({
          id: idSchema,
          label,
          initial: z.boolean().optional(),
          final: z.boolean().optional(),
          pos: z
            .object({
              row: z.number().int().min(0).max(9),
              col: z.number().int().min(0).max(5),
            })
            .optional(),
          cite: citeSchema.optional(),
          illustrative,
        }),
      )
      .min(2)
      .max(10),
    transitions: z
      .array(
        z.object({
          id: idSchema,
          from: idSchema,
          to: idSchema,
          label: label.optional(),
          cite: citeSchema.optional(),
          illustrative,
        }),
      )
      .min(1)
      .max(20),
    steps: stepsSchema.optional(),
  }),
  /** 참여자 사이에 순서대로 오가는 메시지. steps가 없으면 렌더러가 메시지 하나를 한 단계로 보인다 */
  z.object({
    ...base,
    kind: z.literal('sequence'),
    actors: z
      .array(z.object({ id: idSchema, label, illustrative }))
      .min(2)
      .max(6),
    messages: z
      .array(
        z.object({
          id: idSchema,
          from: idSchema,
          to: idSchema,
          label,
          cite: citeSchema.optional(),
          /** 응답 메시지. 점선으로 그린다 */
          reply: z.boolean().optional(),
          illustrative,
        }),
      )
      .min(1)
      .max(16),
    steps: stepsSchema.optional(),
  }),
  /** 역할별 줄에 놓인 활동과 줄을 넘는 화살표. col은 가로 칸 번호다 */
  z.object({
    ...base,
    kind: z.literal('swimlane'),
    lanes: z
      .array(z.object({ id: idSchema, label }))
      .min(1)
      .max(5),
    activities: z
      .array(
        z.object({
          id: idSchema,
          lane: idSchema,
          col: z.number().int().min(0).max(11),
          label,
          cite: citeSchema.optional(),
          illustrative,
        }),
      )
      .min(1)
      .max(24),
    arrows: z
      .array(
        z.object({
          id: idSchema.optional(),
          from: idSchema,
          to: idSchema,
          label: label.optional(),
        }),
      )
      .max(30)
      .optional(),
    steps: stepsSchema.optional(),
  }),
]);

export type Widget = z.infer<typeof widgetSchema>;
export type WidgetValue = z.infer<typeof widgetValueSchema>;
