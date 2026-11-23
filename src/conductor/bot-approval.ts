import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPlainObject } from '../core/json-file.js';
import { GhAccounts } from './adapters.js';
import { execRunner, type CommandRunner } from './launcher.js';
import { normalizePrRef, repoOfPrRef } from './pr-ref.js';
import type { ConductorStore } from './store.js';
import type { Gate } from './types.js';

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

export function approvalMessage(gate: Gate, ref: string, head: string, decision: Decision): string {
  const details = createHash('sha256')
    .update(JSON.stringify([gate.reason, gate.refs]))
    .digest('hex');
  return JSON.stringify([
    'gestalt/merge-approval/v1',
    gate.id,
    gate.openedAt,
    ref,
    head,
    decision,
    details,
  ]);
}

export function verifyMergeApproval(
  policy: Record<string, unknown>,
  repo: string,
  signer: string,
  message: string,
  signature: string,
): void {
  const approvers = policy['mergeApprovers'];
  const allowed =
    isPlainObject(approvers) && Object.hasOwn(approvers, repo.toLowerCase())
      ? approvers[repo.toLowerCase()]
      : undefined;
  const pem =
    isPlainObject(allowed) && Object.hasOwn(allowed, signer) ? allowed[signer] : undefined;
  if (typeof pem !== 'string') throw new Error('이 레포의 머지 승인 권한이 없는 서명자예요');
  const key = createPublicKey(pem);
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !/^[A-Za-z0-9+/]{86}==$/.test(signature) ||
    !verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64'))
  )
    throw new Error('게이트와 결정에 대한 서명을 확인하지 못했어요');
}
