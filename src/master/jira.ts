import type { MasterStore } from './store.js';
import type { IssueType, JiraStatus, Order } from './types.js';

/**
 * 지라 상태 전환 규칙.
 *
 * 주문을 파악하면 TODO, 실행을 시작하면 In Progress, 리뷰에 들어가면 PR로 옮긴다.
 * 머지되면 sub-task는 Done이고 bug, task, sub-bug는 배포 파이프라인이 성공한 뒤에만
 * In-QA로 간다. 사용자가 마스터 세션에서 상태를 직접 정했으면 그게 먼저다.
 *
 * 실제 지라 호출은 `JiraClient` 구현이 한다. 이 모듈은 어디로 옮길지만 정한다.
 */

export type OrderStage = 'identified' | 'started' | 'review' | 'merged' | 'deployed';

export interface DeploySignal {
  status: 'success' | 'failed' | 'pending' | 'unknown';
  ref?: string;
}

export interface JiraClient {
  transition(issueKey: string, to: JiraStatus): Promise<void>;
}

/** 머지 뒤 배포 파이프라인 결과를 알려 주는 어댑터 */
export interface DeploySource {
  status(order: Order): Promise<DeploySignal>;
}

/** 배포를 기다렸다가 In-QA로 가는 유형. 엔진의 머지 뒤 정산도 이 집합으로 배포를 기다릴지 정한다 */
export const QA_TYPES: ReadonlySet<IssueType> = new Set(['bug', 'task', 'sub-bug']);

// 뒤로 가는 전환을 막는 데 쓴다. Done과 In-QA는 둘 다 끝 자리라 같은 값이다
const RANK: Record<JiraStatus, number> = {
  TODO: 0,
  'In Progress': 1,
  PR: 2,
  Done: 3,
  'In-QA': 3,
};

/**
 * 단계와 이슈 유형으로 기본 규칙의 목표 상태를 낸다. 옮길 자리가 없으면 null이다.
 *
 * story와 other는 스펙에 규칙이 없어 PR에서 멈춘다. 어디로 옮길지는 사용자가 정한다.
 */
export function defaultJiraTarget(
  stage: OrderStage,
  issueType: IssueType | undefined,
  deploy?: DeploySignal,
): JiraStatus | null {
  switch (stage) {
    case 'identified':
      return 'TODO';
    case 'started':
      return 'In Progress';
    case 'review':
      return 'PR';
    case 'merged':
      return issueType === 'sub-task' ? 'Done' : null;
    case 'deployed':
      if (issueType === 'sub-task') return 'Done';
      if (issueType && QA_TYPES.has(issueType) && deploy?.status === 'success') return 'In-QA';
      return null;
  }
}

/** 이번에 옮길 상태. 이미 그 상태거나 뒤로 가는 전환이면 null이다 */
export function decideJiraTransition(
  order: Order,
  stage: OrderStage,
  deploy?: DeploySignal,
): JiraStatus | null {
  if (!order.issueKey) return null;
  if (order.explicitJiraStatus) {
    return order.explicitJiraStatus === order.jiraStatus ? null : order.explicitJiraStatus;
  }
  const target = defaultJiraTarget(stage, order.issueType, deploy);
  if (!target || target === order.jiraStatus) return null;
  if (order.jiraStatus && RANK[target] < RANK[order.jiraStatus]) return null;
  return target;
}

/** 정한 전환을 지라에 반영하고 저장소에 남긴다. 옮긴 상태를 돌려준다 */
export async function syncJira(
  store: MasterStore,
  orderId: string,
  stage: OrderStage,
  jira: JiraClient,
  deploy?: DeploySignal,
): Promise<JiraStatus | null> {
  const order = store.order(orderId);
  if (!order?.issueKey) return null;
  const to = decideJiraTransition(order, stage, deploy);
  if (!to) return null;
  await jira.transition(order.issueKey, to);
  const at = store.timestamp();
  store.append({
    type: 'jira-transition',
    at,
    record: {
      orderId,
      issueKey: order.issueKey,
      ...(order.jiraStatus ? { from: order.jiraStatus } : {}),
      to,
      at,
    },
  });
  store.updateOrder(orderId, { jiraStatus: to });
  return to;
}
