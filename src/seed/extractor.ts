import type { InterviewSession, GestaltAnalysis, OntologySchema } from '../core/types.js';
import { buildSeedPrompt, INTERVIEW_SYSTEM_PROMPT } from '../llm/prompts.js';
import { SeedGenerationError } from '../core/errors.js';
import type { LLMAdapter } from '../llm/types.js';

export interface ExtractedData {
  goal: string;
  constraints: string[];
  acceptanceCriteria: string[];
  ontologySchema: OntologySchema;
  gestaltAnalysis: GestaltAnalysis[];
}

export class SeedExtractor {
  constructor(private llm: LLMAdapter) {}

  async extract(session: InterviewSession): Promise<ExtractedData> {
    const completedRounds = session.rounds
      .filter((r) => r.userResponse)
      .map((r) => ({
        question: r.question,
        response: r.userResponse!,
      }));

    if (completedRounds.length === 0) {
      throw new SeedGenerationError('No completed interview rounds to extract from');
    }

    const prompt = buildSeedPrompt(session.topic, completedRounds, session.projectType);

    const response = await this.llm.chat({
      system: INTERVIEW_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    });

    return parseSeedResponse(response.content);
  }
}

function parseSeedResponse(content: string): ExtractedData {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new SeedGenerationError('Failed to parse LLM response as JSON');
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    return {
      goal: asString(parsed['goal'], 'Undefined goal'),
      constraints: asStringArray(parsed['constraints']),
      acceptanceCriteria: asStringArray(parsed['acceptanceCriteria']),
      ontologySchema: parseOntology(parsed['ontologySchema']),
      gestaltAnalysis: parseGestaltAnalysis(parsed['gestaltAnalysis']),
    };
  } catch (e) {
    if (e instanceof SeedGenerationError) throw e;
    throw new SeedGenerationError(
      `Failed to parse seed data: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function parseOntology(value: unknown): OntologySchema {
  if (!value || typeof value !== 'object') {
    return { entities: [], relations: [] };
  }

  const obj = value as Record<string, unknown>;
  const entities = Array.isArray(obj['entities'])
    ? (obj['entities'] as Array<Record<string, unknown>>).map((e) => ({
        name: asString(e['name'], 'Unknown'),
        description: asString(e['description'], ''),
        attributes: asStringArray(e['attributes']),
      }))
    : [];

  const relations = Array.isArray(obj['relations'])
    ? (obj['relations'] as Array<Record<string, unknown>>).map((r) => ({
        from: asString(r['from'], ''),
        to: asString(r['to'], ''),
        type: asString(r['type'], ''),
      }))
    : [];

  return { entities, relations };
}

function parseGestaltAnalysis(value: unknown): GestaltAnalysis[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    .map((v) => ({
      principle: asString(v['principle'], 'closure') as GestaltAnalysis['principle'],
      finding: asString(v['finding'], ''),
      confidence: typeof v['confidence'] === 'number' ? v['confidence'] : 0.5,
    }));
}
