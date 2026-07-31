import { getConsistencyHint } from '../../../gestalt/surface-labels.js';
import { resolveSessionId, type SessionRef } from '../../session-selector.js';
import type { ExecuteInput } from '../../schemas.js';

// ─── Response Slim Helpers ─────────────────────────────────────────────────
// systemPrompt is static per session (same agent persona every call).
// Stripping it from responses saves ~500 tokens × N calls in context history.
// pendingTasks description/sourceAC are not needed at execution time.

function slimTaskContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const { pendingTasks, similarityStrategy, ...rest } = ctx as {
    pendingTasks?: Array<Record<string, unknown>>;
    similarityStrategy?: unknown;
    [key: string]: unknown;
  };
  return {
    ...rest,
    // Similarity 원리를 노출하던 similarityStrategy → 중립적 consistencyHint로 치환
    ...(similarityStrategy !== undefined ? { consistencyHint: getConsistencyHint() } : {}),
    ...(Array.isArray(pendingTasks)
      ? {
          pendingTasks: pendingTasks.map(({ taskId, title, dependsOn }) => ({
            taskId,
            title,
            dependsOn,
          })),
        }
      : {}),
  };
}

export function slimRetrospectiveContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const { systemPrompt: _sp, ...rest } = ctx as {
    systemPrompt?: unknown;
    [key: string]: unknown;
  };
  return rest;
}

// ─── Verbose=false Helpers ──────────────────────────────────────────────────
// When verbose=false, strip large prompt fields to reduce response token usage.
// Callers that omit verbose (default=true) receive identical responses as before.

const PROMPT_KEYS = ['systemPrompt', 'planningPrompt', 'taskPrompt'] as const;

export function stripContextPrompts(
  ctx: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (!ctx || typeof ctx !== 'object') return ctx;
  const result: Record<string, unknown> = { ...ctx };
  for (const key of PROMPT_KEYS) {
    delete result[key];
  }
  return result;
}

export function applyTaskContextFilters(
  ctx: Record<string, unknown>,
  verbose: boolean,
): Record<string, unknown> {
  const slimmed = slimTaskContext(ctx);
  return verbose ? slimmed : (stripContextPrompts(slimmed) as Record<string, unknown>);
}

export function formatError(message: string): string {
  return JSON.stringify({ error: message }, null, 2);
}

/**
 * sessionId에 담긴 `active`/`latest` 셀렉터를 UUID로 바꾼 입력을 돌려준다.
 * 엔진은 셀렉터를 모르므로 핸들러 진입 전에 여기서 해석한다.
 */
export function resolveExecuteSessionInput(
  engine: { listSessions(): SessionRef[] },
  input: ExecuteInput,
): { ok: true; input: ExecuteInput } | { ok: false; error: string } {
  if (!input.sessionId) return { ok: true, input };

  const resolved = resolveSessionId(input.sessionId, 'execute', {
    listExecuteSessions: () => engine.listSessions(),
    cwd: input.cwd ?? process.cwd(),
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };

  return { ok: true, input: { ...input, sessionId: resolved.sessionId } };
}

/**
 * 착수 가능한 태스크가 2개 이상일 때만 붙는 안내 문구.
 * 병렬 디스패치 판단은 호스트 몫이므로 정보만 전달한다.
 */
export function parallelHint(nextTaskIds: string[]): string {
  if (nextTaskIds.length < 2) return '';
  return ` 착수 가능한 태스크 ${nextTaskIds.length}개 — 동시 진행 가능합니다: ${nextTaskIds.join(', ')}.`;
}
