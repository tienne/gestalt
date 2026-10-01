import type { Result } from '../../src/core/result.js';
import type { StructuralResult } from '../../src/core/types.js';
import type { PassthroughEvaluateResult } from '../../src/execute/orchestrators/types.js';

/**
 * startEvaluation이 요청한 명령 문자열로 제출 결과를 맞춘다.
 * 종료 코드와 출력은 이름별로 draft에서 가져오고 draft에 없는 명령은 통과로 채운다.
 */
export function asRequested(
  start: Result<PassthroughEvaluateResult, unknown>,
  draft: StructuralResult,
): StructuralResult {
  if (!start.ok) throw new Error('startEvaluation failed');
  const requested = start.value.structuralContext!.commands;
  const byName = new Map(draft.commands.map((c) => [c.name, c]));
  return {
    commands: requested.map((req) => ({
      name: req.name,
      command: req.command,
      exitCode: byName.get(req.name)?.exitCode ?? 0,
      output: byName.get(req.name)?.output ?? 'ok',
    })),
    allPassed: draft.allPassed,
  };
}
