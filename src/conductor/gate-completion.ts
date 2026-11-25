import { isDeepStrictEqual } from 'node:util';
import {
  matchesApprovedDeployment,
  requestedDeployment,
  type ReadDeploymentEvidence,
} from './deployment-evidence.js';
import type { Launcher } from './launcher.js';
import { orderHasPendingSlack } from './slack-state.js';
import type { ConductorStore } from './store.js';
import type { Gate, Worker } from './types.js';
import {
  CLEANUP_FAILED,
  CLEANUP_ORDER_STATUSES,
  cleanupDispatch,
  workerCompletion,
} from './worker-completion.js';

interface ReconciliationReport {
  at: string;
  warnings: string[];
}

export async function reconcileDeployments(
  store: ConductorStore,
  read: ReadDeploymentEvidence | undefined,
  report: ReconciliationReport,
) {
  for (const gate of Object.values(store.snapshot.gates)) {
    if (gate.completion || gate.decision === 'rejected' || gate.decision === 'taken-over') continue;
    const target = gate.approvedDeployment;
    if (!target && !requestedDeployment(gate)) continue;
    const hold = (reason: string) => report.warnings.push(`${gate.id} 배포 완료 보류: ${reason}`);
    if (!target || gate.status !== 'resolved' || gate.decision !== 'approved') {
      hold('실행과 환경이 명시된 배포 승인이 없어요');
      continue;
    }
    const current = () => {
      const g = store.snapshot.gates[gate.id];
      const order = g?.orderId ? store.order(g.orderId) : undefined;
      return (
        g !== undefined &&
        isDeepStrictEqual(g, gate) &&
        matchesApprovedDeployment(g, target) &&
        order?.repo === target.repo &&
        order.scope === 'approval' &&
        order.status === 'done'
      );
    };
    if (!current()) {
      hold('현재 게이트와 주문이 승인한 배포에 맞지 않아요');
      continue;
    }
    try {
      const result = await read?.(target);
      if (!result) hold('GitHub 조회 경로가 없어요');
      else if ('reason' in result) hold(result.reason);
      else if (
        !store.appendIfCurrent(
          {
            type: 'gate-completed',
            at: report.at,
            gateId: gate.id,
            evidence: { kind: 'github-deployment', target, ...result },
          },
          current,
        )
      )
        hold('조회 중 게이트나 주문 상태가 바뀌었어요');
    } catch {
      hold('GitHub 배포 증빙을 조회하거나 기록하지 못했어요');
    }
  }
}

function workerCleanupBlocker(
  store: ConductorStore,
  worker: Worker,
  gate: Gate,
): string | undefined {
  const order = store.order(worker.orderId);
  if (
    !worker.handle ||
    cleanupDispatch(gate) !== worker.handle ||
    gate.payload?.orderId !== worker.orderId
  )
    return '게이트에 남은 승인 대상과 현재 워커 실행이 달라요';
  if (
    worker.waiting ||
    !order ||
    !CLEANUP_ORDER_STATUSES.has(order.status) ||
    (order.deploys?.length && !order.deploysRecordedAt) ||
    orderHasPendingSlack(store.snapshot, order.id) ||
    Object.values(store.snapshot.gates).some(
      (g) =>
        g.orderId === order.id &&
        (g.status === 'open' || g.deliveryPending || (g.approvedDeployment && !g.completion)),
    ) ||
    store.activeWorkers().some((w) => w.orderId === order.id) ||
    store
      .orders()
      .some((o) => o.parentOrderId === order.id && !CLEANUP_ORDER_STATUSES.has(o.status))
  )
    return '주문이나 워커에 남은 후속 작업이 있어요';
}

export async function reconcileWorker(
  store: ConductorStore,
  launcher: Launcher | undefined,
  report: ReconciliationReport,
  worker: Worker,
  gate: Gate,
  removeWorktree: boolean,
): Promise<void> {
  const hold = (reason: string) => report.warnings.push(`${gate.id} 워커 정리 보류: ${reason}`);
  const order = store.order(worker.orderId);
  const blocker = workerCleanupBlocker(store, worker, gate);
  if (blocker) {
    hold(blocker);
    return;
  }
  try {
    const observed = await launcher?.completion?.(worker);
    if (!observed) {
      hold('Orca 조회 경로가 없어요');
      return;
    }
    const evidence = workerCompletion(worker, observed);
    if ('reason' in evidence) {
      hold(evidence.reason);
      return;
    }
    if (removeWorktree || gate.payload?.removeWorktree === 'true') {
      const workspace = observed.workspace;
      if (!workspace || !(await launcher?.workspaceRemoved?.(worker, workspace))) {
        hold('워크트리 정리 증빙이 필요해요');
        return;
      }
      evidence.removedWorkspace = workspace;
    }
    const saved = store.appendIfCurrent(
      { type: 'gate-completed', at: report.at, gateId: gate.id, evidence },
      () => {
        const mine = Object.values(store.snapshot.gates).filter(
          (g) => g.payload?.kind === CLEANUP_FAILED && g.payload.workerId === worker.id,
        );
        return (
          isDeepStrictEqual(mine.at(-1), gate) &&
          !mine.some((g) => g.status === 'open') &&
          isDeepStrictEqual(store.worker(worker.id), worker) &&
          isDeepStrictEqual(store.order(worker.orderId), order) &&
          !workerCleanupBlocker(store, worker, gate)
        );
      },
    );
    if (!saved) hold('조회 중 게이트나 워커 상태가 바뀌었어요');
  } catch {
    hold('Orca 종료 증빙을 조회하거나 기록하지 못했어요');
  }
}
