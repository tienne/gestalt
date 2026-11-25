import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPlainObject } from '../core/json-file.js';
import { GhAccounts } from './adapters.js';
import { execRunner, type CommandRunner } from './launcher.js';
import { normalizePrRef, repoOfPrRef } from './pr-ref.js';
import type { ConductorStore } from './store.js';
import type { DecisionReceipt, Gate, GateType } from './types.js';

export const BOT_POLICY_FILE = 'bot-policy.json';

export function readBotPolicy(dir: string): Record<string, unknown> {
  const policy: unknown = JSON.parse(readFileSync(join(dir, BOT_POLICY_FILE), 'utf8'));
  if (!isPlainObject(policy)) throw new Error('봇 정책 파일이 JSON 객체여야 해요');
  return policy;
}

export function matchMergeGate(store: ConductorStore, id: string) {
  const gate = store.snapshot.gates[id];
  const order = gate?.orderId ? store.order(gate.orderId) : undefined;
  const ref = order?.prRef ? normalizePrRef(order.prRef) : undefined;
  if (
    !gate ||
    gate.type !== 'merge' ||
    !order ||
    !ref ||
    repoOfPrRef(ref)?.toLowerCase() !== order.repo.toLowerCase()
  )
    throw new Error('대상 레포의 PR이 연결된 머지 승인 게이트만 봇에서 처리할 수 있어요');
  const url = `https://github.com/${ref.replace('#', '/pull/')}`;
  return { gate, order, ref, url };
}

/** 봇 채팅에서 서명으로 닫을 수 있는 게이트. 머지 외에는 워커를 멈춰 세우는 확인 자리만 넣었다 */
export const BOT_GATE_TYPES: readonly GateType[] = [
  'merge',
  'file-overlap',
  'review-manual-switch',
];

export interface BotGate {
  gate: Gate;
  repo: string;
  title?: string;
  /** 머지 게이트만 있다 */
  ref?: string;
  url?: string;
}

export function matchBotGate(store: ConductorStore, id: string): BotGate {
  const gate = store.snapshot.gates[id];
  if (!gate || !BOT_GATE_TYPES.includes(gate.type))
    throw new Error('봇에서는 머지 승인, 파일 중첩, 리뷰 수동 전환 게이트만 처리할 수 있어요');
  if (gate.type === 'merge') {
    const { order, ref, url } = matchMergeGate(store, id);
    return { gate, repo: order.repo, title: order.title, ref, url };
  }
  const order = gate.orderId ? store.order(gate.orderId) : undefined;
  const prRef = gate.payload?.['prRef'];
  const repo = order?.repo ?? (prRef ? repoOfPrRef(prRef) : null);
  if (!repo) throw new Error('레포를 알 수 없는 게이트는 봇에서 처리할 수 없어요');
  const ref =
    gate.type === 'review-manual-switch' ? normalizePrRef(prRef ?? order?.prRef ?? '') : undefined;
  if (ref && repoOfPrRef(ref)?.toLowerCase() !== repo.toLowerCase())
    throw new Error('승인 대상 레포의 PR인지 확인해 주세요');
  return {
    gate,
    repo,
    ...(order ? { title: order.title } : {}),
    ...(ref ? { ref, url: `https://github.com/${ref.replace('#', '/pull/')}` } : {}),
  };
}

