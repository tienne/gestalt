import type { MasterConfig } from './scheduler.js';
import { openOrReuse } from './gates.js';
import { newId, type MasterStore } from './store.js';
import {
  isIssueType,
  isJiraStatus,
  isOrderScope,
  isWorkerKind,
  type IntakeKind,
  type IssueType,
  type JiraStatus,
  type Order,
  type OrderScope,
  type WorkerKind,
} from './types.js';

/**
 * 주문 접수.
 *
 * 경로는 셋이다. 마스터 세션에 말로 던진 요청은 CLI가 바로 넣는다. 지라 티켓과 외부 큐는
 * tick마다 어댑터로 가져온다. 같은 sourceRef가 다시 들어오면 새 주문을 만들지 않는다.
 * 레포를 모르는 티켓처럼 주문으로 세울 수 없는 건 사람에게 한 번만 묻는다.
 */

export const DEFAULT_SKILL_CHAIN: readonly string[] = ['solve', 'ship'];

export interface IntakeInput {
  source: IntakeKind;
  /** 비우면 말로 던진 주문으로 보고 새로 만든다 */
  sourceRef?: string;
  repo: string;
  title: string;
  description?: string;
  scope?: OrderScope;
  issueKey?: string;
  issueType?: IssueType;
  skillChain?: string[];
  workerKind?: WorkerKind;
  explicitJiraStatus?: JiraStatus;
  prRef?: string;
}

