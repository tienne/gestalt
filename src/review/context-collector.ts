import type { Spec, TaskExecutionResult, ReviewContext } from '../core/types.js';

export class ReviewContextCollector {
  collect(spec: Spec, taskResults: TaskExecutionResult[]): ReviewContext {
    const changedFiles = this.extractChangedFiles(taskResults);

    return {
      changedFiles,
      dependencyFiles: this.extractDependenciesFromOutput(taskResults, changedFiles),
      spec,
      taskResults,
    };
  }

  /**
   * 변경 파일 목록만으로 리뷰 컨텍스트를 만든다 (execute 세션 없는 직접 리뷰).
   *
   * 의존 파일을 채우지 않는다 — 코드 그래프로 영향 파일을 얹으면 리뷰어가 안 바뀐
   * 파일을 변경 파일로 오해해서 기존 코드를 지적한다. 호출부 확인이 필요한 변경은
   * 리뷰어가 직접 읽는다.
   */
  collectFromFiles(changedFiles: string[]): ReviewContext {
    return {
      changedFiles: [...changedFiles].sort(),
      dependencyFiles: [],
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
