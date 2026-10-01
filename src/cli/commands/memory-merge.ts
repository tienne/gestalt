import { runMemoryMergeDriver } from '../../memory/memory-merge.js';

// git merge driver는 종료 코드만 본다. 0이면 %A를 결과로 받고 그 밖이면 충돌로 남긴다
export function memoryMergeCommand(oursPath: string, theirsPath: string): void {
  try {
    const merged = runMemoryMergeDriver(oursPath, theirsPath);
    process.stderr.write(
      `gestalt: memory.json merged (specs ${merged.specHistory.length}, executions ${merged.executionHistory.length}, decisions ${merged.architectureDecisions.length})\n`,
    );
  } catch (e) {
    process.stderr.write(
      `gestalt: memory.json merge failed, leaving conflict (${e instanceof Error ? e.message : String(e)})\n`,
    );
    process.exitCode = 1;
  }
}
