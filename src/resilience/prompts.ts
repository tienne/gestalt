import type { Spec, EvaluationResult, EvolutionGeneration } from '../core/types.js';
import type { LateralPersonaName, StagnationPattern } from './types.js';

// ─── Persona System Prompts ────────────────────────────────────

const PERSONA_SYSTEM_PROMPTS: Record<LateralPersonaName, string> = {
  multistability: `You are Multistability — a Gestalt-inspired lateral thinker who sees the Necker Cube effect in requirements. When a system is stuck spinning at hard capacity, you flip the perceptual frame entirely.

## Your Strategy: Perspective Inversion
- Reframe the problem from a completely different angle
- What if the current "figure" requirements become "ground" and vice versa?
- Challenge the implicit assumptions baked into the current AC structure
- Look for hidden constraint interactions that block progress
- Consider: Is the goal being pursued from the wrong direction?

## Rules
1. Generate a SpecPatch that reframes (not just tweaks) the approach
2. Respect patch scope: L1(AC) + L2(constraints) free, L3(ontology) add/modify only, L4(goal) FORBIDDEN
3. Your patch should break the deadlock by offering an alternative path to the same goal
4. Respond with ONLY a JSON object matching the specified schema`,

  simplicity: `You are Simplicity — a Gestalt-inspired lateral thinker guided by Prägnanz (the law of good form). When a system oscillates between approaches, you converge toward the simplest viable solution.

## Your Strategy: Simplification & Convergence
- Identify the oscillation pattern: what two states is the system bouncing between?
- Find the simpler middle ground that satisfies both
- Remove over-specified or conflicting acceptance criteria
- Reduce constraints to their essential minimum
- Apply Occam's razor: the simplest solution that satisfies the goal

## Rules
1. Generate a SpecPatch that simplifies rather than adds complexity
2. Respect patch scope: L1(AC) + L2(constraints) free, L3(ontology) add/modify only, L4(goal) FORBIDDEN
3. Prefer removing or merging ACs over adding new ones
4. Respond with ONLY a JSON object matching the specified schema`,

  reification: `You are Reification — a Gestalt-inspired lateral thinker who perceives structure where none is explicitly shown. When a system shows no drift (zero progress), you construct the missing scaffolding.

## Your Strategy: Missing Structure Construction
- The system isn't moving because something essential is missing from the spec
- Look for implicit requirements that bridge existing ACs
- Identify missing entities or relations in the ontology
- Add intermediate acceptance criteria that create stepping stones
- Fill the "closure gap" — what would make the spec feel complete?

## Rules
1. Generate a SpecPatch that adds missing structure to unblock progress
2. Respect patch scope: L1(AC) + L2(constraints) free, L3(ontology) add/modify only, L4(goal) FORBIDDEN
3. Focus on adding bridging elements, not replacing existing ones
4. Respond with ONLY a JSON object matching the specified schema`,

  invariance: `You are Invariance — a Gestalt-inspired lateral thinker who recognizes stable structure beneath surface changes. When progress diminishes, you identify the invariant core and rebuild around it.

## Your Strategy: Invariant Core Recognition
- Identify what IS working (the stable, satisfied parts)
- Recognize the structural pattern that successful ACs share
- Restructure the failing ACs to follow the same invariant pattern
- The diminishing returns signal that surface changes aren't enough — find the deeper structure
- Preserve what's proven, transform what's stuck

## Rules
1. Generate a SpecPatch that restructures failing parts to match the invariant pattern of successes
2. Respect patch scope: L1(AC) + L2(constraints) free, L3(ontology) add/modify only, L4(goal) FORBIDDEN
3. Explicitly reference the successful patterns you're extending
4. Respond with ONLY a JSON object matching the specified schema`,
};

// ─── Lateral Prompt Builder ────────────────────────────────────

export function getLateralSystemPrompt(persona: LateralPersonaName): string {
  return PERSONA_SYSTEM_PROMPTS[persona];
}

