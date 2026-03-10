import { z } from 'zod';
import { GestaltPrinciple } from '../core/types.js';

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
  confidence: z.number().min(0).max(1),
});

const seedMetadataSchema = z.object({
  seedId: z.string(),
  interviewSessionId: z.string(),
  ambiguityScore: z.number().min(0).max(1),
  generatedAt: z.string(),
});

export const seedSchema = z.object({
  version: z.string(),
  goal: z.string().min(1),
  constraints: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  ontologySchema: ontologySchemaSchema,
  gestaltAnalysis: z.array(gestaltAnalysisSchema),
  metadata: seedMetadataSchema,
});

export type ValidatedSeed = z.infer<typeof seedSchema>;
