import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPlainObject } from '../core/json-file.js';
import { GhAccounts } from './adapters.js';
import { execRunner, type CommandRunner } from './launcher.js';
import { normalizePrRef, repoOfPrRef } from './pr-ref.js';
import type { ConductorStore } from './store.js';
import type { Gate, GateType } from './types.js';

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
  return { gate, repo, ...(order ? { title: order.title } : {}) };
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
    ['pr', 'view', number, '--repo', repo, '--json', 'headRefOid,state,isDraft,statusCheckRollup'],
    { ...(env ? { env } : {}), timeoutMs: 15_000 },
  );
  if (result.code !== 0) throw new Error('GitHub에서 검증 결과를 읽지 못했어요');
  const value: unknown = JSON.parse(result.stdout);
  if (
    !isPlainObject(value) ||
    typeof value['headRefOid'] !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value['headRefOid']) ||
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
  return { head: value['headRefOid'], state: value['state'], draft: value['isDraft'], checks };
}

type Decision = 'approved' | 'rejected';

const gateDetails = (gate: Gate) =>
  createHash('sha256')
    .update(JSON.stringify([gate.reason, gate.refs]))
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
): string {
  const { gate, repo, ref } = target;
  if (gate.type === 'merge') {
    if (!ref || !head) throw new Error('머지 게이트는 PR과 HEAD가 있어야 서명을 확인할 수 있어요');
    return approvalMessage(gate, ref, head, decision);
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
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !/^[A-Za-z0-9+/]{86}==$/.test(signature) ||
    !verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64'))
  )
    throw new Error('게이트와 결정에 대한 서명을 확인하지 못했어요');
}