export function decisionTarget(store: ConductorStore, target: BotGate): string {
  const { gate, repo } = target;
  const order = gate.orderId ? store.order(gate.orderId) : undefined;
  const worker = order?.workerId ? store.worker(order.workerId) : undefined;
  return createHash('sha256')
    .update(
      JSON.stringify([
        gate.id,
        gate.openedAt,
        gate.type,
        gate.orderId,
        gate.reason,
        gate.refs,
        Object.entries(gate.payload ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        repo.toLowerCase(),
        order?.scope,
        order?.prRef ? normalizePrRef(order.prRef)?.toLowerCase() : undefined,
        worker?.id,
        worker?.kind,
        worker?.handle,
      ]),
    )
    .digest('hex');
}

export function decisionId(signer: string, signature: string): string {
  return createHash('sha256')
    .update(signer)
    .update('\0')
    .update(Buffer.from(signature, 'base64'))
    .digest('hex');
}

export function decisionReceipt(
  store: ConductorStore,
  target: BotGate,
  id: string,
  evidence?: { head: string; base?: string },
): DecisionReceipt {
  const rawRef = target.ref ?? target.gate.payload?.prRef;
  const prRef = rawRef ? normalizePrRef(rawRef) : undefined;
  const workerId = target.gate.orderId ? store.order(target.gate.orderId)?.workerId : undefined;
  return {
    id,
    deliveryId: randomUUID(),
    target: decisionTarget(store, target),
    repo: target.repo,
    ...(workerId ? { workerId } : {}),
    ...(prRef ? { prRef } : {}),
    ...(evidence ? { head: evidence.head } : {}),
    ...(evidence?.base ? { base: evidence.base } : {}),
  };
}

export type ReadApprovalEvidence = (ref: string) => Promise<{
  head: string;
  base?: string;
  state: string;
  draft: boolean;
}>;

export interface ReviewApprovalScope {
  ref: string;
  head: string;
  base: string;
}

export function reviewApprovalScope(
  ref: string | undefined,
  head: string | undefined,
  base: string | undefined,
): ReviewApprovalScope {
  if (!ref || !head || !base)
    throw new Error('재리뷰 게이트는 PR, HEAD와 base 브랜치가 있어야 서명을 확인할 수 있어요');
  return { ref, head, base };
}

export async function changedApprovalTarget(
  store: ConductorStore,
  gate: Gate,
  readEvidence?: ReadApprovalEvidence,
): Promise<{ reason: string; reviewScope?: ReviewApprovalScope } | undefined> {
  const receipt = gate.receipt;
  if (!receipt) return;
  let target: BotGate;
  try {
    target = matchBotGate(store, gate.id);
  } catch {
    return { reason: '승인 대상 레포 또는 PR 연결이 바뀌었어요' };
  }
  const order = gate.orderId ? store.order(gate.orderId) : undefined;
  const ref = target.ref;
  const review = gate.type === 'review-manual-switch';
  const scopeChanged = decisionTarget(store, target) !== receipt.target;
  const scopeReason = '승인 범위, PR 또는 담당 워커가 바뀌었어요';
  if (scopeChanged && !(review && !gate.orderId && ref)) return { reason: scopeReason };
  if (
    order &&
    store
      .openGates(order.id)
      .some(
        (g) =>
          g.type === gate.type &&
          (gate.type !== 'file-overlap' || g.payload?.overlapWith === gate.payload?.overlapWith),
      )
  )
    return { reason: '같은 유형의 새 게이트가 열렸어요' };

  const head = receipt.head;
  if (!ref || (!head && !review)) return;
  if (!readEvidence) throw new Error('GitHub에서 승인 대상을 다시 읽을 수 없어요');
  const current = await readEvidence(ref);
  const reviewScope = review ? reviewApprovalScope(ref, current.head, current.base) : undefined;
  const change = (reason: string) => ({ reason, ...(reviewScope ? { reviewScope } : {}) });
  if (scopeChanged) return change(scopeReason);
  if (review && (!receipt.head || !receipt.base))
    return change('재리뷰 승인 당시의 HEAD 또는 base 브랜치 기록이 없어 새 결정이 필요해요');
  if (current.head !== head) return change('승인 대상 PR HEAD가 바뀌었어요');
  if (receipt.base && current.base !== receipt.base)
    return change('승인 대상 PR의 base 브랜치가 바뀌었어요');
  if (
    gate.type === 'merge' &&
    gate.decision === 'approved' &&
    (current.state !== 'OPEN' || current.draft)
  )
    return change('승인 대상 PR 상태가 바뀌었어요');
}

export async function readMergeEvidence(
  ref: string,
  accounts: GhAccounts,
  run: CommandRunner = execRunner,
) {
  const [repo, number] = ref.split('#') as [string, string];
  const env = await accounts.envFor(repo);
  const result = await run(
    'gh',
    [
      'pr',
      'view',
      number,
      '--repo',
      repo,
      '--json',
      'headRefOid,baseRefName,state,isDraft,statusCheckRollup',
    ],
    { ...(env ? { env } : {}), timeoutMs: 15_000 },
  );
  if (result.code !== 0) throw new Error('GitHub에서 검증 결과를 읽지 못했어요');
  const value: unknown = JSON.parse(result.stdout);
  if (
    !isPlainObject(value) ||
    typeof value['headRefOid'] !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value['headRefOid']) ||
    typeof value['baseRefName'] !== 'string' ||
    value['baseRefName'].length === 0 ||
    typeof value['state'] !== 'string' ||
    typeof value['isDraft'] !== 'boolean' ||
    !Array.isArray(value['statusCheckRollup'])
  )
    throw new Error('GitHub의 PR 검증 결과를 읽을 수 없어요');
  const checks = value['statusCheckRollup'].flatMap((row: unknown) => {
    if (!isPlainObject(row)) return [];
    const name = row['name'] ?? row['context'];
    const result = row['conclusion'] || row['status'] || row['state'];
    return typeof name === 'string' && typeof result === 'string' ? [{ name, result }] : [];
  });
  return {
    head: value['headRefOid'],
    base: value['baseRefName'],
    state: value['state'],
    draft: value['isDraft'],
    checks,
  };
}

