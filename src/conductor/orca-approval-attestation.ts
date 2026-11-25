import { createHash, createPublicKey } from 'node:crypto';
import { z } from 'zod';
import { requireGateApprover, verifyEd25519, type BotGate } from './bot-approval.js';
import type { BotOwner } from './bot-owner.js';
import type { OrcaItemSource } from './types.js';

export const ORCA_APPROVAL_UNAVAILABLE =
  'Orca 공식 승인 증빙을 확인할 수 없어요. 레포별 승인 권한이 있는 운영자의 서명을 받아 주세요';

const VERSION = 'gestalt/orca-approval/v1';
const id = z.string().min(1);
const attestation = z
  .object({
    version: z.literal(VERSION),
    issuer: id,
    botId: id,
    chatId: id,
    item: z.number().int().positive().safe(),
    itemUid: id,
    question: id,
    answer: id,
    decision: z.enum(['approved', 'rejected']),
    targetHash: z.string().regex(/^[a-f0-9]{64}$/),
    approver: id,
    authorized: z.boolean(),
    issuedAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().positive().safe(),
    signature: z
      .string()
      .regex(/^[A-Za-z0-9+/]{86}==$/)
      .refine((value) => Buffer.from(value, 'base64').toString('base64') === value),
  })
  .strict();

export type OrcaApprovalAttestation = z.infer<typeof attestation>;

/** Orca 코어의 지원을 확인한 어댑터가 공식 조회와 신뢰 키를 제공한다 */
export interface OrcaApprovalIssuer {
  id: string;
  publicKey: string;
  read(source: OrcaItemSource): Promise<unknown>;
}

export async function officialOrcaApprovalIssuer(
  _owner: BotOwner,
): Promise<OrcaApprovalIssuer | undefined> {
  // Orca 1.4.269에는 공식 발행자와 공개키를 확인할 인터페이스가 없다.
  return undefined;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function orcaApprovalTargetHash(
  receiptTarget: string,
  evidence?: { head: string; base?: string },
): string {
  return sha256(JSON.stringify([VERSION, receiptTarget, evidence?.head, evidence?.base]));
}

function eventAddress(
  source: Pick<OrcaItemSource, 'botId' | 'chatId' | 'item' | 'itemUid' | 'question' | 'answer'>,
) {
  return [source.botId, source.chatId, source.item, source.itemUid, source.question, source.answer];
}

export function orcaApprovalMessage(proof: Omit<OrcaApprovalAttestation, 'signature'>): string {
  return JSON.stringify([
    proof.version,
    proof.issuer,
    ...eventAddress(proof),
    proof.decision,
    proof.targetHash,
    proof.approver,
    proof.authorized,
    proof.issuedAt,
    proof.expiresAt,
  ]);
}

export function verifyOrcaApproval(
  issuer: OrcaApprovalIssuer,
  raw: unknown,
  expected: {
    source: OrcaItemSource;
    decision: OrcaApprovalAttestation['decision'];
    target: BotGate;
    targetHash: string;
  },
  policy: Record<string, unknown>,
) {
  const parsed = attestation.safeParse(raw);
  if (!parsed.success) throw new Error('Orca 승인 증빙 형식을 확인하지 못했어요');
  const proof = parsed.data;
  if (proof.issuer !== issuer.id) throw new Error('Orca 승인 증빙 발행자가 달라요');
  if (
    !verifyEd25519(createPublicKey(issuer.publicKey), orcaApprovalMessage(proof), proof.signature)
  )
    throw new Error('Orca 승인 증빙 서명을 확인하지 못했어요');
  const { source, decision, target, targetHash } = expected;
  if (JSON.stringify(eventAddress(proof)) !== JSON.stringify(eventAddress(source)))
    throw new Error('Orca 승인 증빙의 봇, 채팅, 항목 또는 이벤트가 달라요');
  if (proof.decision !== decision) throw new Error('Orca 승인 증빙의 결정이 달라요');
  if (proof.targetHash !== targetHash) throw new Error('Orca 승인 증빙의 게이트 대상이 달라요');
  const now = Date.now();
  if (proof.issuedAt > now || proof.expiresAt <= now)
    throw new Error('Orca 승인 증빙의 유효기간을 벗어났어요');
  if (!proof.authorized) throw new Error('Orca가 확인한 승인 권한이 없어요');
  requireGateApprover(policy, target.gate.type, target.repo, proof.approver);
  return {
    id: sha256(
      JSON.stringify([VERSION, proof.issuer, ...eventAddress(source), proof.decision, targetHash]),
    ),
    signer: proof.approver,
    expiresAt: proof.expiresAt,
    source: {
      ...source,
      attestation: { issuer: proof.issuer },
    },
  };
}
