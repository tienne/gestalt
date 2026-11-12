import { log } from '../core/log.js';
import type { ConductorConfig } from './scheduler.js';
import { openOrReuse } from './gates.js';
import { newId, type ConductorStore } from './store.js';
import {
  AGENT_ID_RE,
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
 * 경로는 셋이다. 컨덕터 세션에 말로 던진 요청은 CLI가 바로 넣는다. 지라 티켓과 외부 큐는
 * tick마다 어댑터로 가져온다. 같은 sourceRef가 다시 들어오면 새 주문을 만들지 않는다.
 * 레포를 모르는 티켓처럼 주문으로 세울 수 없는 건 사람에게 한 번만 묻는다.
 */

export const DEFAULT_SKILL_CHAIN: readonly string[] = ['solve', 'ship'];

/**
 * 워커 체인에 넣을 수 있는 스킬. 워커를 띄우는 dispatch와 handoff는 하위 워커 금지와 부딪혀 뺀다
 */
export const KNOWN_SKILLS: ReadonlySet<string> = new Set([
  'solve',
  'interview',
  'spec',
  'execute',
  'ship',
  'pr',
  'local-pr',
  'review',
  'review-loop',
  'review-reply',
  'blast-radius',
  'diff-radius',
  'explain',
  'doubt',
  'build-graph',
]);

export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

/** 개행을 포함한 C0, C1 제어 문자와 U+2028/2029. 저장 때 거르는 문자와 출력 때 지우는 문자를 같게 둔다 */
export function isControlChar(c: number): boolean {
  return c < 0x20 || (c >= 0x7f && c < 0xa0) || c === 0x2028 || c === 0x2029;
}

/** 지시서 한 줄에 들어갈 값. 개행과 제어 문자로 지시 블록을 위조하지 못하게 공백으로 바꾸고 자른다 */
export function oneLine(text: string, max = 200): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    out += isControlChar(c) ? ' ' : ch;
  }
  return [...out.replace(/\s+/g, ' ').trim()].slice(0, max).join('');
}

const SCOPE_RANK: Record<OrderScope, number> = {
  'merge-through': 0,
  approval: 1,
  'interview-first': 2,
};

/**
 * 바깥(지라, 큐, 남의 PR)이 적은 범위는 설정 기본값보다 느슨하게 못 연다. merge-through는 기본값이어도
 * 받지 않는다. 큐나 티켓에 쓸 수 있는 누구나 머지 승인을 끌 수 있으면 안 돼서다
 */
function externalScope(asked: OrderScope | undefined, fallback: OrderScope): OrderScope {
  const floor = fallback === 'merge-through' ? 'approval' : fallback;
  if (!asked || SCOPE_RANK[asked] < SCOPE_RANK[floor]) return floor;
  return asked;
}

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
  agent?: string;
  explicitJiraStatus?: JiraStatus;
  prRef?: string;
  parentOrderId?: string;
}

export interface IntakeResult {
  order: Order;
  created: boolean;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
/**
 * 컨덕터 세션이 직접 넣지 않은 주문의 본문 상한. 본문은 이벤트 로그에 그대로 쌓여 tick마다
 * 다시 읽히고 워커 지시서에도 실리므로 밖에서 로그를 부풀리지 못하게 자른다
 */
export const EXTERNAL_DESCRIPTION_MAX = 4000;

function capDescription(text: string): string {
  const chars = [...text];
  return chars.length > EXTERNAL_DESCRIPTION_MAX
    ? `${chars.slice(0, EXTERNAL_DESCRIPTION_MAX).join('')} (잘림)`
    : text;
}

/**
 * 주문을 받는다. 범위와 스킬 체인을 그대로 믿는 건 컨덕터 세션이 CLI로 넣을 때(`trusted`)와
 * 말로 던진 주문뿐이다. 지라, 큐, PR 감시에서 온 값은 externalScope와 KNOWN_SKILLS로 거른다
 */
export function intakeOrder(
  store: ConductorStore,
  input: IntakeInput,
  config: Pick<ConductorConfig, 'defaultScope'>,
  opts: { trusted?: boolean } = {},
): IntakeResult {
  if (!REPO_RE.test(input.repo))
    throw new Error(`레포는 owner/name 꼴로 적어 주세요: ${input.repo}`);
  if (input.agent !== undefined && !AGENT_ID_RE.test(input.agent))
    throw new Error(
      'agent는 영문자나 숫자로 시작하고 영문자, 숫자, `.`, `_`, `:`, `-`만 쓴 64자 이하 id로 적어 주세요',
    );
  const title = oneLine(input.title);
  if (!title) throw new Error('주문 제목이 비었어요');
  const trusted = opts.trusted === true || input.source === 'spoken';
  const skills = trusted ? input.skillChain : input.skillChain?.filter((s) => KNOWN_SKILLS.has(s));

  const description =
    input.description && opts.trusted !== true
      ? capDescription(input.description)
      : input.description;

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
    title,
    scope: trusted
      ? (input.scope ?? config.defaultScope)
      : externalScope(input.scope, config.defaultScope),
    skillChain: skills?.length ? skills : [...DEFAULT_SKILL_CHAIN],
    status: 'queued',
    createdAt: at,
    updatedAt: at,
    ...(description ? { description } : {}),
    ...(input.issueKey ? { issueKey: input.issueKey } : {}),
    ...(input.issueType ? { issueType: input.issueType } : {}),
    ...(input.workerKind ? { workerKind: input.workerKind } : {}),
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.explicitJiraStatus ? { explicitJiraStatus: input.explicitJiraStatus } : {}),
    ...(input.prRef ? { prRef: input.prRef } : {}),
    ...(input.parentOrderId ? { parentOrderId: input.parentOrderId } : {}),
  };
  store.addOrder(order);
  return { order, created: true };
}

