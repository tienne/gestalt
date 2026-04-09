import type { AgentDefinition } from '../core/types.js';

export interface MatchContext {
  systemPrompt: string;
  matchingPrompt: string;
  availableAgents: Array<{ name: string; domain: string[]; description: string }>;
}

export class RoleMatchEngine {
  generateMatchContext(
    taskId: string,
    taskTitle: string,
    taskDescription: string,
    roleAgents: AgentDefinition[],
  ): MatchContext {
    const availableAgents = roleAgents.map((a) => ({
      name: a.frontmatter.name,
      domain: a.frontmatter.domain ?? [],
      description: a.frontmatter.description,
    }));

    const systemPrompt = `You are a role-agent matcher for the Gestalt execution system.
Your job is to analyze a task and determine which role agents are relevant.

## Rules
1. Match based on task content, not just keywords — understand the intent
2. A task can match 0 or more role agents
3. Each match should include a relevance score (0.0-1.0) and reasoning
4. Only match agents whose expertise is genuinely useful for the task
5. Err on the side of inclusion — it's better to include a marginally relevant agent than miss a useful one

## Output Format
Respond with ONLY a JSON object:
{
  "matches": [
    {
      "agentName": "name",
      "domain": ["relevant", "domains"],
      "relevanceScore": 0.85,
      "reasoning": "Why this agent is relevant"
    }
  ]
}`;

    const agentList = availableAgents
      .map((a) => `- **${a.name}**: ${a.description} (domains: ${a.domain.join(', ')})`)
      .join('\n');

    const matchingPrompt = `## Role Agent Matching

**Task ID**: ${taskId}
**Task**: ${taskTitle}
**Description**: ${taskDescription}

**Available Role Agents** (${availableAgents.length}):
${agentList}

Analyze the task and select the most relevant role agents. Return matches sorted by relevance score (highest first).`;

    return { systemPrompt, matchingPrompt, availableAgents };
  }
}
