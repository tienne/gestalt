import { INTERVIEW_SYSTEM_PROMPT } from '../llm/prompts.js';
import type { AgentRegistry } from '../agent/registry.js';
import { mergeSystemPrompt } from '../agent/prompt-resolver.js';
import type { ProjectMemory } from '../core/types.js';
import { SpecTemplateRegistry } from './templates.js';

export interface TextSpecContext {
  systemPrompt: string;
  specPrompt: string;
  memoryContext?: string;
  templateId?: string;
}

function buildMemorySection(memory: ProjectMemory): string {
  if (memory.specHistory.length === 0 && memory.architectureDecisions.length === 0) {
    return '';
  }

  const lines: string[] = ['## Prior Project Context (from .gestalt/memory.json)'];

  if (memory.specHistory.length > 0) {
    lines.push('\n### Previous Specs');
    for (const entry of memory.specHistory.slice(-5)) {
      lines.push(`- [${entry.createdAt.slice(0, 10)}] ${entry.goal} (specId: ${entry.specId})`);
    }
  }

  if (memory.architectureDecisions.length > 0) {
    lines.push('\n### Architecture Decisions');
    for (const decision of memory.architectureDecisions) {
      lines.push(`- ${decision}`);
    }
  }

  return lines.join('\n');
}

function buildTextSpecPrompt(text: string, memoryContext?: string, templateContext?: string): string {
  return `Generate a complete project specification (Spec) from the following description.
${memoryContext ? `\n${memoryContext}\n` : ''}${templateContext ? `\n${templateContext}\n` : ''}
## Description
${text}

Respond with ONLY a JSON object:
{
  "goal": "Clear, concise project goal",
  "constraints": ["constraint 1", "constraint 2"],
  "acceptanceCriteria": ["criterion 1", "criterion 2"],
  "ontologySchema": {
    "entities": [{"name": "EntityName", "description": "what it is", "attributes": ["attr1"]}],
    "relations": [{"from": "Entity1", "to": "Entity2", "type": "relationship_type"}]
  },
  "gestaltAnalysis": [
    {"principle": "closure|proximity|similarity|figure_ground|continuity", "finding": "what was inferred", "confidence": 0.0-1.0}
  ]
}`;
}

export class TextBasedSpecGenerator {
  private agentRegistry?: AgentRegistry;
  private templateRegistry: SpecTemplateRegistry;

  constructor(agentRegistry?: AgentRegistry) {
    this.agentRegistry = agentRegistry;
    this.templateRegistry = new SpecTemplateRegistry();
  }

  buildSpecContext(text: string, memory?: ProjectMemory, templateId?: string): TextSpecContext {
    const systemPrompt = mergeSystemPrompt(INTERVIEW_SYSTEM_PROMPT, this.agentRegistry, 'spec');

    const memoryContext = memory ? buildMemorySection(memory) : undefined;
    const templateContext = templateId ? this.templateRegistry.buildTemplateContext(templateId) ?? undefined : undefined;
    const specPrompt = buildTextSpecPrompt(text, memoryContext || undefined, templateContext);

    return {
      systemPrompt,
      specPrompt,
      memoryContext: memoryContext || undefined,
      templateId: templateId || undefined,
    };
  }
}
