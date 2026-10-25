import { z } from 'zod';
import { citeSchema, textSchema } from './schema-base.js';

/**
 * 도식 구조. 대섹션 도식과 확장 리포트의 figure 블록이 같이 쓴다.
 * schema.ts와 blocks.ts가 서로 import하지 않게 여기에 따로 둔다
 */

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

const diagramNodeSchema = z.object({ label: textSchema, cite: citeSchema.optional() });
const diagramCaption = textSchema.optional();
const nodes = (min: number, max: number) => z.array(diagramNodeSchema).min(min).max(max);
const axisSchema = z.object({ low: textSchema, high: textSchema });
const sideSchema = z.object({ title: textSchema.optional(), items: nodes(1, 6) });

export const DIAGRAM_KINDS = [
  'flow',
  'cycle',
  'compare',
  'tree',
  'timeline',
  'matrix',
  'causal',
  'beforeAfter',
] as const;

/**
 * 도식은 정해진 종류의 구조만 받고 그림은 svg.ts가 그린다.
 * 모델이 쓴 SVG를 그대로 실으면 스크립트나 외부 링크가 섞일 수 있어서 원문은 받지 않는다
 */
export const diagramSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('flow'), caption: diagramCaption, steps: nodes(2, 8) }),
  z.object({ kind: z.literal('cycle'), caption: diagramCaption, steps: nodes(3, 8) }),
  z.object({
    kind: z.literal('compare'),
    caption: diagramCaption,
    columns: z
      .array(z.object({ title: textSchema, items: nodes(1, 6) }))
      .min(2)
      .max(4),
  }),
  z.object({ kind: z.literal('tree'), caption: diagramCaption, root: mindmapNodeSchema }),
  /** when은 영상 속 시점("1998년", "2단계")이다. 재생 시각은 cite가 이미 갖고 있다 */
  z.object({
    kind: z.literal('timeline'),
    caption: diagramCaption,
    events: z
      .array(z.object({ when: textSchema, label: textSchema, cite: citeSchema.optional() }))
      .min(2)
      .max(10),
  }),
  /** cells는 왼쪽 위, 오른쪽 위, 왼쪽 아래, 오른쪽 아래 순서다. 위가 y.high, 오른쪽이 x.high다 */
  z.object({
    kind: z.literal('matrix'),
    caption: diagramCaption,
    x: axisSchema,
    y: axisSchema,
    cells: z.array(z.array(diagramNodeSchema).max(4)).length(4),
  }),
  // 둘 다 비면 그림이 상자 하나라서 lint가 DIAGRAM_EMPTY로 막는다. 어느 쪽이 빈지 경로로 알리려고 스키마에서 안 잡는다
  z.object({
    kind: z.literal('causal'),
    caption: diagramCaption,
    inputs: z.array(diagramNodeSchema).max(6).default([]),
    center: diagramNodeSchema,
    outputs: z.array(diagramNodeSchema).max(6).default([]),
  }),
  z.object({
    kind: z.literal('beforeAfter'),
    caption: diagramCaption,
    before: sideSchema,
    after: sideSchema,
  }),
]);

export type Diagram = z.infer<typeof diagramSchema>;
export type DiagramKind = Diagram['kind'];
