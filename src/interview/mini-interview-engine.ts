import { RESOLUTION_THRESHOLD } from '../core/constants.js';
import { INTERVIEW_SYSTEM_PROMPT } from '../llm/prompts.js';

// ─── Types ──────────────────────────────────────────────────────

export interface MiniInterviewQuestion {
  dimension: string;
  prompt: string;
  rationale: string;
}

export interface MiniInterviewContext {
  systemPrompt: string;
  questions: MiniInterviewQuestion[];
  scoringPrompt: string;
  sourceTopic: string;
  message: string;
}

export interface ResolutionDimensionScore {
  goalClarity: number;
  constraintClarity: number;
  successCriteria: number;
  priorityClarity: number;
  contextClarity?: number;
  contradictions?: string[];
}

// ─── Helpers ────────────────────────────────────────────────────

function getDimensionsNeedingClarification(score: ResolutionDimensionScore): string[] {
  const clarityFloor = 1 - RESOLUTION_THRESHOLD;
  const dims: string[] = [];
  if (score.goalClarity < clarityFloor) dims.push('goalClarity');
  if (score.constraintClarity < clarityFloor) dims.push('constraintClarity');
  if (score.successCriteria < clarityFloor) dims.push('successCriteria');
  if (score.priorityClarity < clarityFloor) dims.push('priorityClarity');
  if (score.contextClarity !== undefined && score.contextClarity < clarityFloor) {
    dims.push('contextClarity');
  }
  return dims;
}

function dimensionToLabel(dim: string): string {
  const labels: Record<string, string> = {
    goalClarity: 'Project goal and objectives',
    constraintClarity: 'Technical or business constraints',
    successCriteria: 'Measurable success criteria',
    priorityClarity: 'Feature prioritization and MVP scope',
    contextClarity: 'Existing system or project context',
  };
  return labels[dim] ?? dim;
}

function buildMiniQuestionPrompt(
  topic: string,
  ambiguousText: string,
  dimensions: string[],
): string {
  const dimLabels = dimensions.map((d) => `- ${dimensionToLabel(d)}`).join('\n');

  return `Given this text description:
---
${ambiguousText}
---

Topic: "${topic}"

The following dimensions still need clarification:
${dimLabels}

Generate ONE targeted question per dimension to resolve the remaining ambiguity.
Respond with ONLY a JSON array:
[
  {
    "dimension": "goalClarity|constraintClarity|successCriteria|priorityClarity|contextClarity",
    "prompt": "Your clarifying question here",
    "rationale": "Why this question resolves the ambiguity"
  }
]`;
}

function buildMiniScoringPrompt(
  topic: string,
  originalText: string,
  answers: Array<{ question: string; answer: string }>,
): string {
  const qa = answers
    .map((a, i) => `Q${i + 1}: ${a.question}\nA${i + 1}: ${a.answer}`)
    .join('\n\n');

  return `Re-score the ambiguity of this project description after the follow-up Q&A.

Original description: "${originalText}"
Topic: "${topic}"

Follow-up Q&A:
${qa}

Score each dimension from 0.0 (completely ambiguous) to 1.0 (crystal clear).

Respond with ONLY a JSON object:
{
  "goalClarity": 0.0-1.0,
  "constraintClarity": 0.0-1.0,
  "successCriteria": 0.0-1.0,
  "priorityClarity": 0.0-1.0,
  "contradictions": [],
  "reasoning": "Brief analysis"
}`;
}

// ─── Engine ─────────────────────────────────────────────────────

export class MiniInterviewEngine {
  /**
   * Given an initial ambiguity score from text-based spec generation,
   * determine if a mini-interview is needed and build the clarification context.
   */
  needsMiniInterview(score: ResolutionDimensionScore): boolean {
    const dims = getDimensionsNeedingClarification(score);
    return dims.length > 0;
  }

  buildClarificationContext(
    topic: string,
    text: string,
    score: ResolutionDimensionScore,
  ): MiniInterviewContext {
    const dims = getDimensionsNeedingClarification(score);

    return {
      systemPrompt: INTERVIEW_SYSTEM_PROMPT,
      questions: dims.map((d) => ({
        dimension: d,
        prompt: '',  // Caller LLM fills this in using the clarification prompt
        rationale: '',
      })),
      scoringPrompt: buildMiniQuestionPrompt(topic, text, dims),
      sourceTopic: topic,
      message: `${dims.length} dimension(s) need clarification: ${dims.map(dimensionToLabel).join(', ')}. Use the scoringPrompt to generate clarifying questions.`,
    };
  }

  buildReScoringContext(
    topic: string,
    text: string,
    answers: Array<{ question: string; answer: string }>,
  ): string {
    return buildMiniScoringPrompt(topic, text, answers);
  }
}