export interface JiraTicket {
  key: string;
  summary: string;
  description?: string;
  issueType: string;
  /** 티켓에서 읽은 레포. 라벨이나 컴포넌트에서 뽑는 건 어댑터가 정한다 */
  repo?: string;
  scope?: string;
}

/**
 * 컨덕터에게 배정된 티켓을 가져오는 어댑터. 실제 지라 호출은 구현이 한다.
 * 페이지 상한에 닿아 뒤를 못 읽었으면 `truncated`를 켠다. 배열만 돌려주면 전부 읽은 것으로 본다
 */
export interface JiraIntakeSource {
  fetchAssigned(): Promise<JiraTicket[] | { tickets: JiraTicket[]; truncated?: boolean }>;
}

export interface PollResult {
  created: Order[];
  /** 주문으로 세우지 못해 사람에게 물은 것 */
  gated: string[];
  /** 소스가 상한에 닿아 이번에 다 못 읽었다 */
  truncated?: boolean;
}

export async function pollJira(
  store: ConductorStore,
  source: JiraIntakeSource,
  config: Pick<ConductorConfig, 'defaultScope'>,
): Promise<PollResult> {
  const result: PollResult = { created: [], gated: [] };
  const fetched = await source.fetchAssigned();
  const tickets = Array.isArray(fetched) ? fetched : fetched.tickets;
  if (!Array.isArray(fetched) && fetched.truncated) {
    result.truncated = true;
    log(`지라 배정 티켓이 조회 상한에 닿아 ${tickets.length}개까지만 읽었어요`);
  }
  for (const t of tickets) {
    const sourceRef = `jira:${t.key}`;
    if (store.findOrderBySourceRef(sourceRef)) continue;
    if (!ISSUE_KEY_RE.test(t.key)) {
      askOnce(store, sourceRef, `지라 키 꼴이 아니라 주문으로 안 받았어요: ${oneLine(t.key, 40)}`);
      result.gated.push(sourceRef);
      continue;
    }
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
  store: ConductorStore,
  queue: ExternalQueue,
  config: Pick<ConductorConfig, 'defaultScope'>,
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
  if (b['issueKey'] !== undefined) {
    if (typeof b['issueKey'] !== 'string' || !ISSUE_KEY_RE.test(b['issueKey']))
      return 'issueKey가 PROJ-123 꼴이 아니에요';
    out.issueKey = b['issueKey'];
  }
  if (typeof b['issueType'] === 'string') out.issueType = normalizeIssueType(b['issueType']);
  if (b['workerKind'] !== undefined) {
    if (typeof b['workerKind'] !== 'string' || !isWorkerKind(b['workerKind']))
      return `workerKind를 모르겠어요: ${String(b['workerKind'])}`;
    out.workerKind = b['workerKind'];
  }
  if (b['jiraStatus'] !== undefined) {
    if (typeof b['jiraStatus'] !== 'string' || !isJiraStatus(b['jiraStatus']))
      return `jiraStatus를 모르겠어요: ${String(b['jiraStatus'])}`;
    out.explicitJiraStatus = b['jiraStatus'];
  }
  if (Array.isArray(b['skillChain']) && b['skillChain'].every((x) => typeof x === 'string')) {
    // 모르는 이름은 접수에서 걸러진다. 여기서는 꼴만 본다
    out.skillChain = b['skillChain'] as string[];
  }
  return out;
}

/** 같은 출처로 이미 물었으면 다시 묻지 않는다. 사람이 거절한 것도 다시 안 묻는다 */
function askOnce(store: ConductorStore, sourceRef: string, reason: string): void {
  const asked = Object.values(store.snapshot.gates).some(
    (g) => g.payload?.['sourceRef'] === sourceRef,
  );
  if (asked) return;
  openOrReuse(store, { type: 'no-procedure', reason, payload: { sourceRef } });
}
