import { z } from 'zod';
import { GestaltPrinciple } from '../core/types.js';

// 스펙은 필드를 다 채우게 일부러 엄격하게 둔다.
// MCP 입력(mcp/schemas.ts)은 optional로 받는다. ges_spec의 passthrough 입력은 generator가 이 스키마로 다시 검사한다.
const ontologyEntitySchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  attributes: z.array(z.string()),
});

const ontologyRelationSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.string().min(1),
});

const ontologySchemaSchema = z.object({
  entities: z.array(ontologyEntitySchema),
  relations: z.array(ontologyRelationSchema),
});

const gestaltAnalysisSchema = z.object({
  principle: z.nativeEnum(GestaltPrinciple),
  finding: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});

const specMetadataSchema = z
  .object({
    specId: z.string(),
    interviewSessionId: z.string(),
    resolutionScore: z.number().min(0).max(1).nullable().optional(),
    // Backward compatibility: old Specs stored ambiguityScore (inverted scale)
    ambiguityScore: z.number().min(0).max(1).optional(),
    generatedAt: z.string(),
  })
  .transform((data) => ({
    specId: data.specId,
    interviewSessionId: data.interviewSessionId,
    generatedAt: data.generatedAt,
    resolutionScore:
      data.resolutionScore ?? (data.ambiguityScore != null ? 1 - data.ambiguityScore : null),
  }));

export const specSchema = z.object({
  version: z.string(),
  goal: z.string().min(1),
  constraints: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  ontologySchema: ontologySchemaSchema,
  gestaltAnalysis: z.array(gestaltAnalysisSchema),
  metadata: specMetadataSchema,
});

export type ValidatedSpec = z.infer<typeof specSchema>;
