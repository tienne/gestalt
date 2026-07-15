import { getConsistencyHint } from '../../../gestalt/surface-labels.js';

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