export interface IntakeResult {
  order: Order;
  created: boolean;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export function intakeOrder(
  store: MasterStore,
  input: IntakeInput,
  config: Pick<MasterConfig, 'defaultScope'>,
): IntakeResult {
  if (!REPO_RE.test(input.repo))
    throw new Error(`레포는 owner/name 꼴로 적어 주세요: ${input.repo}`);
  if (!input.title.trim()) throw new Error('주문 제목이 비었어요');

  const id = newId('ord');
  const sourceRef = input.sourceRef ?? `${input.source}:${id}`;
  const existing = store.findOrderBySourceRef(sourceRef);
  if (existing) return { order: existing, created: false };

  const at = store.timestamp();
  const order: Order = {
    id,
    source: input.source,
    sourceRef,
    repo: input.repo,
    title: input.title.trim(),
    scope: input.scope ?? config.defaultScope,
    skillChain: input.skillChain?.length ? input.skillChain : [...DEFAULT_SKILL_CHAIN],
    status: 'queued',
    createdAt: at,
    updatedAt: at,
    ...(input.description ? { description: input.description } : {}),
    ...(input.issueKey ? { issueKey: input.issueKey } : {}),
    ...(input.issueType ? { issueType: input.issueType } : {}),
    ...(input.workerKind ? { workerKind: input.workerKind } : {}),
    ...(input.explicitJiraStatus ? { explicitJiraStatus: input.explicitJiraStatus } : {}),
    ...(input.prRef ? { prRef: input.prRef } : {}),
  };
  store.addOrder(order);
  return { order, created: true };
}

// ─── 지라 ────────────────────────────────────────────────────────

export interface JiraTicket {
  key: string;
  summary: string;
  description?: string;
  issueType: string;
  /** 티켓에서 읽은 레포. 라벨이나 컴포넌트에서 뽑는 건 어댑터가 정한다 */
  repo?: string;
  scope?: string;
}

/** 마스터에게 배정된 티켓을 가져오는 어댑터. 실제 지라 호출은 구현이 한다 */
export interface JiraIntakeSource {
  fetchAssigned(): Promise<JiraTicket[]>;
}

export interface PollResult {
  created: Order[];
  /** 주문으로 세우지 못해 사람에게 물은 것 */
  gated: string[];
}

export async function pollJira(
  store: MasterStore,
  source: JiraIntakeSource,
  config: Pick<MasterConfig, 'defaultScope'>,
): Promise<PollResult> {
  const result: PollResult = { created: [], gated: [] };
  for (const t of await source.fetchAssigned()) {
    const sourceRef = `jira:${t.key}`;
    if (store.findOrderBySourceRef(sourceRef)) continue;
    if (!t.repo || !REPO_RE.test(t.repo)) {
      askOnce(store, sourceRef, `${t.key} 티켓의 레포를 모르겠어요. 티켓에 레포를 적어 주세요`);
      result.gated.push(sourceRef);
      continue;
    }
    const scope = t.scope && isOrderScope(t.scope) ? t.scope : undefined;
    const { order, created } = intakeOrder(
      store,
      {
        source: 'jira',
        sourceRef,
        repo: t.repo,
        title: t.summary,
        issueKey: t.key,
        issueType: normalizeIssueType(t.issueType),
        ...(t.description ? { description: t.description } : {}),
        ...(scope ? { scope } : {}),
      },
      config,
    );
    if (created) result.created.push(order);
  }
  return result;
}

/** 지라 이슈 유형 이름을 규칙이 아는 이름으로 맞춘다 */
export function normalizeIssueType(name: string): IssueType {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (key === 'subtask') return 'sub-task';
  if (key === 'subbug') return 'sub-bug';
  return isIssueType(key) ? key : 'other';
}

// ─── 외부 큐 ─────────────────────────────────────────────────────

export interface QueueMessage {
  id: string;
  body: unknown;
}

/**
 * 외부 큐 어댑터. 받은 메시지는 주문으로 저장한 뒤에 ack한다.
 * 저장 직후 끊겨 같은 메시지가 다시 와도 sourceRef로 걸러진다.
 */
export interface ExternalQueue {
  receive(max: number): Promise<QueueMessage[]>;
  ack(id: string): Promise<void>;
}

export async function pollQueue(
  store: MasterStore,
  queue: ExternalQueue,
  config: Pick<MasterConfig, 'defaultScope'>,
  max = 20,
): Promise<PollResult> {
  const result: PollResult = { created: [], gated: [] };
  for (const msg of await queue.receive(max)) {
    const sourceRef = `queue:${msg.id}`;
    if (!store.findOrderBySourceRef(sourceRef)) {
      const parsed = parseQueueBody(msg.body);
      if (typeof parsed === 'string') {
        askOnce(store, sourceRef, `큐 메시지 ${msg.id}를 주문으로 못 읽었어요: ${parsed}`);
        result.gated.push(sourceRef);
      } else {
        const { order, created } = intakeOrder(
          store,
          { ...parsed, source: 'external-queue', sourceRef },
          config,
        );
        if (created) result.created.push(order);
      }
    }
    await queue.ack(msg.id);
  }
  return result;
}

/** 큐 메시지 본문을 접수 입력으로 읽는다. 못 읽으면 이유를 문자열로 돌려준다 */
export function parseQueueBody(body: unknown): Omit<IntakeInput, 'source' | 'sourceRef'> | string {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return 'JSON 객체가 아니에요';
  const b = body as Record<string, unknown>;
  if (typeof b['repo'] !== 'string' || !REPO_RE.test(b['repo']))
    return 'repo가 owner/name 꼴이 아니에요';
  if (typeof b['title'] !== 'string' || !b['title'].trim()) return 'title이 없어요';
  const out: Omit<IntakeInput, 'source' | 'sourceRef'> = { repo: b['repo'], title: b['title'] };
  if (typeof b['description'] === 'string') out.description = b['description'];
  if (typeof b['scope'] === 'string') {
    if (!isOrderScope(b['scope'])) return `scope를 모르겠어요: ${b['scope']}`;
    out.scope = b['scope'];
  }
  if (typeof b['issueKey'] === 'string') out.issueKey = b['issueKey'];
  if (typeof b['issueType'] === 'string') out.issueType = normalizeIssueType(b['issueType']);
  if (typeof b['workerKind'] === 'string' && isWorkerKind(b['workerKind']))
    out.workerKind = b['workerKind'];
  if (typeof b['jiraStatus'] === 'string' && isJiraStatus(b['jiraStatus'])) {
    out.explicitJiraStatus = b['jiraStatus'];
  }
  if (Array.isArray(b['skillChain']) && b['skillChain'].every((x) => typeof x === 'string')) {
    out.skillChain = b['skillChain'] as string[];
  }
  return out;
}

/** 같은 출처로 이미 물었으면 다시 묻지 않는다. 사람이 거절한 것도 다시 안 묻는다 */
function askOnce(store: MasterStore, sourceRef: string, reason: string): void {
  const asked = Object.values(store.snapshot.gates).some(
    (g) => g.payload?.['sourceRef'] === sourceRef,
  );
  if (asked) return;
  openOrReuse(store, { type: 'no-procedure', reason, payload: { sourceRef } });
}
