import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOOKS_ENV, parseHooksEnv } from '../../core/hooks-env.js';

export { HOOKS_ENV, parseHooksEnv };

/**
 * 훅을 켤지 정한다. 환경변수가 1/true면 켜고 0/false면 끈다. 그 밖엔 gestalt.json의
 * `codeGraph.hooks.enabled`가 true일 때만 켠다.
 *
 * config.ts의 loadConfig를 안 쓰는 이유는 기동 비용이다. zod와 dotenv까지 불러오면
 * 매 프롬프트마다 그만큼 늦어진다. 스키마의 기본값(false)과 같은 판정을 여기서 직접 한다.
 */
export function isHooksEnabled(repoRoot: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const fromEnv = parseHooksEnv(env[HOOKS_ENV]);
  if (fromEnv !== undefined) return fromEnv;
  try {
    const json = JSON.parse(readFileSync(join(repoRoot, 'gestalt.json'), 'utf-8')) as unknown;
    const codeGraph = (json as { codeGraph?: { hooks?: { enabled?: unknown } } } | null)?.codeGraph;
    return codeGraph?.hooks?.enabled === true;
  } catch {
    return false;
  }
}
