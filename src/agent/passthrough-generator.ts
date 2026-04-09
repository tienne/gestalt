import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { InterviewSession, AgentDefinition } from '../core/types.js';
import { AgentCreationError } from '../core/errors.js';
import { type Result, ok, err } from '../core/result.js';
import { EventStore } from '../events/store.js';
import { EventType } from '../events/types.js';
import { parseAgentMd } from './parser.js';
import type { RoleAgentRegistry } from './role-agent-registry.js';

// ─── Types ──────────────────────────────────────────────────────

export interface AgentCreationContext {
  systemPrompt: string;
  creationPrompt: string;
  existingAgents: { name: string; domain: string[]; description: string }[];
  agentMdSchema: string;
}

// ─── Generator ──────────────────────────────────────────────────

export class PassthroughAgentGenerator {
  constructor(
    private eventStore: EventStore,
    private roleAgentRegistry?: RoleAgentRegistry,
  ) {}

  buildAgentContext(session: InterviewSession): Result<AgentCreationContext, AgentCreationError> {
    if (session.status !== 'completed') {
      return err(
        new AgentCreationError('Interview session must be completed before creating an agent'),
      );
    }

    const existingAgents = (this.roleAgentRegistry?.getAll() ?? []).map((a) => ({
      name: a.frontmatter.name,
      domain: a.frontmatter.domain ?? [],
      description: a.frontmatter.description,
    }));

    const roundsSummary = session.rounds
      .filter((r) => r.userResponse !== null)
      .map((r) => `Q${r.roundNumber}: ${r.question}\nA: ${r.userResponse}`)
      .join('\n\n');

    const existingList =
      existingAgents.length > 0
        ? existingAgents
            .map((a) => `- ${a.name}: ${a.description} (domains: ${a.domain.join(', ')})`)
            .join('\n')
        : '(none)';

    const systemPrompt = `You are a Gestalt agent creator. Based on the completed interview, generate an AGENT.md file for a custom Role Agent. The agent must have role: true in its frontmatter.`;

    const creationPrompt = `## Interview Summary

Topic: ${session.topic}

${roundsSummary}

## Existing Role Agents (avoid duplication)

${existingList}

## AGENT.md Format

Generate an AGENT.md file with YAML frontmatter and markdown body. The frontmatter must include all required fields.

### Frontmatter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | yes | Unique agent name (lowercase, kebab-case) |
| tier | "frugal" \\| "standard" \\| "frontier" | yes | LLM tier for the agent |
| pipeline | "interview" \\| "spec" \\| "execute" \\| "evaluate" | yes | Which pipeline stage this agent operates in |
| role | boolean | yes | Must be \`true\` for role agents |
| domain | string[] | yes | List of domain keywords this agent covers |
| description | string | yes | One-line description of the agent's expertise |
| model | string | no | Specific model override |
| escalateTo | string | no | Agent to escalate to |

### Body

The markdown body after the frontmatter is the agent's system prompt. It should describe:
1. The agent's expertise and perspective
2. What the agent focuses on when reviewing tasks
3. The output format for perspectives

## Instructions

- The agent name must be unique (not in the existing agents list above)
- Set \`role: true\` (this is mandatory)
- Choose appropriate domain keywords based on the interview topic
- Write a clear, actionable system prompt in the body

Return the complete AGENT.md content (frontmatter + body) as a single string.`;

    const agentMdSchema = `---
name: <string>
tier: frugal | standard | frontier
pipeline: interview | spec | execute | evaluate
role: true
domain: [<string>, ...]
description: "<string>"
---

<system prompt markdown body>`;

    return ok({
      systemPrompt,
      creationPrompt,
      existingAgents,
      agentMdSchema,
    });
  }

  validateAndSave(
    session: InterviewSession,
    agentContent: string,
    cwd: string,
  ): Result<{ agent: AgentDefinition; filePath: string; overridden: boolean }, AgentCreationError> {
    if (session.status !== 'completed') {
      return err(
        new AgentCreationError('Interview session must be completed before creating an agent'),
      );
    }

    // Parse and validate AGENT.md content
    let agent: AgentDefinition;
    try {
      agent = parseAgentMd(agentContent, '<submitted>');
    } catch (e) {
      return err(
        new AgentCreationError(
          `Invalid AGENT.md content: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }

    // Must be a role agent
    if (!agent.frontmatter.role) {
      return err(
        new AgentCreationError(
          'Agent must have role=true. Only Role Agents can be created via ges_create_agent.',
        ),
      );
    }

    const agentName = agent.frontmatter.name;
    const agentDir = join(cwd, 'agents', agentName);
    const filePath = join(agentDir, 'AGENT.md');

    const overridden = existsSync(filePath);

    try {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(filePath, agentContent, 'utf-8');
    } catch (e) {
      return err(
        new AgentCreationError(
          `Failed to write AGENT.md: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }

    // Update filePath to actual location
    agent = { ...agent, filePath };

    this.eventStore.append('agent', agentName, EventType.AGENT_CREATED, {
      sessionId: session.sessionId,
      agentName,
      tier: agent.frontmatter.tier,
      pipeline: agent.frontmatter.pipeline,
      domain: agent.frontmatter.domain,
      description: agent.frontmatter.description,
      overridden,
      filePath,
    });

    return ok({ agent, filePath, overridden });
  }
}