export function buildLateralPrompt(
  persona: LateralPersonaName,
  pattern: StagnationPattern,
  spec: Spec,
  evaluationResult: EvaluationResult,
  evolutionHistory: EvolutionGeneration[],
  attemptNumber: number,
): string {
  const unsatisfied = evaluationResult.verifications
    .filter((v) => !v.satisfied)
    .map(
      (v) =>
        `  [${v.acIndex}] ${spec.acceptanceCriteria[v.acIndex] ?? 'N/A'}\n    gaps: ${v.gaps.join('; ')}`,
    )
    .join('\n');

  const satisfied = evaluationResult.verifications
    .filter((v) => v.satisfied)
    .map((v) => `  [${v.acIndex}] ${spec.acceptanceCriteria[v.acIndex] ?? 'N/A'}`)
    .join('\n');

  const historySummary =
    evolutionHistory.length > 0
      ? evolutionHistory
          .map(
            (g) =>
              `  Gen ${g.generation}: score=${g.evaluationScore.toFixed(2)}, goalAlign=${g.goalAlignment.toFixed(2)}, delta=[${g.delta.fieldsChanged.join(', ')}]`,
          )
          .join('\n')
      : '  (none)';

  const patternDescription: Record<StagnationPattern, string> = {
    spinning:
      'The system has hit a hard cap — multiple evolution attempts have not converged. A fundamentally different approach is needed.',
    oscillation:
      'The system is oscillating between states — scores go up then down repeatedly. Convergence to a stable solution is needed.',
    no_drift:
      'The system shows zero progress — score changes are negligible. Something essential is missing from the spec.',
    diminishing_returns:
      'Progress is diminishing — each iteration yields less improvement. The current approach may have a structural ceiling.',
  };

  return `## Lateral Thinking — ${persona.charAt(0).toUpperCase() + persona.slice(1)} Persona (Attempt ${attemptNumber}/4)

**Stagnation Pattern**: ${pattern}
${patternDescription[pattern]}

**Spec Goal** (IMMUTABLE): ${spec.goal}

**Current Constraints**: ${spec.constraints.map((c, i) => `\n  [${i}] ${c}`).join('')}

**Current Acceptance Criteria**: ${spec.acceptanceCriteria.map((ac, i) => `\n  [${i}] ${ac}`).join('')}

**Current Ontology**:
- Entities: ${spec.ontologySchema.entities.map((e) => `${e.name} (${e.attributes.join(', ')})`).join('; ')}
- Relations: ${spec.ontologySchema.relations.map((r) => `${r.from}→${r.to}[${r.type}]`).join(', ')}

**Satisfied Criteria**:
${satisfied || '  (none)'}

**Unsatisfied Criteria**:
${unsatisfied || '  (none)'}

**Evaluation Score**: ${evaluationResult.overallScore.toFixed(2)} | **Goal Alignment**: ${evaluationResult.goalAlignment.toFixed(2)}
**Recommendations**: ${evaluationResult.recommendations.join('; ')}

**Evolution History** (${evolutionHistory.length} generations):
${historySummary}

Apply your lateral thinking strategy and generate a Spec patch. Respond with ONLY a JSON object:
{
  "specPatch": {
    "acceptanceCriteria": ["updated AC list if changed"],
    "constraints": ["updated constraints if changed"],
    "ontologySchema": {
      "entities": [{"name": "...", "description": "...", "attributes": ["..."]}],
      "relations": [{"from": "...", "to": "...", "type": "..."}]
    }
  },
  "description": "Brief explanation of your lateral thinking approach and what you changed"
}

Rules:
- Only include specPatch fields that need to change
- acceptanceCriteria/constraints: provide the FULL list (not just additions)
- ontologySchema: must include ALL existing entities/relations + any new ones
- Your approach MUST differ from previous evolution attempts`;
}
