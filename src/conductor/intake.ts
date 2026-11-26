import { statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { log } from '../core/log.js';
import type { ConductorConfig } from './scheduler.js';
import { openOrReuse } from './gates.js';
import { real } from './parent-worktree.js';
import { preparedPlanSourceRef, type PreparedPlan } from './prepared-plan.js';
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
import { classifyWork, isWorkClass, type WorkClass } from './work-class.js';

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

/**
 * 대상 레포에만 있는 프로젝트 스킬을 체인에 넣을 때 붙이는 접두. 게슈탈트 스킬 이름과 섞이면
 * 같은 이름의 레포 스킬이 게슈탈트 스킬 자리를 차지하거나 그 반대가 되므로 따로 받는다
 */
export const REPO_SKILL_PREFIX = 'repo:';

/** 레포 스킬 이름. 경로 한 칸으로 붙으므로 `/`, `\`, `..`가 들어갈 수 없는 꼴만 받는다 */
const REPO_SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isRepoSkillName(name: string): boolean {
  return REPO_SKILL_NAME_RE.test(name);
}

export function isRepoSkill(skill: string): boolean {
  return skill.startsWith(REPO_SKILL_PREFIX);
}

/** `repo:<이름>`에서 이름만. 레포 스킬이 아니면 undefined */
export function repoSkillName(skill: string): string | undefined {
  return isRepoSkill(skill) ? skill.slice(REPO_SKILL_PREFIX.length) : undefined;
}

/** 레포 안에서 레포 스킬 문서가 있어야 할 상대 경로 */
export function repoSkillPath(name: string): string {
  return join('.claude', 'skills', name, 'SKILL.md');
}

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
  preparedPlan?: PreparedPlan;
  repo: string;
  title: string;
  description?: string;
  scope?: OrderScope;
  issueKey?: string;
  issueType?: IssueType;
  skillChain?: string[];
  workerKind?: WorkerKind;
  agent?: string;
  /** 작업 유형을 직접 정할 때. 비우면 스킬 체인으로 고른다 */
  workClass?: WorkClass;
  /** 접수 전에 resolveParentWorktree로 레포와 맞는지 확인한 절대 경로 */
  parentWorktree?: string;
  baseBranch?: string;
  explicitJiraStatus?: JiraStatus;
  prRef?: string;
  parentOrderId?: string;
  /** 배포 주문이 배포할 주문 id. 컨덕터 세션이 order add로 넣을 때만 받는다 */
  deploys?: string[];
}

export type IntakeResult =
  | { created: true; order: Order }
  | { created: false; order: Order }
  /** 같은 출처의 주문을 사람이 지웠다. 다시 받지 않는다 */
  | { created: false; removedAt: string }
  /** 같은 출처의 주문을 보관소로 옮겼다. 다시 받지 않는다 */
  | { created: false; archivedAt: string };

export const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * 기준 브랜치로 받을 ref 이름. git과 오르카 인자로 그대로 넘어가므로 `-`로 시작해 옵션으로 읽히는 값과
 * git이 ref로 안 받는 꼴(`..`, `@{`, 빈 컴포넌트, `.`으로 시작하거나 `.lock`으로 끝나는 컴포넌트)을 막는다
 */
export function isRefName(ref: string): boolean {
  return (
    /^[\w][\w./+-]*$/.test(ref) &&
    ref.length <= 200 &&
    !ref.includes('..') &&
    !ref.endsWith('.') &&
    ref.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'))
  );
}
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
 * 말로 던진 주문뿐이다. 지라, 큐, PR 감시에서 온 값은 externalScope와 KNOWN_SKILLS로 거른다.
 * 레포 스킬은 KNOWN_SKILLS에 없어 바깥 출처에서는 빠진다
 */
