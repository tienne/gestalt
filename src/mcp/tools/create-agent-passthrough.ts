import type { PassthroughEngine } from '../../interview/passthrough-engine.js';
import type { PassthroughAgentGenerator } from '../../agent/passthrough-generator.js';
import type { AgentCreateInput } from '../schemas.js';

export function handleCreateAgentPassthrough(
  interviewEngine: PassthroughEngine,
  generator: PassthroughAgentGenerator,
  input: AgentCreateInput,
): string {
  switch (input.action) {
    case 'start': {
      let session;
      try {
        session = interviewEngine.getSession(input.sessionId);
      } catch {
        return formatError(`Session not found: ${input.sessionId}`);
      }

      const result = generator.buildAgentContext(session);
      if (!result.ok) return formatError(result.error.message);

      return JSON.stringify({
        status: 'agent_context_ready',
        sessionId: session.sessionId,
        agentContext: result.value,
        message: 'Use agentContext.systemPrompt + agentContext.creationPrompt to generate AGENT.md content, then submit with action=submit and agentContent.',
      }, null, 2);
    }

    case 'submit': {
      if (!input.agentContent) return formatError('agentContent is required for submit action');

      let session;
      try {
        session = interviewEngine.getSession(input.sessionId);
      } catch {
        return formatError(`Session not found: ${input.sessionId}`);
      }

      const cwd = input.cwd ?? process.cwd();
      const result = generator.validateAndSave(session, input.agentContent, cwd);
      if (!result.ok) return formatError(result.error.message);

      const { agent, filePath, overridden } = result.value;
      return JSON.stringify({
        status: 'agent_created',
        sessionId: session.sessionId,
        agentName: agent.frontmatter.name,
        filePath,
        overridden,
        agent: {
          name: agent.frontmatter.name,
          tier: agent.frontmatter.tier,
          pipeline: agent.frontmatter.pipeline,
          domain: agent.frontmatter.domain,
          description: agent.frontmatter.description,
        },
        message: overridden
          ? `Agent "${agent.frontmatter.name}" has been overridden at ${filePath}. Reload the agent registry to pick up changes.`
          : `Agent "${agent.frontmatter.name}" created at ${filePath}. Reload the agent registry to activate.`,
      }, null, 2);
    }
  }
}

function formatError(message: string): string {
  return JSON.stringify({ error: message }, null, 2);
}
