import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { gestaltPath } from '../core/home.js';

const toolList = z.array(z.string().min(1)).default([]);

const schema = z.object({
  /** 호스트에 있어야 하는 도구. 이 목록에 없는 도구는 doctor가 보지 않는다 */
  tools: z.object({ all: toolList, claude: toolList, codex: toolList }).partial().default({}),
  /** 오르카 계정 id별 출력 이름과 제외 여부 */
  accounts: z
    .record(z.string(), z.object({ label: z.string().optional(), skip: z.boolean().optional() }))
    .default({}),
  orcaCommand: z.string().min(1).optional(),
  orcaDataDir: z
    .string()
    .min(1)
    .refine((v) => isAbsolute(v) && resolve(v) === v, '정리된 절대 경로여야 해요')
    .optional(),
  rules: z
    .object({
      /** CLAUDE.md를 나눌 때 Claude 쪽에 남길 줄. 줄에 이 문자열이 들어 있으면 남긴다 */
      claudeOnly: z.array(z.string().min(1)).default([]),
    })
    .default({}),
});

export type AgentSyncConfig = z.infer<typeof schema>;

export function agentSyncConfigPath(): string {
  return gestaltPath('agent-sync.json');
}

export class AgentSyncConfigError extends Error {}

export function loadAgentSyncConfig(path = agentSyncConfigPath()): AgentSyncConfig {
  if (!existsSync(path)) return schema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new AgentSyncConfigError(`${path}를 JSON으로 읽지 못했어요: ${(e as Error).message}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new AgentSyncConfigError(`${path} 형식이 맞지 않아요: ${detail}`);
  }
  return parsed.data;
}

export function toolsFor(config: AgentSyncConfig, kind: 'claude' | 'codex'): string[] {
  const all = config.tools.all ?? [];
  const own = config.tools[kind] ?? [];
  return [...new Set([...all, ...own])];
}
