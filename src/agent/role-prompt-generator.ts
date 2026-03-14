import type { AgentDefinition } from '../core/types.js';

export interface PerspectivePrompt {
  agentName: string;
  systemPrompt: string;
  perspectivePrompt: string;
}

export class RolePromptGenerator {
  generatePerspectivePrompts(
    taskTitle: string,
    taskDescription: string,
    matchedAgents: AgentDefinition[],
  ): PerspectivePrompt[] {
    return matchedAgents.map((agent) => ({
      agentName: agent.frontmatter.name,
      systemPrompt: agent.systemPrompt,
      perspectivePrompt: `## Task Review Request

**Task**: ${taskTitle}
**Description**: ${taskDescription}

As a **${agent.frontmatter.name}** (${agent.frontmatter.description}), provide your expert perspective on this task.

Focus on your domain expertise and provide actionable guidance. Respond with ONLY a JSON object:
{
  "agentName": "${agent.frontmatter.name}",
  "perspective": "Your detailed perspective and recommendations",
  "confidence": 0.85
}`,
    }));
  }
}
