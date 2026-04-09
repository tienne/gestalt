import type { AgentDefinition, ReviewContext } from '../core/types.js';

export interface ReviewMatchContext {
  systemPrompt: string;
  matchingPrompt: string;
  availableAgents: Array<{ name: string; domain: string[]; description: string; category: string }>;
}

export class ReviewAgentMatcher {
  generateMatchContext(
    reviewContext: ReviewContext,
    roleAgents: AgentDefinition[],
    reviewAgents: AgentDefinition[],
  ): ReviewMatchContext {
    const allAgents = [...roleAgents, ...reviewAgents];
    const availableAgents = allAgents.map((a) => ({
      name: a.frontmatter.name,
      domain: a.frontmatter.domain ?? [],
      description: a.frontmatter.description,
      category: a.frontmatter.pipeline === 'review' ? 'review-specialist' : 'role-agent',
    }));

    const systemPrompt = `You are a code review agent matcher for the Gestalt pipeline.
Your job is to select the most relevant agents for reviewing the code changes.

## Agent Types
- **role-agent**: Domain experts (e.g., architect, frontend-developer) who review from their specialty perspective
- **review-specialist**: Code review experts (e.g., security-reviewer, performance-reviewer) who review specific quality aspects

## Rules
1. Always include at least one review-specialist
2. Match role-agents based on the domain of changed files
3. Each match should include a relevance score (0.0-1.0) and reasoning
4. Consider the spec goal and constraints when matching

## Output Format
Respond with ONLY a JSON object:
{
  "matches": [
    {
      "agentName": "name",
      "domain": ["relevant", "domains"],
      "relevanceScore": 0.85,
      "reasoning": "Why this agent should review"
    }
  ]
}`;

    const agentList = availableAgents
      .map(
        (a) =>
          `- **${a.name}** [${a.category}]: ${a.description} (domains: ${a.domain.join(', ')})`,
      )
      .join('\n');

    const fileList = reviewContext.changedFiles.join('\n  ');
    const depList =
      reviewContext.dependencyFiles.length > 0
        ? reviewContext.dependencyFiles.join('\n  ')
        : '(none)';

    const matchingPrompt = `## Code Review Agent Matching

**Spec Goal**: ${reviewContext.spec.goal}

**Changed Files** (${reviewContext.changedFiles.length}):
  ${fileList}

**Dependency Context** (${reviewContext.dependencyFiles.length}):
  ${depList}

**Task Results Summary**: ${reviewContext.taskResults.length} tasks completed

**Available Agents** (${availableAgents.length}):
${agentList}

Select the most relevant agents for reviewing these code changes. Include both role-agents and review-specialists.`;

    return { systemPrompt, matchingPrompt, availableAgents };
  }
}
