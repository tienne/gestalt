import type { AgentDefinition, ReviewContext } from '../core/types.js';
import { classifyHarnessTarget, type ReadFileFn } from '../harness-review/identifiers.js';

export const HARNESS_REVIEWER = 'harness-reviewer';

export interface ReviewMatchContext {
  systemPrompt: string;
  matchingPrompt: string;
  availableAgents: Array<{ name: string; domain: string[]; description: string; category: string }>;
  /** LLM 응답에 없어도 붙여야 하는 에이전트. 소비하는 쪽이 ensureRequiredAgents로 채운다. */
  requiredAgents: string[];
}

/**
 * 변경 파일 중 하네스 대상을 고른다. ruleDoc은 경로만으로 정해지고 MCP 도구 등록부와
 * 공개 패키지는 내용이 필요해서 readFile이 없으면 잡지 못한다.
 */
export function detectHarnessTargets(changedFiles: string[], readFile?: ReadFileFn): string[] {
  return changedFiles.filter((path) => {
    if (classifyHarnessTarget(path) !== null) return true;
    if (!readFile) return false;
    return classifyHarnessTarget(path, readFile(path), readFile) !== null;
  });
}

/** 매처 결과에 필수 에이전트가 빠져 있으면 붙인다. */
export function ensureRequiredAgents<T extends { agentName: string }>(
  matches: T[],
  required: string[],
  fill: (agentName: string) => T,
): T[] {
  const missing = required.filter((name) => !matches.some((m) => m.agentName === name));
  return [...matches, ...missing.map(fill)];
}

export class ReviewAgentMatcher {
  generateMatchContext(
    reviewContext: ReviewContext,
    roleAgents: AgentDefinition[],
    reviewAgents: AgentDefinition[],
    options: { readFile?: ReadFileFn } = {},
  ): ReviewMatchContext {
    const harnessTargets =
      reviewContext.harnessTargets ??
      detectHarnessTargets(reviewContext.changedFiles, options.readFile);
    const hasHarnessTarget = harnessTargets.length > 0;
    const requiredAgents = hasHarnessTarget ? [HARNESS_REVIEWER] : [];

    // domain에 prompt, skill 같은 일반 단어가 있어서 하네스 대상이 없는 PR에서는 후보에서 뺀다
    const allAgents = [...roleAgents, ...reviewAgents].filter(
      (a) => hasHarnessTarget || a.frontmatter.name !== HARNESS_REVIEWER,
    );
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
4. Consider the spec goal and constraints when matching${
      hasHarnessTarget
        ? `\n5. Always include ${HARNESS_REVIEWER} (harness targets changed: ${harnessTargets.join(', ')})`
        : ''
    }

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
    const dependencyBlock =
      reviewContext.dependencyFiles.length > 0
        ? `\n**Dependency Context** (${reviewContext.dependencyFiles.length}):\n  ${reviewContext.dependencyFiles.join('\n  ')}\n`
        : '';

    const matchingPrompt = `## Code Review Agent Matching

**Spec Goal**: ${reviewContext.spec?.goal ?? 'Direct file review'}

**Changed Files** (${reviewContext.changedFiles.length}):
  ${fileList}
${dependencyBlock}
**Task Results Summary**: ${reviewContext.taskResults?.length ?? 0} tasks completed

**Available Agents** (${availableAgents.length}):
${agentList}

Select the most relevant agents for reviewing these code changes. Include both role-agents and review-specialists.`;

    return { systemPrompt, matchingPrompt, availableAgents, requiredAgents };
  }
}
