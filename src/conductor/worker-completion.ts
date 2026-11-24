import type { OrcaWorkerCompletion } from './launcher.js';
import type { Gate, GateCompletionEvidence, OrderStatus, Worker } from './types.js';

export const CLEANUP_FAILED = 'cleanup-failed';
export const CLEANUP_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'done',
  'failed',
  'cancelled',
]);

export function cleanupDispatch(gate: Gate): string | undefined {
  if (gate.payload?.dispatchId) return gate.payload.dispatchId;
  // 예전 게이트는 사람이 보던 stop 명령에만 승인 대상 dispatch를 남겼다.
  return /`orca orchestration worker-stop --dispatch=(ctx_[a-z0-9]+)`/.exec(gate.reason)?.[1];
}

export function workerCompletion(
  worker: Worker,
  observed: OrcaWorkerCompletion,
): Extract<GateCompletionEvidence, { kind: 'orca-worker' }> | { reason: string } {
  if (!worker.handle || observed.dispatchId !== worker.handle || !observed.runId)
    return { reason: 'Orca가 돌려준 워커 또는 실행 식별자가 맞지 않아요' };
  if (
    (observed.state !== 'stopped' && observed.state !== 'succeeded') ||
    (observed.liveness !== 'exited' && observed.liveness !== 'gone')
  )
    return { reason: 'Orca에서 워커가 종료됐다는 근거를 확인하지 못했어요' };
  if (
    observed.terminalState !== 'released' ||
    (observed.waitingOnHuman !== undefined &&
      observed.waitingOnHuman !== 'no' &&
      observed.waitingOnHuman !== 'unknown')
  )
    return { reason: 'Orca 터미널 정리나 사람 확인이 남아 있어요' };
  return {
    kind: 'orca-worker',
    workerId: worker.id,
    dispatchId: worker.handle,
    runId: observed.runId,
    state: observed.state,
  };
}
