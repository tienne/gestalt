import type { RoleAgentRegistry } from '../../agent/role-agent-registry.js';

export interface AgentInput {
  action: 'list' | 'get';
  name?: string;
}

export function handleAgentPassthrough(
  roleAgentRegistry: RoleAgentRegistry | undefined,
  input: AgentInput,
): string {
  if (!roleAgentRegistry) {
    return JSON.stringify({ error: 'Agent registry not available' });
  }

  if (input.action === 'list') {
    const all = roleAgentRegistry.getAll();
    const roleAgents = roleAgentRegistry.getByPipeline('execute');
    const reviewAgents = roleAgentRegistry.getByPipeline('review');

    return JSON.stringify({
      status: 'ok',
      total: all.length,
      groups: {
        role: roleAgents.map((a) => ({
          name: a.frontmatter.name,
          description: a.frontmatter.description,
          domain: a.frontmatter.domain ?? [],
        })),
        review: reviewAgents.map((a) => ({
          name: a.frontmatter.name,
          description: a.frontmatter.description,
          domain: a.frontmatter.domain ?? [],
        })),
      },
    });
  }

  if (input.action === 'get') {
    if (!input.name) {
      return JSON.stringify({ error: 'name is required for action=get' });
    }

    const agent = roleAgentRegistry.getByName(input.name);
    if (!agent) {
      const available = roleAgentRegistry.getAll().map((a) => a.frontmatter.name);
      return JSON.stringify({
        error: `Agent '${input.name}' not found`,
        available,
      });
    }

    return JSON.stringify({
      status: 'ok',
      name: agent.frontmatter.name,
      description: agent.frontmatter.description,
      domain: agent.frontmatter.domain ?? [],
      pipeline: agent.frontmatter.pipeline,
      systemPrompt: agent.systemPrompt,
    });
  }

  return JSON.stringify({ error: `Unknown action: ${input.action}` });
}
