import type { GestaltConfig, LLMTierConfig } from '../core/config.js';
import { DEFAULT_MODEL } from '../core/constants.js';
import { LLMError } from '../core/errors.js';
import type { AgentTier } from '../core/types.js';
import type { LLMAdapter } from './types.js';
import type { TierMapping } from '../agent/figural-router.js';
import { AnthropicAdapter } from './adapter.js';
import { OpenAIAdapter } from './openai-adapter.js';

/**
 * tier config 또는 flat config(apiKey + model)에서 LLMAdapter를 생성한다.
 * flat config인 경우 Anthropic을 기본 provider로 사용한다.
 */
export function createAdapter(llmConfig: GestaltConfig['llm']): LLMAdapter {
  // standard tier가 있으면 그것으로, 없으면 flat config 사용
  const tierCfg = llmConfig.standard;
  if (tierCfg) {
    return createAdapterFromTierConfig(tierCfg, llmConfig);
  }

  // flat config fallback (기존 호환)
  return new AnthropicAdapter(llmConfig.apiKey, llmConfig.model);
}

/**
 * LLMTierConfig에서 provider별 LLMAdapter를 생성한다.
 * tier config에 apiKey가 없으면 flat config의 apiKey를 fallback으로 사용한다.
 */
export function createAdapterFromTierConfig(
  tierCfg: LLMTierConfig,
  llmConfig: GestaltConfig['llm'],
): LLMAdapter {
  const apiKey = tierCfg.apiKey ?? llmConfig.apiKey;

  switch (tierCfg.provider) {
    case 'anthropic':
      return new AnthropicAdapter(apiKey, tierCfg.model);
    case 'openai':
      return new OpenAIAdapter(apiKey, tierCfg.model, tierCfg.baseURL);
    default:
      throw new LLMError(`Unsupported LLM provider: ${String(tierCfg.provider)}`);
  }
}

/**
 * GestaltConfig에서 FiguralRouter용 TierMapping을 생성한다.
 * tier 설정이 없는 경우 flat config(apiKey + model)로 모든 tier에 AnthropicAdapter를 할당한다.
 */
export function createTierMapping(config: GestaltConfig): TierMapping {
  const llm = config.llm;
  const tiers: AgentTier[] = ['frugal', 'standard', 'frontier'];
  const mapping = {} as Record<AgentTier, TierMapping[AgentTier]>;

  for (const tier of tiers) {
    const tierCfg = llm[tier];
    if (tierCfg) {
      mapping[tier] = {
        provider: tierCfg.provider,
        model: tierCfg.model,
        adapter: createAdapterFromTierConfig(tierCfg, llm),
      };
    } else {
      // flat config fallback
      mapping[tier] = {
        provider: 'anthropic',
        model: llm.model || DEFAULT_MODEL,
        adapter: new AnthropicAdapter(llm.apiKey, llm.model || DEFAULT_MODEL),
      };
    }
  }

  return mapping as TierMapping;
}

/**
 * LLM API 키가 설정되어 있는지 확인한다.
 * flat config의 apiKey 또는 any tier의 apiKey가 있으면 true.
 */
export function hasLLMApiKey(config: GestaltConfig): boolean {
  if (config.llm.apiKey) return true;
  const tiers: AgentTier[] = ['frugal', 'standard', 'frontier'];
  for (const tier of tiers) {
    if (config.llm[tier]?.apiKey) return true;
  }
  return false;
}
