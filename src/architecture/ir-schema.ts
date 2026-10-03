import { z } from 'zod';
import { ValidationError } from '../core/errors.js';
import { err, ok, type Result } from '../core/result.js';
import {
  ARCHITECTURE_IR_SCHEMA_VERSION,
  ARCHITECTURE_VIEWS,
  CONTEXT_SOURCE_VIAS,
  EDGE_KINDS,
  EVIDENCE_TYPES,
  LINE_STYLES,
  NODE_KINDS,
  VISIBILITIES,
  type ArchitectureIr,
} from './types.js';

export const architectureViewSchema = z.enum(ARCHITECTURE_VIEWS);
export const nodeKindSchema = z.enum(NODE_KINDS);
export const edgeKindSchema = z.enum(EDGE_KINDS);
export const evidenceTypeSchema = z.enum(EVIDENCE_TYPES);
export const visibilitySchema = z.enum(VISIBILITIES);
export const lineStyleSchema = z.enum(LINE_STYLES);
export const contextSourceViaSchema = z.enum(CONTEXT_SOURCE_VIAS);

const evidenceSchema = z.object({
  type: evidenceTypeSchema,
  location: z.string().min(1),
  updatedAt: z.string().optional(),
  visibility: visibilitySchema,
  excerpt: z.string().optional(),
});

const nodeSchema = z
  .object({
    id: z.string().min(1),
    kind: nodeKindSchema,
    label: z.string().min(1),
    displayName: z.string().min(1).optional(),
    displayNameInferred: z.boolean().optional(),
    repo: z.string(),
    parent: z.string().min(1).optional(),
    description: z.string().optional(),
    evidence: z.array(evidenceSchema),
  })
  .superRefine((node, ctx) => {
    if (node.displayNameInferred !== undefined && node.displayName === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['displayNameInferred'],
        message: 'displayNameInferred는 displayName이 있을 때만 쓸 수 있다',
      });
    }
  });

const edgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: edgeKindSchema,
  evidence: z.array(evidenceSchema),
  lineStyle: lineStyleSchema,
});

const unresolvedQuestionSchema = z.object({
  id: z.string().min(1),
  subject: z.object({
    nodeId: z.string().optional(),
    edgeId: z.string().optional(),
  }),
  question: z.string().min(1),
  answer: z.string().optional(),
});

const contextSourceSchema = z.object({
  via: contextSourceViaSchema,
  identifier: z.string().min(1),
  readOnly: z.boolean(),
  probeHit: z.boolean(),
  visibility: visibilitySchema,
});

const repoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  root: z.string().min(1),
  remote: z.string().optional(),
});

export const architectureIrSchema = z.object({
  schemaVersion: z.literal(ARCHITECTURE_IR_SCHEMA_VERSION),
  view: architectureViewSchema,
  repos: z.array(repoSchema),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  unresolved: z.array(unresolvedQuestionSchema),
  sourcesUsed: z.array(contextSourceSchema),
  generatedAt: z.string(),
});

export function parseArchitectureIr(input: unknown): Result<ArchitectureIr, ValidationError> {
  const parsed = architectureIrSchema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  return err(new ValidationError(`ArchitectureIR 형식 오류: ${issues.join('; ')}`, issues));
}
