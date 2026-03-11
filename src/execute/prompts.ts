import type { Seed, ClassifiedAC, AtomicTask, TaskGroup, PlanningStepResult } from '../core/types.js';
import {
  PLANNING_PRINCIPLE_SEQUENCE,
  PLANNING_PRINCIPLE_STRATEGIES,
  PLANNING_TOTAL_STEPS,
} from '../core/constants.js';

// ─── System Prompt ──────────────────────────────────────────────

export const EXECUTE_SYSTEM_PROMPT = `You are a Gestalt-trained execution planner. Your goal is to transform a validated Seed specification into a concrete, dependency-aware Execution Plan by applying Gestalt psychology principles as a structured planning framework.

## Planning Phases (in order)
1. **Figure-Ground**: Classify acceptance criteria as essential (figure) or supplementary (ground), assign priorities
2. **Closure**: Decompose ACs into atomic tasks, identify implicit sub-tasks not explicitly stated
3. **Proximity**: Group related atomic tasks into logical task groups by domain
4. **Continuity**: Validate the dependency DAG — ensure no cycles, no conflicts, clear execution order

## Rules
1. Each phase must complete before the next begins
2. Every acceptance criterion must be addressed
3. Atomic tasks must be independently executable units
4. All tasks must belong to exactly one group
5. The final DAG must be acyclic with a valid topological ordering
6. Always respond with ONLY a JSON object matching the specified schema`;

// ─── Step Prompts ───────────────────────────────────────────────

export function buildFigureGroundPrompt(seed: Seed): string {
  const acList = seed.acceptanceCriteria
    .map((ac, i) => `  [${i}] ${ac}`)
    .join('\n');

  return `## Phase 1: Figure-Ground Classification

Classify each acceptance criterion as "figure" (essential, core functionality) or "ground" (supplementary, nice-to-have).

**Seed Goal**: ${seed.goal}

**Constraints**:
${seed.constraints.map((c) => `- ${c}`).join('\n')}

**Acceptance Criteria**:
${acList}

**Ontology Entities**: ${seed.ontologySchema.entities.map((e) => e.name).join(', ')}

Respond with ONLY a JSON object:
{
  "principle": "figure_ground",
  "classifiedACs": [
    {
      "acIndex": 0,
      "acText": "the AC text",
      "classification": "figure" | "ground",
      "priority": "critical" | "high" | "medium" | "low",
      "reasoning": "why this classification"
    }
  ]
}

Rules:
- Every AC must be classified (indices 0 to ${seed.acceptanceCriteria.length - 1})
- "figure" ACs should be the minimum set needed for the goal
- Priority reflects execution order importance`;
}

export function buildClosurePrompt(seed: Seed, figureGroundResult: ClassifiedAC[]): string {
  const classified = figureGroundResult
    .map((ac) => `  [${ac.acIndex}] (${ac.classification}/${ac.priority}) ${ac.acText}`)
    .join('\n');

  return `## Phase 2: Closure — Atomic Task Decomposition

Decompose the classified acceptance criteria into atomic, independently executable tasks. Identify implicit sub-tasks that are required but not explicitly stated.

**Seed Goal**: ${seed.goal}

**Classified ACs**:
${classified}

**Ontology**:
- Entities: ${seed.ontologySchema.entities.map((e) => `${e.name} (${e.attributes.join(', ')})`).join('; ')}
- Relations: ${seed.ontologySchema.relations.map((r) => `${r.from} → ${r.to} [${r.type}]`).join('; ')}

Respond with ONLY a JSON object:
{
  "principle": "closure",
  "atomicTasks": [
    {
      "taskId": "task-1",
      "title": "Short task title",
      "description": "What needs to be done",
      "sourceAC": [0, 1],
      "isImplicit": false,
      "estimatedComplexity": "low" | "medium" | "high",
      "dependsOn": ["task-0"]
    }
  ]
}

Rules:
- taskId must be unique (use "task-0", "task-1", ...)
- sourceAC references AC indices from the classification step
- isImplicit=true for tasks inferred but not directly stated in any AC
- dependsOn references other taskIds (can be empty)
- Each task should be a single, testable unit of work`;
}

