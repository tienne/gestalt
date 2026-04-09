import type { ResolutionScore, InterviewRound, ProjectType } from '../core/types.js';
import { computeResolutionScore } from '../gestalt/analyzer.js';
import { buildResolutionPrompt, INTERVIEW_SYSTEM_PROMPT } from '../llm/prompts.js';
import type { LLMAdapter } from '../llm/types.js';

export class ResolutionScorer {
  constructor(private llm: LLMAdapter) {}

  async score(
    topic: string,
    rounds: InterviewRound[],
    projectType: ProjectType,
  ): Promise<ResolutionScore> {
    const answeredRounds = rounds.filter((r) => r.userResponse);
    if (answeredRounds.length === 0) {
      return {
        overall: 0.0,
        dimensions: [],
        isReady: false,
      };
    }

    const prompt = buildResolutionPrompt(
      topic,
      answeredRounds.map((r) => ({
        question: r.question,
        response: r.userResponse,
      })),
      projectType,
    );

    const response = await this.llm.chat({
      system: INTERVIEW_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    });

    const raw = parseResolutionResponse(response.content, projectType);
    return computeResolutionScore(raw, projectType);
  }
}

interface RawLLMScores {
  goalClarity: number;
  constraintClarity: number;
  successCriteria: number;
  priorityClarity: number;
  contextClarity?: number;
  contradictions: string[];
}

function parseResolutionResponse(content: string, projectType: ProjectType): RawLLMScores {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return defaultScores(projectType);
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return {
      goalClarity: toNumber(parsed['goalClarity'], 0),
      constraintClarity: toNumber(parsed['constraintClarity'], 0),
      successCriteria: toNumber(parsed['successCriteria'], 0),
      priorityClarity: toNumber(parsed['priorityClarity'], 0),
      contextClarity:
        projectType === 'brownfield' ? toNumber(parsed['contextClarity'], 0) : undefined,
      contradictions: Array.isArray(parsed['contradictions'])
        ? (parsed['contradictions'] as string[])
        : [],
    };
  } catch {
    return defaultScores(projectType);
  }
}

function defaultScores(projectType: ProjectType): RawLLMScores {
  return {
    goalClarity: 0,
    constraintClarity: 0,
    successCriteria: 0,
    priorityClarity: 0,
    contextClarity: projectType === 'brownfield' ? 0 : undefined,
    contradictions: [],
  };
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && !isNaN(value)) return value;
  return fallback;
}
