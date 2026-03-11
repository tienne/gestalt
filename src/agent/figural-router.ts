import type { AgentDefinition, AgentTier, LLMProvider } from '../core/types.js';
import type { LLMAdapter } from '../llm/types.js';
import { LLMError } from '../core/errors.js';

export interface ProviderConfig {
  provider: LLMProvider;
  model: string;
  adapter: LLMAdapter;
}

export interface TierMapping {
  frugal: ProviderConfig;
  standard: ProviderConfig;
  frontier: ProviderConfig;
}

export interface RouterOptions {
  tierMapping: TierMapping;
  defaultTier?: AgentTier;
}

/**
 * FiguralRouter: Gestalt Figure-Ground 원리 기반 모델 선택 라우터
 *
 * 3-level 우선순위:
 * 1. Runtime override (호출 시 직접 지정)
 * 2. AGENT.md tier (에이전트 정의의 tier 필드)
 * 3. Default tier (라우터 기본값, 'standard')
 */
export class FiguralRouter {
  private tierMapping: TierMapping;
  private defaultTier: AgentTier;

  constructor(options: RouterOptions) {
    this.tierMapping = options.tierMapping;
    this.defaultTier = options.defaultTier ?? 'standard';
  }

  /**
   * 에이전트에 적합한 LLM adapter를 반환한다.
   * @param agent - 에이전트 정의 (AGENT.md에서 파싱)
   * @param tierOverride - 런타임에서 tier를 강제 지정할 때 사용
   */
  route(agent: AgentDefinition, tierOverride?: AgentTier): LLMAdapter {
    const tier = tierOverride ?? this.resolveTier(agent);
    const config = this.tierMapping[tier];

    if (!config) {
      throw new LLMError(`No provider configured for tier: ${tier}`);
    }

    return config.adapter;
  }

  /**
   * 에이전트에 적합한 모델명을 반환한다.
   */
  resolveModel(agent: AgentDefinition, tierOverride?: AgentTier): string {
    // 1st priority: AGENT.md의 model 필드 (특정 모델 고정)
    if (agent.frontmatter.model) {
      return agent.frontmatter.model;
    }

    // 2nd priority: tier 기반 매핑
    const tier = tierOverride ?? this.resolveTier(agent);
    return this.tierMapping[tier].model;
  }

  /**
   * 에이전트의 tier를 결정한다.
   */
  private resolveTier(agent: AgentDefinition): AgentTier {
    return agent.frontmatter.tier ?? this.defaultTier;
  }

  /**
   * 등록된 tier 매핑 정보를 반환한다.
   */
  getTierMapping(): Readonly<TierMapping> {
    return this.tierMapping;
  }
}
