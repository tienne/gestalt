import type { ProjectMemory } from '../core/types.js';
import { ProjectMemoryStore } from './project-memory-store.js';

export interface MemoryContext {
  recentSpecs: Array<{ goal: string; specId: string; createdAt: string; sourceType: string }>;
  architectureDecisions: string[];
  recentExecutions: Array<{
    specId: string;
    completedTasks: number;
    failedTasks: number;
    completedAt: string;
  }>;
  hasContext: boolean;
}

export function buildMemoryContext(memory: ProjectMemory): MemoryContext {
  const recentSpecs = memory.specHistory.slice(-5).map((s) => ({
    goal: s.goal,
    specId: s.specId,
    createdAt: s.createdAt,
    sourceType: s.sourceType,
  }));

  const recentExecutions = memory.executionHistory.slice(-3).map((e) => ({
    specId: e.specId,
    completedTasks: e.completedTasks.length,
    failedTasks: e.failedTasks.length,
    completedAt: e.completedAt,
  }));

  const hasContext =
    recentSpecs.length > 0 ||
    memory.architectureDecisions.length > 0 ||
    recentExecutions.length > 0;

  return {
    recentSpecs,
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

  if (context.architectureDecisions.length > 0) {
    lines.push('\n### Architecture Decisions');
    for (const d of context.architectureDecisions) {
      lines.push(`- ${d}`);
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

  formatForPrompt(): string {
    const context = this.getContext();
    return formatMemoryContextForPrompt(context);
  }
}