type Decision = 'approved' | 'rejected';

const gateDetails = (gate: Gate) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        gate.reason,
        gate.refs,
        ...(gate.type === 'file-overlap' && gate.payload?.overlapDigest
          ? [gate.payload.overlapDigest]
          : []),
      ]),
    )
    .digest('hex');

export function approvalMessage(gate: Gate, ref: string, head: string, decision: Decision): string {
  return JSON.stringify([
    'gestalt/merge-approval/v1',
    gate.id,
    gate.openedAt,
    ref,
    head,
    decision,
    gateDetails(gate),
  ]);
}

/** 머지는 기존 서명 문자열을 그대로 쓴다. 다른 게이트는 유형과 레포를 넣어 다른 게이트 서명을 못 옮겨 쓰게 한다 */
export function gateApprovalMessage(
  target: BotGate,
  head: string | undefined,
  decision: Decision,
  base?: string,
): string {
  const { gate, repo, ref } = target;
  if (gate.type === 'merge') {
    if (!ref || !head) throw new Error('머지 게이트는 PR과 HEAD가 있어야 서명을 확인할 수 있어요');
    return approvalMessage(gate, ref, head, decision);
  }
  if (gate.type === 'review-manual-switch') {
    const scope = reviewApprovalScope(ref, head, base);
    return JSON.stringify([
      'gestalt/review-approval/v1',
      gate.id,
      gate.openedAt,
      repo.toLowerCase(),
      scope.ref,
      scope.head,
      scope.base,
      decision,
      gateDetails(gate),
    ]);
  }
  return JSON.stringify([
    'gestalt/gate-approval/v1',
    gate.id,
    gate.type,
    gate.openedAt,
    repo.toLowerCase(),
    decision,
    gateDetails(gate),
  ]);
}

export function verifyMergeApproval(
  policy: Record<string, unknown>,
  repo: string,
  signer: string,
  message: string,
  signature: string,
): void {
  verifyGateApproval(policy, 'merge', repo, signer, message, signature);
}

/** 머지 승인자는 mergeApprovers, 나머지 게이트 승인자는 gateApprovers에서 레포별로 찾는다 */
export function verifyGateApproval(
  policy: Record<string, unknown>,
  type: GateType,
  repo: string,
  signer: string,
  message: string,
  signature: string,
): void {
  const key = requireGateApprover(policy, type, repo, signer);
  if (!verifyEd25519(key, message, signature))
    throw new Error('게이트와 결정에 대한 서명을 확인하지 못했어요');
}

/** 레포 승인자 ID를 확인하고 수동 서명 승인에 쓸 공개키를 반환한다 */
export function requireGateApprover(
  policy: Record<string, unknown>,
  type: GateType,
  repo: string,
  signer: string,
): KeyObject {
  const approvers = policy[type === 'merge' ? 'mergeApprovers' : 'gateApprovers'];
  const allowed =
    isPlainObject(approvers) && Object.hasOwn(approvers, repo.toLowerCase())
      ? approvers[repo.toLowerCase()]
      : undefined;
  const pem =
    isPlainObject(allowed) && Object.hasOwn(allowed, signer) ? allowed[signer] : undefined;
  if (typeof pem !== 'string')
    throw new Error(
      `이 레포의 ${type === 'merge' ? '머지' : '게이트'} 승인 권한이 없는 서명자예요`,
    );
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519')
    throw new Error('게이트와 결정에 대한 서명을 확인하지 못했어요');
  return key;
}

export function verifyEd25519(key: KeyObject, message: string, signature: string): boolean {
  return (
    key.asymmetricKeyType === 'ed25519' &&
    /^[A-Za-z0-9+/]{86}==$/.test(signature) &&
    verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64'))
  );
}
