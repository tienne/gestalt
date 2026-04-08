import { GestaltPrinciple } from '../core/types.js';
import { PRINCIPLE_QUESTION_STRATEGIES } from '../core/constants.js';

export const INTERVIEW_SYSTEM_PROMPT = `You are a Gestalt-trained requirements analyst. Your goal is to transform vague ideas into crystal-clear specifications by applying Gestalt psychology principles.

## Core Principles
- **Closure**: Fill in missing requirements — identify what's implied but unstated
- **Proximity**: Group related requirements — find natural clusters
- **Similarity**: Identify patterns — spot recurring themes across requirements
- **Figure-Ground**: Separate essential from optional — clarify MVP scope
- **Continuity**: Cross-validate consistency — detect contradictions

## Rules
1. Ask ONE focused question at a time
2. Each question should target a specific Gestalt principle
3. Build on previous answers — don't repeat what's already clear
4. Be conversational but precise
5. When detecting contradictions (Continuity), address them directly but diplomatically
6. Always respond in the user's language`;

export function buildQuestionPrompt(
  topic: string,
  principle: GestaltPrinciple,
  previousRounds: { question: string; response: string | null }[],
  projectType: 'greenfield' | 'brownfield',
): string {
  const strategy = PRINCIPLE_QUESTION_STRATEGIES[principle];
  const history = previousRounds
    .map((r, i) => `Round ${i + 1}:\nQ: ${r.question}\nA: ${r.response ?? '(no response)'}`)
    .join('\n\n');

  return `Topic: "${topic}"
Project type: ${projectType}
Current Gestalt focus: ${principle}
Strategy: ${strategy}

${history ? `Previous rounds:\n${history}\n\n` : ''}Generate the next interview question. Apply the ${principle} principle.

Respond with ONLY a JSON object:
{
  "question": "Your question here",
  "reasoning": "Brief explanation of why this question matters for ${principle}"
}`;
}

export function buildResolutionPrompt(
  topic: string,
  rounds: { question: string; response: string | null }[],
  projectType: 'greenfield' | 'brownfield',
): string {
  const history = rounds
    .filter((r) => r.response)
    .map((r, i) => `Q${i + 1}: ${r.question}\nA${i + 1}: ${r.response}`)
    .join('\n\n');

  return `Analyze the clarity of this interview for: "${topic}" (${projectType} project)

Interview transcript:
${history}

Score each dimension from 0.0 (completely ambiguous) to 1.0 (crystal clear).
Also detect any contradictions between answers.

Respond with ONLY a JSON object:
{
  "goalClarity": 0.0-1.0,
  "constraintClarity": 0.0-1.0,
  "successCriteria": 0.0-1.0,
  "priorityClarity": 0.0-1.0,
  ${projectType === 'brownfield' ? '"contextClarity": 0.0-1.0,' : ''}
  "contradictions": [],
  "reasoning": "Brief analysis"
}`;
}

export function buildSpecPrompt(
  topic: string,
  rounds: { question: string; response: string }[],
  projectType: 'greenfield' | 'brownfield',
): string {
  const history = rounds
    .map((r, i) => `Q${i + 1}: ${r.question}\nA${i + 1}: ${r.response}`)
    .join('\n\n');

  return `Generate a complete project specification (Spec) from this interview about: "${topic}" (${projectType} project)

Interview transcript:
${history}

Respond with ONLY a JSON object:
{
  "goal": "Clear, concise project goal",
  "constraints": ["constraint 1", "constraint 2", ...],
  "acceptanceCriteria": ["criterion 1", "criterion 2", ...],
  "ontologySchema": {
    "entities": [{"name": "EntityName", "description": "what it is", "attributes": ["attr1", "attr2"]}],
    "relations": [{"from": "Entity1", "to": "Entity2", "type": "relationship_type"}]
  },
  "gestaltAnalysis": [
    {"principle": "closure|proximity|similarity|figure_ground|continuity", "finding": "what was discovered", "confidence": 0.0-1.0}
  ]
}`;
}
