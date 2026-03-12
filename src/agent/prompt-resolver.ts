import type { AgentPipeline } from '../core/types.js';
import type { AgentRegistry } from './registry.js';

/**
 * Pipeline에 매칭되는 에이전트들의 systemPrompt를 결합하여 반환한다.
 * AgentRegistry가 없거나 매칭 에이전트가 없으면 undefined를 반환한다.
 */
export function resolveAgentPrompt(
  registry: AgentRegistry | undefined,
  pipeline: AgentPipeline,
): string | undefined {
  if (!registry) return undefined;
  const agents = registry.getByPipeline(pipeline);
  if (agents.length === 0) return undefined;
  return agents.map((a) => a.systemPrompt).join('\n\n---\n\n');
}

/**
 * 기본 systemPrompt에 에이전트 persona를 결합한다.
 * 에이전트가 없으면 기본 systemPrompt를 그대로 반환한다.
 */
export function mergeSystemPrompt(
  basePrompt: string,
  registry: AgentRegistry | undefined,
  pipeline: AgentPipeline,
): string {
  const agentPrompt = resolveAgentPrompt(registry, pipeline);
  if (!agentPrompt) return basePrompt;
  return `${basePrompt}\n\n## Agent Persona\n\n${agentPrompt}`;
}

/**
 * Pipeline에 매칭되는 에이전트 이름 목록을 반환한다.
 */
export function getActiveAgentNames(
  registry: AgentRegistry | undefined,
  pipeline: AgentPipeline,
): string[] {
  if (!registry) return [];
  return registry.getByPipeline(pipeline).map((a) => a.frontmatter.name);
}
