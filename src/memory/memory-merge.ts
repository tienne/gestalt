import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type {
  ProjectMemory,
  SpecHistoryEntry,
  MemoryExecutionRecord,
  ArchitectureDecision,
} from '../core/types.js';

function unionBy<T>(remote: T[], local: T[], key: (item: T) => string): T[] {
  const seen = new Set(remote.map(key));
  return [...remote, ...local.filter((item) => !seen.has(key(item)))];
}

/**
 * local과 remote ProjectMemory를 합친다. specHistory, executionHistory,
 * architectureDecisions는 쌓기만 하는 기록이라 공통 조상 없이 합집합으로 충분하다.
 * compressedContexts는 같은 세션 요약을 덮어써 갱신하므로 더 최신 쪽을 고른다.
 *
 * - specHistory: specId 기준, executionHistory: executeSessionId 기준
 * - architectureDecisions: decision 기준. 한쪽에만 outcome이 있으면 그쪽을 남긴다
 * - compressedContexts: sessionId 기준. compressedAt이 더 최신인 쪽을 남긴다
 * - 그 밖에 같은 키가 양쪽에 있으면 remote가 이긴다. lastUpdated는 더 최신 값
 */
export function mergeMemory(local: ProjectMemory, remote: ProjectMemory): ProjectMemory {
  const specHistory: SpecHistoryEntry[] = unionBy(
    remote.specHistory,
    local.specHistory,
    (s) => s.specId,
  );

  const executionHistory: MemoryExecutionRecord[] = unionBy(
    remote.executionHistory,
    local.executionHistory,
    (e) => e.executeSessionId,
  );

  // addArchitectureDecision이 decision 문자열로 중복을 막으므로 여기서도 같은 키를 쓴다.
  // timestamp까지 키에 넣으면 양쪽에서 같은 결정을 따로 기록했을 때 둘 다 남는다
  const localDecisions = new Map(local.architectureDecisions.map((d) => [d.decision, d]));
  const architectureDecisions: ArchitectureDecision[] = unionBy(
    remote.architectureDecisions,
    local.architectureDecisions,
    (d) => d.decision,
  ).map((d) => {
    const other = localDecisions.get(d.decision);
    return !d.outcome && other?.outcome ? other : d;
  });

  const localContexts = new Map((local.compressedContexts ?? []).map((c) => [c.sessionId, c]));
  const compressedContexts = unionBy(
    remote.compressedContexts ?? [],
    local.compressedContexts ?? [],
    (c) => c.sessionId,
  ).map((c) => {
    const other = localContexts.get(c.sessionId);
    return other && other.compressedAt > c.compressedAt ? other : c;
  });

  const lastUpdated =
    local.lastUpdated > remote.lastUpdated ? local.lastUpdated : remote.lastUpdated;

  return {
    version: local.version,
    repoRoot: local.repoRoot,
    specHistory,
    executionHistory,
    architectureDecisions,
    compressedContexts: compressedContexts.length > 0 ? compressedContexts : undefined,
    lastUpdated,
  };
}

// 합친 결과는 사람 검토 없이 커밋된다. 머지 키와 날짜 비교에 쓰는 필드, 그리고 인터뷰를 시작할 때
// 프롬프트에 싣는 필드는 여기서 형태를 확인한다. 그 밖의 필드는 손대지 않고 그대로 넘긴다
const memoryFileSchema = z
  .object({
    specHistory: z.array(
      z.object({ specId: z.string(), goal: z.string(), createdAt: z.string() }).passthrough(),
    ),
    executionHistory: z.array(
      z
        .object({
          executeSessionId: z.string(),
          specId: z.string(),
          completedAt: z.string(),
          completedTasks: z.array(z.unknown()),
          failedTasks: z.array(z.unknown()),
        })
        .passthrough(),
    ),
    architectureDecisions: z.array(
      z
        .object({
          decision: z.string(),
          rationale: z.string().optional(),
          outcome: z.string().optional(),
        })
        .passthrough(),
    ),
    compressedContexts: z
      .array(z.object({ sessionId: z.string(), compressedAt: z.string() }).passthrough())
      .optional(),
    lastUpdated: z.string().optional(),
  })
  .passthrough();

function shapeError(path: string, at: PropertyKey[]): Error {
  const where = at.length > 0 ? at.map(String).join('.') : '(root)';
  return new Error(`${path}: unexpected memory.json shape at ${where}`);
}

// ProjectMemoryStore.read()의 v1 마이그레이션과 같은 일을 하되 두 군데가 다르다.
// timestamp를 실행 시각 대신 파일의 lastUpdated로 채워 같은 입력이면 같은 머지 결과가 나오게 한다.
// 배열 필드가 빠진 파일도 빈 배열로 채운다. 드라이버는 git이 넘겨준 임시 파일을 읽으므로 store를 거치지 못한다
function readMemoryFile(path: string): ProjectMemory {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  // 마이그레이션이 필드를 건드리기 전에 막아야 원시 TypeError 대신 어디가 틀렸는지가 남는다
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw shapeError(path, []);
  const parsed = raw as ProjectMemory;
  if (parsed.architectureDecisions !== undefined && !Array.isArray(parsed.architectureDecisions)) {
    throw shapeError(path, ['architectureDecisions']);
  }

  parsed.architectureDecisions = (parsed.architectureDecisions ?? []).map((item) =>
    typeof item === 'string'
      ? { decision: item, rationale: '', specId: '', timestamp: parsed.lastUpdated ?? '' }
      : item,
  );
  // null은 채우지 않고 스키마에 걸리게 둔다. 빠진 필드만 빈 배열로 본다
  if (parsed.specHistory === undefined) parsed.specHistory = [];
  if (parsed.executionHistory === undefined) parsed.executionHistory = [];

  const checked = memoryFileSchema.safeParse(parsed);
  if (!checked.success) throw shapeError(path, checked.error.issues[0]?.path ?? []);
  return parsed;
}

/**
 * git merge driver 진입점. `%A`(현재 브랜치) 자리에 합친 결과를 쓴다.
 * 어느 쪽이든 JSON으로 못 읽거나 구조가 맞지 않으면 쓰기 전에 던진다 — 호출부가
 * 0이 아닌 코드로 끝내야 git이 그 경로를 충돌로 남기고 사람에게 넘긴다.
 */
export function runMemoryMergeDriver(oursPath: string, theirsPath: string): ProjectMemory {
  const merged = mergeMemory(readMemoryFile(oursPath), readMemoryFile(theirsPath));
  // 쓰다 끊겨도 ours가 반쯤 쓰인 채 남지 않게 같은 디렉토리에 쓰고 바꿔 끼운다
  const tmpPath = `${oursPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), 'utf-8');
  renameSync(tmpPath, oursPath);
  return merged;
}
