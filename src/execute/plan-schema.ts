import { z } from 'zod';

const classifiedACs = z.array(
  z.object({
    acIndex: z.number(),
    acText: z.string(),
    classification: z.enum(['figure', 'ground']),
    priority: z.enum(['critical', 'high', 'medium', 'low']),
    reasoning: z.string(),
  }),
);

const atomicTask = z.object({
  taskId: z.string(),
  title: z.string(),
  description: z.string(),
  sourceAC: z.array(z.number()),
  isImplicit: z.boolean(),
  estimatedComplexity: z.enum(['low', 'medium', 'high']),
  dependsOn: z.array(z.string()),
  model: z.enum(['haiku', 'sonnet', 'opus']).optional(),
});

const taskGroups = z.array(
  z.object({
    groupId: z.string(),
    name: z.string(),
    domain: z.string(),
    taskIds: z.array(z.string()),
    reasoning: z.string(),
  }),
);

const dagValidation = z.object({
  isValid: z.boolean(),
  hasCycles: z.boolean(),
  cycleDetails: z.array(z.string()).optional(),
  hasConflicts: z.boolean(),
  conflictDetails: z.array(z.string()).optional(),
  topologicalOrder: z.array(z.string()),
  criticalPath: z.array(z.string()),
});

export const planningStepSchema = z.object({
  principle: z.enum(['figure_ground', 'closure', 'proximity', 'continuity']),
  classifiedACs: classifiedACs.optional(),
  atomicTasks: z.array(atomicTask.omit({ model: true })).optional(),
  taskGroups: taskGroups.optional(),
  dagValidation: dagValidation.optional(),
});

export const executionPlanSchema = z.object({
  planId: z.string().uuid(),
  specId: z.string().min(1),
  classifiedACs,
  atomicTasks: z.array(atomicTask),
  taskGroups,
  dagValidation,
  parallelGroups: z.array(z.array(z.string())).default([]),
  createdAt: z.string(),
});
