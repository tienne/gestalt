import type { Spec, TaskExecutionResult, ReviewContext } from '../core/types.js';
import { codeGraphEngine } from '../code-graph/engine.js';

export class ReviewContextCollector {
  collect(spec: Spec, taskResults: TaskExecutionResult[], repoRoot?: string): ReviewContext {
    const changedFiles = this.extractChangedFiles(taskResults);
    const dependencyFiles = repoRoot
      ? this.extractDependenciesFromGraph(changedFiles, repoRoot)
      : this.extractDependenciesFromOutput(taskResults, changedFiles);

    return {
      changedFiles,
      dependencyFiles,
      spec,
      taskResults,
    };
  }

  collectFromFiles(changedFiles: string[], repoRoot: string): ReviewContext {
    const dependencyFiles = this.extractDependenciesFromGraph(changedFiles, repoRoot);
    return {
      changedFiles: [...changedFiles].sort(),
      dependencyFiles,
      spec: undefined,
      taskResults: undefined,
    };
  }

  private extractChangedFiles(taskResults: TaskExecutionResult[]): string[] {
    const files = new Set<string>();

    for (const result of taskResults) {
      for (const artifact of result.artifacts) {
        // Artifacts typically contain file paths
        if (artifact.match(/\.\w+$/)) {
          files.add(artifact);
        }
      }
    }

    return [...files].sort();
  }

  private extractDependenciesFromGraph(changedFiles: string[], repoRoot: string): string[] {
    try {
      if (!codeGraphEngine.dbExists(repoRoot)) return [];
      const result = codeGraphEngine.blastRadius(repoRoot, { changedFiles });
      const changedSet = new Set(changedFiles);
      return result.impactedFiles.filter((f) => !changedSet.has(f)).sort();
    } catch {
      return [];
    }
    // finally: close() 금지 — 싱글턴
  }

  private extractDependenciesFromOutput(
    taskResults: TaskExecutionResult[],
    changedFiles: string[],
  ): string[] {
    const deps = new Set<string>();

    // Extract import references from task output
    for (const result of taskResults) {
      const importMatches = result.output.matchAll(/(?:import|from)\s+['"]([^'"]+)['"]/g);
      for (const match of importMatches) {
        const importPath = match[1]!;
        // Only include relative imports (not node_modules)
        if (importPath.startsWith('.') || importPath.startsWith('/')) {
          deps.add(importPath);
        }
      }
    }

    // Remove files that are already in changedFiles
    for (const file of changedFiles) {
      deps.delete(file);
    }

    return [...deps].sort();
  }
}
