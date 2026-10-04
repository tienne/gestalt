import { z } from 'zod';
import { ValidationError } from '../core/errors.js';
import { err, ok, type Result } from '../core/result.js';
import {
  ARCHITECTURE_IR_SCHEMA_VERSION,
  ARCHITECTURE_VIEWS,
  CONTEXT_SOURCE_VIAS,
  EDGE_KINDS,
  ENDPOINT_PROTOCOLS,
  ENVIRONMENT_KINDS,
  EVIDENCE_TYPES,
  FLOW_ACTOR_KINDS,
  FLOW_PATHS,
  LINE_STYLES,
  NODE_KINDS,
  PLATFORMS,
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
export const platformSchema = z.enum(PLATFORMS);

const evidenceSchema = z
  .object({
    type: evidenceTypeSchema,
    location: z.string().min(1),
    updatedAt: z.string().optional(),
    visibility: visibilitySchema,
    excerpt: z.string().optional(),
    command: z.string().min(1).optional(),
    observedAt: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((ev, ctx) => {
    if (ev.type === 'live') {
      if (ev.command === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['command'],
          message: 'live 근거에는 실행한 명령(command)이 있어야 한다',
        });
      }
      if (ev.observedAt === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['observedAt'],
          message: 'live 근거에는 조회 시각(observedAt)이 있어야 한다',
        });
      }
      return;
    }
    for (const key of ['command', 'observedAt'] as const) {
      if (ev[key] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key}는 live 근거에만 쓸 수 있다`,
        });
      }
    }
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
    environment: z.string().min(1).optional(),
    engine: z.string().min(1).optional(),
    account: z.string().min(1).optional(),
    platforms: z.array(platformSchema).optional(),
    platformEvidence: z.record(platformSchema, z.array(evidenceSchema)).optional(),
    protocol: z.enum(ENDPOINT_PROTOCOLS).optional(),
    mcpServer: z.string().min(1).optional(),
    actions: z.array(z.string().min(1)).optional(),
  })
  .superRefine((node, ctx) => {
    const custom = (path: string, message: string): void =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (node.kind !== 'service') {
      if (node.platforms !== undefined)
        custom('platforms', 'platforms는 service 노드에만 쓸 수 있다');
      if (node.platformEvidence !== undefined) {
        custom('platformEvidence', 'platformEvidence는 service 노드에만 쓸 수 있다');
      }
    }
    if (node.platforms !== undefined && new Set(node.platforms).size !== node.platforms.length) {
      custom('platforms', 'platforms에 같은 값이 두 번 들어 있다');
    }
    if (node.environment !== undefined && !ENVIRONMENT_KINDS.includes(node.kind)) {
      custom('environment', `environment는 ${ENVIRONMENT_KINDS.join(', ')} 노드에만 쓸 수 있다`);
    }
    if (node.engine !== undefined && node.kind !== 'datastore') {
      custom('engine', 'engine은 datastore 노드에만 쓸 수 있다');
    }
    if (node.account !== undefined && node.kind === 'cloud_account') {
      custom('account', 'cloud_account 노드는 account를 가질 수 없다');
    }
    if (node.protocol !== undefined && node.kind !== 'endpoint') {
      custom('protocol', 'protocol은 endpoint 노드에만 쓸 수 있다');
    }
    if (node.protocol !== 'mcp') {
      if (node.mcpServer !== undefined)
        custom('mcpServer', 'mcpServer는 mcp endpoint에만 쓸 수 있다');
      if (node.actions !== undefined) custom('actions', 'actions는 mcp endpoint에만 쓸 수 있다');
    }
    if (node.actions !== undefined && new Set(node.actions).size !== node.actions.length) {
      custom('actions', 'actions에 같은 값이 두 번 들어 있다');
    }
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
  actions: z.array(z.string().min(1)).min(1).optional(),
});

const unresolvedQuestionSchema = z.object({
  id: z.string().min(1),
  subject: z.object({
    nodeId: z.string().optional(),
    edgeId: z.string().optional(),
    stepId: z.string().optional(),
    transitionId: z.string().optional(),
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

const groupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  members: z.array(z.string().min(1)).min(1),
});

const flowActorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(FLOW_ACTOR_KINDS),
});

const flowStepSchema = z.object({
  id: z.string().min(1),
  actor: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  state: z.string().min(1).optional(),
  terminal: z.boolean().optional(),
  refs: z.array(z.string().min(1)).optional(),
  evidence: z.array(evidenceSchema),
});

const flowTransitionSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  path: z.enum(FLOW_PATHS),
  label: z.string().min(1).optional(),
  actors: z.array(z.string().min(1)).min(1).optional(),
  evidence: z.array(evidenceSchema),
  lineStyle: lineStyleSchema,
});

const flowSchema = z.object({
  id: z.string().min(1),
  service: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  stateLabels: z.record(z.string().min(1), z.string().min(1)).optional(),
  actors: z.array(flowActorSchema).min(1),
  steps: z.array(flowStepSchema).min(1),
  transitions: z.array(flowTransitionSchema),
});

const stageSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  nodes: z.array(z.string().min(1)).optional(),
  kinds: z.array(nodeKindSchema).optional(),
  repos: z.array(z.string().min(1)).optional(),
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
  groups: z.array(groupSchema).optional(),
  flows: z.array(flowSchema).optional(),
  stages: z.array(stageSchema).optional(),
});

export function parseArchitectureIr(input: unknown): Result<ArchitectureIr, ValidationError> {
  const parsed = architectureIrSchema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  return err(new ValidationError(`ArchitectureIR 형식 오류: ${issues.join('; ')}`, issues));
}
