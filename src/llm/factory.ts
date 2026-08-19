import type { GestaltConfig, LLMTierConfig } from '../core/config.js';
import { LLMError } from '../core/errors.js';
import type { AgentTier } from '../core/types.js';
import type { LLMAdapter } from './types.js';
import { AnthropicAdapter } from './adapter.js';
import { OpenAIAdapter } from './openai-adapter.js';
import { RetryingAdapter } from './retry-adapter.js';
import { FallbackAdapter } from './fallback-adapter.js';

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
  return new RetryingAdapter(new AnthropicAdapter(llmConfig.apiKey, llmConfig.model));
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
      return new RetryingAdapter(new AnthropicAdapter(apiKey, tierCfg.model));
    case 'openai':
      return new RetryingAdapter(new OpenAIAdapter(apiKey, tierCfg.model, tierCfg.baseURL));
    default:
      throw new LLMError(`Unsupported LLM provider: ${String(tierCfg.provider)}`);
  }
}

/**
 * 특정 tier가 설정돼 있을 때만 그 tier의 어댑터를 만든다.
 *
 * 설정이 없으면 `undefined`를 돌려준다. 그러면 호출부는 기본 어댑터를 그대로 쓴다.
 * "이 호출은 frugal로 내려도 된다"는 판단은 호출부가 한다. 실제로 내릴 수 있는지는
 * 사용자가 그 tier를 설정했는지에 달려 있어서 두 조건을 여기서 갈라놓는다.
 */
export function createTierAdapter(
  llmConfig: GestaltConfig['llm'],
  tier: AgentTier,
): LLMAdapter | undefined {
  const tierCfg = llmConfig[tier];
  if (!tierCfg) return undefined;
  return createAdapterFromTierConfig(tierCfg, llmConfig);
}

/**
 * GestaltConfig에서 FallbackAdapter를 생성한다.
 * tier 순서(frontier → standard → frugal)로 시도하며, tier가 없으면 flat config로 폴백한다.
 */
export function createFallbackAdapter(config: GestaltConfig): FallbackAdapter {
  const tiers: AgentTier[] = ['frontier', 'standard', 'frugal'];
  const adapters = tiers
    .filter((t) => config.llm[t])
    .map((t) => createAdapterFromTierConfig(config.llm[t]!, config.llm));
  if (adapters.length === 0) adapters.push(createAdapter(config.llm));
  return new FallbackAdapter(adapters);
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
