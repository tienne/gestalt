import type { RoleAgentRegistry } from '../../agent/role-agent-registry.js';
import type { AgentRegistry } from '../../agent/registry.js';
import { DEFAULT_TIER_MODELS } from '../../core/constants.js';
import type { AgentDefinition, AgentTier } from '../../core/types.js';

export interface AgentInput {
  action: 'list' | 'get';
  name?: string;
}

/** tier → Agent 도구 model 별칭 표. 설정이 없으면 기본 표를 쓴다. */
export type TierModels = Record<AgentTier, string>;

// frontmatter에 tier가 빠진 에이전트는 standard로 본다. tier도 함께 돌려줘서
// 스킬이 왜 그 모델인지 확인할 수 있게 한다.
function resolveTierModel(
  agent: AgentDefinition,
  tierModels: TierModels,
): { tier: AgentTier; model: string } {
  const tier: AgentTier = agent.frontmatter.tier ?? 'standard';
  return { tier, model: tierModels[tier] };
}

// list 항목에는 systemPrompt를 싣지 않는다. 스폰 전에 model만 얻으려고 부르는 자리라
// 본문이 딸려오면 메인 컨텍스트에 에이전트 전체가 쌓인다.
function summarize(agent: AgentDefinition, tierModels: TierModels) {
  return {
    name: agent.frontmatter.name,
    description: agent.frontmatter.description,
    domain: agent.frontmatter.domain ?? [],
    ...resolveTierModel(agent, tierModels),
  };
}

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
    const toSummary = (a: AgentDefinition) => summarize(a, tierModels);

    return JSON.stringify({
      status: 'ok',
      total: roleAgentRegistry.getAll().length,
      groups: {
        role: roleAgentRegistry.getByPipeline('execute').map(toSummary),
        review: roleAgentRegistry.getByPipeline('review').map(toSummary),
        persona: roleAgentRegistry.getByPipeline('persona').map(toSummary),
        // continuity-judge처럼 리뷰 스킬이 직접 띄우는 원리 에이전트도 tier를 알아야
        // 폴백 모델로 잘못 내려가지 않는다. total은 기존 의미대로 role 레지스트리 수만 센다.
        principle: (agentRegistry?.getAll() ?? []).map(toSummary),
      },
    });
  }

  if (input.action === 'get') {
    if (!input.name) {
      return JSON.stringify({ error: 'name is required for action=get' });
    }

    // role/review/persona에 없으면 원리 에이전트(agents/)에서 찾는다.
    // 리뷰 심급 감독처럼 파이프라인 밖에서 continuity-judge를 단독으로 쓰는 경우가 있다.
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

    const { tier, model } = resolveTierModel(agent, tierModels);

    return JSON.stringify({
      status: 'ok',
      name: agent.frontmatter.name,
      description: agent.frontmatter.description,
      domain: agent.frontmatter.domain ?? [],
      pipeline: agent.frontmatter.pipeline,
      tier,
      model,
      systemPrompt: agent.systemPrompt,
    });
  }

  return JSON.stringify({ error: `Unknown action: ${input.action}` });
}
