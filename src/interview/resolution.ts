import type { ResolutionScore, InterviewRound, ProjectType } from '../core/types.js';
import { computeResolutionScore } from '../gestalt/analyzer.js';
import { RESOLUTION_THRESHOLD } from '../core/constants.js';
import {
  buildResolutionPrompt,
  buildRescorePrompt,
  INTERVIEW_SYSTEM_PROMPT,
} from '../llm/prompts.js';
import type { LLMAdapter } from '../llm/types.js';

export class ResolutionScorer {
  constructor(
    private llm: LLMAdapter,
    private threshold: number = RESOLUTION_THRESHOLD,
  ) {}

  async score(
    topic: string,
    rounds: InterviewRound[],
    projectType: ProjectType,
  ): Promise<ResolutionScore> {
    return this.scoreWith(buildResolutionPrompt, topic, rounds, projectType);
  }

  /** 처음 기준값을 넘은 채점을 같은 모델로 한 번 더 받는다. 새 호출이라 앞 채점을 못 본다 */
  async rescore(
    topic: string,
    rounds: InterviewRound[],
    projectType: ProjectType,
  ): Promise<ResolutionScore> {
    return this.scoreWith(buildRescorePrompt, topic, rounds, projectType);
  }

  private async scoreWith(
    buildPrompt: typeof buildResolutionPrompt,
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
        threshold: this.threshold,
      };
    }

    const prompt = buildPrompt(
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
    return computeResolutionScore(raw, projectType, this.threshold);
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
