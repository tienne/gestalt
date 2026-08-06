import type { RoleAgentRegistry } from '../../agent/role-agent-registry.js';
import type { AgentRegistry } from '../../agent/registry.js';
import { DEFAULT_TIER_MODELS } from '../../core/constants.js';
import type { AgentTier } from '../../core/types.js';

export interface AgentInput {
  action: 'list' | 'get';
  name?: string;
}

/** tier → Agent 도구 model 별칭 표. 설정이 없으면 기본 표를 쓴다. */
export type TierModels = Record<AgentTier, string>;

export function handleAgentPassthrough(
  roleAgentRegistry: RoleAgentRegistry | undefined,
  input: AgentInput,
  agentRegistry?: AgentRegistry,
  tierModels: TierModels = DEFAULT_TIER_MODELS,
): string {
  if (!roleAgentRegistry) {
    return JSON.stringify({ error: 'Agent registry not available' });
  }

  if (input.action === 'list') {
    const all = roleAgentRegistry.getAll();
    const roleAgents = roleAgentRegistry.getByPipeline('execute');
    const reviewAgents = roleAgentRegistry.getByPipeline('review');
    const personaAgents = roleAgentRegistry.getByPipeline('persona');

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
        persona: personaAgents.map((a) => ({
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

    // 1. role/review/persona 레지스트리 조회
    // 2. 못 찾으면 게슈탈트 원리 에이전트(agents/) 레지스트리로 fallback.
    //    continuity-judge 같은 원리 에이전트를 리뷰 심급 감독 등 파이프라인 밖에서
    //    단독으로 가져올 수 있도록 열어 둔다.
    const agent = roleAgentRegistry.getByName(input.name) ?? agentRegistry?.get(input.name);
    if (!agent) {
      const available = [
        ...roleAgentRegistry.getAll().map((a) => a.frontmatter.name),
        ...(agentRegistry?.getAll().map((a) => a.frontmatter.name) ?? []),
      ];
      return JSON.stringify({
        error: `Agent '${input.name}' not found`,
        available,
      });
    }

    // tier가 없는 에이전트는 standard로 본다. 스킬은 model을 그대로 Agent 도구에
    // 넘기면 되고, tier도 함께 돌려줘 왜 그 모델인지 확인할 수 있게 한다.
    const tier: AgentTier = agent.frontmatter.tier ?? 'standard';

    return JSON.stringify({
      status: 'ok',
      name: agent.frontmatter.name,
      description: agent.frontmatter.description,
      domain: agent.frontmatter.domain ?? [],
      pipeline: agent.frontmatter.pipeline,
      tier,
      model: tierModels[tier],
      systemPrompt: agent.systemPrompt,
    });
  }

  return JSON.stringify({ error: `Unknown action: ${input.action}` });
}
