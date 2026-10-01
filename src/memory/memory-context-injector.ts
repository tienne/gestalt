import type { ProjectMemory, ArchitectureDecision, SpecHistoryEntry } from '../core/types.js';
import { log } from '../core/log.js';
import { ProjectMemoryStore } from './project-memory-store.js';

const RECENT_SPEC_WINDOW = 5;
const RELATED_SPEC_TOP_K = 3;
// all-MiniLM-L6-v2에서 주제가 겹치는 문장은 0.5 위로, 무관한 문장은 0.2 아래로 갈린다
const RELATED_SPEC_MIN_SCORE = 0.4;
// 모델을 처음 받는 환경에서는 수십 초가 걸린다. 인터뷰 시작을 그만큼 붙잡지 않고
// 이번엔 최근 스펙만 넣는다. 로딩은 서버 프로세스 안에서 계속 돌아 다음 start부터 쓰인다
const RELATED_SPEC_TIMEOUT_MS = 3000;

interface SpecSummary {
  goal: string;
  specId: string;
  createdAt: string;
  sourceType: string;
}

export interface MemoryContext {
  recentSpecs: SpecSummary[];
  relatedSpecs: SpecSummary[];
  architectureDecisions: ArchitectureDecision[];
  recentExecutions: Array<{
    specId: string;
    completedTasks: number;
    failedTasks: number;
    completedAt: string;
  }>;
  hasContext: boolean;
}

export type SpecSearchFn = (
  query: string,
  memory: ProjectMemory,
  topK: number,
  minScore: number,
) => Promise<SpecHistoryEntry[]>;

export interface RelatedSpecOptions {
  search?: SpecSearchFn;
  timeoutMs?: number;
}

function toSummary(s: SpecHistoryEntry): SpecSummary {
  return { goal: s.goal, specId: s.specId, createdAt: s.createdAt, sourceType: s.sourceType };
}

async function defaultSearch(...args: Parameters<SpecSearchFn>): ReturnType<SpecSearchFn> {
  const { searchSimilarSpecs } = await import('./semantic-search.js');
  return searchSimilarSpecs(...args);
}

/**
 * 최근 창 밖으로 밀려난 스펙 중 주제와 비슷한 것을 찾는다.
 * 임베딩 모델을 못 불러오거나 제한 시간을 넘기면 빈 배열을 돌려준다.
 */
export async function findRelatedSpecs(
  memory: ProjectMemory,
  topic: string,
  options: RelatedSpecOptions = {},
): Promise<SpecSummary[]> {
  // 최근 창 안의 스펙은 recentSpecs로 이미 들어가므로 그 앞쪽만 뒤진다
  const older = memory.specHistory.slice(0, -RECENT_SPEC_WINDOW);
  if (older.length === 0) return [];

  const search = options.search ?? defaultSearch;
  const timeoutMs = options.timeoutMs ?? RELATED_SPEC_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    const found = await Promise.race([
      search(topic, { ...memory, specHistory: older }, RELATED_SPEC_TOP_K, RELATED_SPEC_MIN_SCORE),
      timeout,
    ]);
    if (found === null) {
      log(`memory: related spec search timed out after ${timeoutMs}ms, using recent specs only`);
      return [];
    }
    return found.map(toSummary);
  } catch (e) {
    log(`memory: related spec search unavailable (${e instanceof Error ? e.message : String(e)})`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function buildMemoryContext(
  memory: ProjectMemory,
  relatedSpecs: SpecSummary[] = [],
): MemoryContext {
  const recentSpecs = memory.specHistory.slice(-RECENT_SPEC_WINDOW).map(toSummary);

  const recentExecutions = memory.executionHistory.slice(-3).map((e) => ({
    specId: e.specId,
    completedTasks: e.completedTasks.length,
    failedTasks: e.failedTasks.length,
    completedAt: e.completedAt,
  }));

  const hasContext =
    recentSpecs.length > 0 ||
    relatedSpecs.length > 0 ||
    memory.architectureDecisions.length > 0 ||
    recentExecutions.length > 0;

  return {
    recentSpecs,
    relatedSpecs,
    architectureDecisions: memory.architectureDecisions,
    recentExecutions,
    hasContext,
  };
}

export function formatMemoryContextForPrompt(context: MemoryContext): string {
  if (!context.hasContext) return '';

  const lines: string[] = ['## Prior Project Context'];

  if (context.recentSpecs.length > 0) {
    lines.push('\n### Recent Specs');
    for (const s of context.recentSpecs) {
      lines.push(`- [${s.createdAt.slice(0, 10)}] ${s.goal}`);
    }
  }

  if (context.relatedSpecs.length > 0) {
    lines.push('\n### Related Past Specs');
    for (const s of context.relatedSpecs) {
      lines.push(`- [${s.createdAt.slice(0, 10)}] ${s.goal}`);
    }
  }

  if (context.architectureDecisions.length > 0) {
    lines.push('\n### Architecture Decisions');
    for (const d of context.architectureDecisions) {
      const rationale = d.rationale ? ` (${d.rationale})` : '';
      lines.push(`- ${d.decision}${rationale}`);
    }
  }

  if (context.recentExecutions.length > 0) {
    lines.push('\n### Recent Execution History');
    for (const e of context.recentExecutions) {
      lines.push(
        `- Spec ${e.specId.slice(0, 8)}: ${e.completedTasks} tasks completed, ${e.failedTasks} failed (${e.completedAt.slice(0, 10)})`,
      );
    }
  }

  return lines.join('\n');
}

export class MemoryContextInjector {
  private store: ProjectMemoryStore;

  constructor(cwd?: string) {
    this.store = new ProjectMemoryStore(cwd);
  }

  getContext(): MemoryContext {
    const memory = this.store.read();
    return buildMemoryContext(memory);
  }

  async getContextForTopic(topic: string, options?: RelatedSpecOptions): Promise<MemoryContext> {
    const memory = this.store.read();
    const related = await findRelatedSpecs(memory, topic, options);
    return buildMemoryContext(memory, related);
  }

  formatForPrompt(): string {
    const context = this.getContext();
    return formatMemoryContextForPrompt(context);
  }
}
