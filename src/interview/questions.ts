import type { GestaltPrinciple, InterviewRound, ProjectType } from '../core/types.js';
import { buildQuestionPrompt, INTERVIEW_SYSTEM_PROMPT } from '../llm/prompts.js';
import type { LLMAdapter } from '../llm/types.js';

export interface GeneratedQuestion {
  question: string;
  reasoning: string;
}

export class QuestionGenerator {
  constructor(private llm: LLMAdapter) {}

  async generate(
    topic: string,
    principle: GestaltPrinciple,
    previousRounds: InterviewRound[],
    projectType: ProjectType,
  ): Promise<GeneratedQuestion> {
    const prompt = buildQuestionPrompt(
      topic,
      principle,
      previousRounds.map((r) => ({
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

    return parseQuestionResponse(response.content, topic, principle);
  }
}

function parseQuestionResponse(
  content: string,
  topic: string,
  principle: GestaltPrinciple,
): GeneratedQuestion {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return fallbackQuestion(topic, principle);
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const question = parsed['question'];
    const reasoning = parsed['reasoning'];

    if (typeof question === 'string' && question.length > 0) {
      return {
        question,
        reasoning: typeof reasoning === 'string' ? reasoning : '',
      };
    }
    return fallbackQuestion(topic, principle);
  } catch {
    return fallbackQuestion(topic, principle);
  }
}

function fallbackQuestion(topic: string, principle: GestaltPrinciple): GeneratedQuestion {
  const fallbacks: Record<GestaltPrinciple, string> = {
    closure: `"${topic}"에 대해 자세히 설명해 주시겠어요? 핵심 목표가 무엇인가요?`,
    proximity: `"${topic}"와 관련된 기능들을 어떻게 그룹핑하면 좋을까요?`,
    similarity: `"${topic}"에서 반복되는 패턴이나 공통 규칙이 있나요?`,
    figure_ground: `"${topic}"에서 반드시 포함되어야 하는 핵심 기능은 무엇인가요?`,
    continuity: `지금까지 말씀하신 내용 중 모순되거나 재확인이 필요한 부분이 있을까요?`,
  };

  return {
    question: fallbacks[principle],
    reasoning: `Fallback question for ${principle} principle`,
  };
}
