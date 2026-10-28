import { z } from 'zod';
import { cellRefSchema } from './lens-schema.js';
import { citeSchema, idSchema, textSchema } from './schema-base.js';

/**
 * 읽기 렌즈 인터랙티브 그림. 모델은 미리 정한 네 종류 가운데 하나를 고르고 데이터 JSON만 채운다.
 * 렌더러가 상태마다 그림을 미리 그려 두고 뷰어 스크립트는 어느 상태를 보일지만 바꾼다.
 * 그래서 난수나 단계 사이 보간으로 값을 만드는 자리가 없다
 *
 * - A 원문 데이터 그림: 값마다 원문 표 칸이나 문단을 출처로 단다. lint가 칸 숫자와 대조한다
 * - B 개념 설명 그림: 원문 데이터를 빌리지 않는 장난감 예시다. 숫자와 결과 지표, 원문 이름을 쓰지 않는다
 * - C 원문 그림 재구성: 원문 그림 옆에 둔다. 장면 수를 넘지 않고 원문과 다르게 그린 점을 적는다
 */

export const WIDGET_CLASSES = ['A', 'B', 'C'] as const;
export const WIDGET_KINDS = ['stepSlider', 'toggleBars', 'heatmap', 'beforeAfter'] as const;

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
  /** C가 원문 그림과 다르게 그린 점. 뷰어가 배지 아래 펼쳐 둔다 */
  differences: z.array(z.string()).optional(),
};

const sideSchema = z.object({
  title: label,
  items: z
    .array(z.object({ label, value: widgetValueSchema.optional() }))
    .min(1)
    .max(8),
});

const axisSchema = z.object({ title: label.optional(), labels: z.array(label).min(1).max(8) });

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
          nodes: z
            .array(z.object({ id: idSchema, label }))
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
]);

export type Widget = z.infer<typeof widgetSchema>;
export type WidgetValue = z.infer<typeof widgetValueSchema>;
