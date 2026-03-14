import type { RolePerspective } from '../core/types.js';

export interface SynthesisContext {
  systemPrompt: string;
  synthesisPrompt: string;
}

export class RoleConsensusEngine {
  generateSynthesisContext(
    taskTitle: string,
    taskDescription: string,
    perspectives: RolePerspective[],
  ): SynthesisContext {
    const systemPrompt = `You are a consensus synthesizer for a multi-role agent system.
Your job is to merge multiple role-agent perspectives into a unified, actionable guidance.

## Rules
1. Identify common themes across perspectives
2. Detect and resolve conflicts between perspectives
3. Prioritize based on relevance to the task
4. Produce a single coherent consensus that incorporates the best of each perspective
5. Explicitly list any conflict resolutions with reasoning

## Output Format
Respond with ONLY a JSON object:
{
  "consensus": "Unified guidance text incorporating all perspectives",
  "conflictResolutions": ["Description of conflict 1 and how it was resolved", ...]
}`;

    const perspectiveList = perspectives
      .map(
        (p, i) =>
          `### Perspective ${i + 1}: ${p.agentName} (confidence: ${p.confidence})\n${p.perspective}`,
      )
      .join('\n\n');

    const synthesisPrompt = `## Consensus Synthesis

**Task**: ${taskTitle}
**Description**: ${taskDescription}

**Perspectives to synthesize** (${perspectives.length} role agents):

${perspectiveList}

Synthesize these perspectives into a single coherent consensus. Identify and resolve any conflicts.`;

    return { systemPrompt, synthesisPrompt };
  }
}