export function intakeOrder(
  store: ConductorStore,
  input: IntakeInput,
  config: Pick<ConductorConfig, 'defaultScope'> & Partial<Pick<ConductorConfig, 'repoPaths'>>,
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
  if (input.baseBranch !== undefined && !isRefName(input.baseBranch))
    throw new Error(`기준 브랜치 이름 꼴이 아니에요: ${oneLine(input.baseBranch)}`);
  const trusted = opts.trusted === true || input.source === 'spoken';
  if (input.parentWorktree !== undefined) {
    // 부모 경로는 order add가 이 머신에서 확인한 값만 받는다. 바깥 출처가 정하면 그 경로 아래 셋업이 돈다
    if (!trusted) throw new Error('부모 워크트리는 컨덕터 세션이 order add로 넣은 주문만 받아요');
    if (!isAbsolute(input.parentWorktree))
      throw new Error(`부모 워크트리는 절대 경로로 주세요: ${oneLine(input.parentWorktree)}`);
  }
  const deploys = input.deploys?.length
    ? checkDeployTargets(store, input.repo, input.deploys, trusted)
    : undefined;
  const skills = trusted ? input.skillChain : input.skillChain?.filter((s) => KNOWN_SKILLS.has(s));

  const description =
    input.description && opts.trusted !== true
      ? capDescription(input.description)
      : input.description;

  const id = newId('ord');
  const prepared = input.preparedPlan;
  if (
    prepared &&
    (opts.trusted !== true || input.source !== 'spoken' || input.repo !== prepared.repo)
  )
    throw new Error('준비된 계획은 운영 채팅에서 같은 레포의 일반 주문으로만 받아요');
  if (input.sourceRef?.startsWith('prepared-plan:'))
    throw new Error('준비된 계획이 사용하는 주문 출처예요');
  const sourceRef = prepared
    ? preparedPlanSourceRef(prepared.plan.planId)
    : (input.sourceRef ?? `${input.source}:${id}`);
  const existing = store.findOrderBySourceRef(sourceRef);
  if (existing) return { order: existing, created: false };
  const removedAt = store.removedAtOf(sourceRef);
  if (removedAt) return { created: false, removedAt };
  const archivedAt = store.archivedAtOf(sourceRef);
  if (archivedAt) return { created: false, archivedAt };
  // 같은 주문을 다시 넣은 경우는 위에서 돌려준다. 그사이 파일이 지워졌어도 이미 만든 주문은 그대로다
  if (trusted && skills?.some(isRepoSkill)) checkRepoSkills(skills, input, config.repoPaths ?? {});

  const skillChain = prepared
    ? ['execute', 'ship']
    : skills?.length
      ? skills
      : [...DEFAULT_SKILL_CHAIN];
  const at = store.timestamp();
  const order: Order = {
    id,
    source: input.source,
    sourceRef,
    repo: input.repo,
    title,
    ...(prepared ? { preparedPlan: prepared } : {}),
    scope: prepared
      ? 'approval'
      : trusted
        ? (input.scope ?? config.defaultScope)
        : externalScope(input.scope, config.defaultScope),
    skillChain,
    workClass: prepared ? 'work' : (input.workClass ?? classifyWork(skillChain)),
    status: 'queued',
    createdAt: at,
    updatedAt: at,
    ...(description ? { description } : {}),
    ...(input.issueKey ? { issueKey: input.issueKey } : {}),
    ...(input.issueType ? { issueType: input.issueType } : {}),
    ...(prepared
      ? { workerKind: 'orca-worktree' as const }
      : input.workerKind
        ? { workerKind: input.workerKind }
        : {}),
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.parentWorktree ? { parentWorktree: input.parentWorktree } : {}),
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
    ...(input.explicitJiraStatus ? { explicitJiraStatus: input.explicitJiraStatus } : {}),
    ...(input.prRef ? { prRef: input.prRef } : {}),
    ...(input.parentOrderId ? { parentOrderId: input.parentOrderId } : {}),
    ...(deploys ? { deploys } : {}),
  };
  return { order: store.addOrder(order), created: true };
}

/**
 * 레포 스킬이 주문을 넣는 지금 워커 워크트리가 갈라질 로컬 체크아웃에 있는지 본다. 작업 트리 파일을
 * 보므로 커밋 안 된 문서는 통과해도 커밋에서 갈라지는 워커에는 없다. 그때는 워커가 needs other로 올린다
 */
function checkRepoSkills(
  skills: string[],
  input: IntakeInput,
  repoPaths: Record<string, string>,
): void {
  // ship 단계 값이 붙은 단순 승인은 사람을 안 거치므로 같은 체인에 두면 레포 스킬의 푸시 승인도 넘어간다
  if (skills.includes('ship'))
    throw new Error('레포 스킬 체인에는 ship을 같이 넣을 수 없어요. 주문을 나눠 넣어 주세요');
  // 서브에이전트는 컨덕터 자리에서 돌아 대상 레포 워크트리의 스킬 문서를 못 읽는다
  if (input.workerKind === 'subagent')
    throw new Error(
      '레포 스킬이 있는 체인은 서브에이전트 워커로 못 띄워요. --worker-kind를 빼 주세요',
    );
  const roots = repoSkillRoots(input, repoPaths);
  const seen = new Set<string>();
  for (const skill of skills) {
    const name = repoSkillName(skill);
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    if (!isRepoSkillName(name))
      throw new Error(
        `레포 스킬 이름은 영문 소문자와 숫자, \`-\`만 쓴 64자 이하로 적어 주세요: ${oneLine(skill, 80)}`,
      );
    if (roots.length === 0)
      throw new Error(
        `${input.repo}의 로컬 경로를 몰라 ${skill} 스킬이 있는지 확인하지 못했어요. ~/.gestalt/conductor.json의 repoPaths에 적어 주세요`,
      );
    for (const root of roots) {
      const file = join(root, repoSkillPath(name));
      if (!isFile(file)) throw new Error(`${input.repo}에 ${skill} 스킬이 없어요: ${file}`);
      if (!isInside(real(root), real(file)))
        throw new Error(`${skill} 스킬 문서가 레포 밖을 가리키는 링크예요: ${file}`);
    }
  }
}