export function buildProximityPrompt(seed: Seed, atomicTasks: AtomicTask[]): string {
  const taskList = atomicTasks
    .map((t) => `  ${t.taskId}: ${t.title} [${t.estimatedComplexity}] depends: [${t.dependsOn.join(', ')}]`)
    .join('\n');

  return `## Phase 3: Proximity — Task Grouping

Group related atomic tasks into logical task groups based on domain, functionality, or natural affinity.

**Seed Goal**: ${seed.goal}

**Atomic Tasks**:
${taskList}

**Ontology Entities**: ${seed.ontologySchema.entities.map((e) => e.name).join(', ')}

Respond with ONLY a JSON object:
{
  "principle": "proximity",
  "taskGroups": [
    {
      "groupId": "group-1",
      "name": "Group Name",
      "domain": "Domain area",
      "taskIds": ["task-0", "task-1"],
      "reasoning": "Why these tasks belong together"
    }
  ]
}

Rules:
- Every task must belong to exactly one group
- groupId must be unique (use "group-0", "group-1", ...)
- taskIds must reference valid task IDs from the atomic tasks list
- Groups should reflect natural domain boundaries`;
}

export function buildContinuityPrompt(
  seed: Seed,
  atomicTasks: AtomicTask[],
  taskGroups: TaskGroup[],
): string {
  const taskList = atomicTasks
    .map((t) => `  ${t.taskId}: ${t.title} → depends: [${t.dependsOn.join(', ')}]`)
    .join('\n');

  const groupList = taskGroups
    .map((g) => `  ${g.groupId} (${g.name}): [${g.taskIds.join(', ')}]`)
    .join('\n');

  return `## Phase 4: Continuity — DAG Validation

Validate the dependency graph for consistency. Check for cycles, conflicts between groups, and compute the execution order.

**Seed Goal**: ${seed.goal}

**Tasks & Dependencies**:
${taskList}

**Task Groups**:
${groupList}

Respond with ONLY a JSON object:
{
  "principle": "continuity",
  "dagValidation": {
    "isValid": true | false,
    "hasCycles": true | false,
    "cycleDetails": ["task-A → task-B → task-A"],
    "hasConflicts": true | false,
    "conflictDetails": ["description of conflict"],
    "topologicalOrder": ["task-0", "task-2", "task-1"],
    "criticalPath": ["task-0", "task-1", "task-3"]
  }
}

Rules:
- topologicalOrder: valid ordering where each task comes after its dependencies
- criticalPath: the longest chain of dependent tasks (determines minimum execution time)
- If cycles or conflicts are found, isValid must be false
- cycleDetails/conflictDetails should describe the issues found`;
}

// ─── Dispatcher ─────────────────────────────────────────────────

export function buildPlanningStepPrompt(
  seed: Seed,
  stepNumber: number,
  previousSteps: PlanningStepResult[],
): string {
  const principle = PLANNING_PRINCIPLE_SEQUENCE[stepNumber - 1];
  if (!principle) {
    throw new Error(`Invalid step number: ${stepNumber}. Must be 1-${PLANNING_TOTAL_STEPS}`);
  }

  switch (stepNumber) {
    case 1:
      return buildFigureGroundPrompt(seed);
    case 2: {
      const fgResult = previousSteps.find((s) => s.principle === 'figure_ground') as
        | { classifiedACs: ClassifiedAC[] }
        | undefined;
      return buildClosurePrompt(seed, fgResult?.classifiedACs ?? []);
    }
    case 3: {
      const closureResult = previousSteps.find((s) => s.principle === 'closure') as
        | { atomicTasks: AtomicTask[] }
        | undefined;
      return buildProximityPrompt(seed, closureResult?.atomicTasks ?? []);
    }
    case 4: {
      const closureResult2 = previousSteps.find((s) => s.principle === 'closure') as
        | { atomicTasks: AtomicTask[] }
        | undefined;
      const proximityResult = previousSteps.find((s) => s.principle === 'proximity') as
        | { taskGroups: TaskGroup[] }
        | undefined;
      return buildContinuityPrompt(
        seed,
        closureResult2?.atomicTasks ?? [],
        proximityResult?.taskGroups ?? [],
      );
    }
    default:
      throw new Error(`Invalid step number: ${stepNumber}`);
  }
}
