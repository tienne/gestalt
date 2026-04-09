import type { Spec, TaskExecutionResult, ReviewContext } from '../core/types.js';

export class ReviewContextCollector {
  collect(spec: Spec, taskResults: TaskExecutionResult[]): ReviewContext {
    const changedFiles = this.extractChangedFiles(taskResults);
    const dependencyFiles = this.extractDependencies(taskResults, changedFiles);

    return {
      changedFiles,
      dependencyFiles,
      spec,
      taskResults,
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

  private extractDependencies(
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