/**
 * 워커 워크트리가 갈라질 자리. git 워크트리 워커는 부모를 무시하고 repoPaths에서 띄운다. 오르카
 * 워커와 종류를 안 정한 주문은 오르카가 없으면 git 워크트리로 떨어지므로 두 자리를 다 본다
 */
function repoSkillRoots(input: IntakeInput, repoPaths: Record<string, string>): string[] {
  const repoPath = Object.hasOwn(repoPaths, input.repo) ? repoPaths[input.repo] : undefined;
  const roots = input.workerKind === 'git-worktree' ? [repoPath] : [input.parentWorktree, repoPath];
  return roots.filter((r): r is string => r !== undefined);
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 배포 대상이 같은 레포에 실제로 있는 주문인지 확인하고 겹친 id를 걷어 돌려준다 */
function checkDeployTargets(
  store: ConductorStore,
  repo: string,
  ids: string[],
  trusted: boolean,
): string[] {
  // 바깥 출처가 정하면 남의 주문에 배포 성공을 찍어 지라를 In-QA로 옮길 수 있다
  if (!trusted) throw new Error('--deploys는 컨덕터 세션이 order add로 넣을 때만 쓸 수 있어요');
  const out = [...new Set(ids)];
  for (const id of out) {
    const target = store.order(id);
    if (!target) throw new Error(`배포 대상 주문이 없어요: ${oneLine(id)}`);
    if (target.repo !== repo)
      throw new Error(`배포 대상 ${id}는 ${target.repo} 주문이라 ${repo} 배포에 못 넣어요`);
  }
  return out;
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
    if (store.hasSourceRef(sourceRef)) continue;
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
    const out = intakeOrder(
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
    if (out.created) result.created.push(out.order);
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
    if (!store.hasSourceRef(sourceRef)) {
      const parsed = parseQueueBody(msg.body);
      if (typeof parsed === 'string') {
        askOnce(store, sourceRef, `큐 메시지 ${msg.id}를 주문으로 못 읽었어요: ${parsed}`);
        result.gated.push(sourceRef);
      } else {
        const out = intakeOrder(store, { ...parsed, source: 'external-queue', sourceRef }, config);
        if (out.created) result.created.push(out.order);
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
    if (!isOrderScope(b['scope'])) return `scope를 모르겠어요: ${oneLine(b['scope'])}`;
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
      return `workerKind를 모르겠어요: ${oneLine(String(b['workerKind']))}`;
    out.workerKind = b['workerKind'];
  }
  if (b['workClass'] !== undefined) {
    if (!isWorkClass(b['workClass']))
      return `workClass를 모르겠어요: ${oneLine(String(b['workClass']))}`;
    out.workClass = b['workClass'];
  }
  // 부모 워크트리는 이 머신의 경로라 바깥에서 정하게 두지 않는다. 컨덕터 세션이 order add로 넣는다
  if (b['parentWorktree'] !== undefined)
    return 'parentWorktree는 큐로 못 받아요. 컨덕터 세션에서 order add --parent-worktree로 넣어 주세요';
  if (b['baseBranch'] !== undefined) {
    if (typeof b['baseBranch'] !== 'string' || !isRefName(b['baseBranch']))
      return `baseBranch가 브랜치 이름 꼴이 아니에요: ${oneLine(String(b['baseBranch']))}`;
    out.baseBranch = b['baseBranch'];
  }
  if (b['jiraStatus'] !== undefined) {
    if (typeof b['jiraStatus'] !== 'string' || !isJiraStatus(b['jiraStatus']))
      return `jiraStatus를 모르겠어요: ${oneLine(String(b['jiraStatus']))}`;
    out.explicitJiraStatus = b['jiraStatus'];
  }
  if (Array.isArray(b['skillChain']) && b['skillChain'].every((x) => typeof x === 'string')) {
    // 모르는 이름은 접수에서 걸러진다. 여기서는 꼴만 본다
    out.skillChain = b['skillChain'] as string[];
  }
  return out;
}

/** 같은 출처로 이미 물었으면 다시 묻지 않는다. 사람이 거절한 것도, 보관하며 색인으로 옮긴 것도 다시 안 묻는다 */
function askOnce(store: ConductorStore, sourceRef: string, reason: string): void {
  if (store.askedSourceRef(sourceRef)) return;
  openOrReuse(store, { type: 'no-procedure', reason, payload: { sourceRef } });
}
