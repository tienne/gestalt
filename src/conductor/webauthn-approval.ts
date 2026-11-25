import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { isPlainObject } from '../core/json-file.js';
import { BOT_POLICY_FILE, loadBotPolicy } from './bot-approval.js';
import type { GateType } from './types.js';

/**
 * Touch ID 승인. 승인 페이지는 고정 localhost 포트에서만 띄우고 RP ID는 localhost다.
 * localhost는 브라우저가 보안 컨텍스트로 쳐서 HTTPS 없이 WebAuthn을 쓸 수 있다
 */
export const WEBAUTHN_RP_ID = 'localhost';
export const APPROVAL_PORT = 47219;
export const approvalOrigin = (port: number = APPROVAL_PORT) => `http://localhost:${port}`;

/** COSE ES256. Secure Enclave가 공식 지원하는 곡선은 P-256 하나라 이것만 받는다 */
export const ES256 = -7;

const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/);

export interface WebAuthnCredential {
  credentialId: string;
  /** P-256 SPKI PEM */
  publicKey: string;
  origin: string;
}

const credentialSchema = z
  .object({ credentialId: b64url, publicKey: z.string().min(1), origin: z.string().url() })
  .strict();

export const assertionSchema = z
  .object({
    credentialId: b64url,
    clientDataJSON: b64url,
    authenticatorData: b64url,
    signature: b64url,
  })
  .strict();
export type WebAuthnAssertion = z.infer<typeof assertionSchema>;

export const registrationSchema = z
  .object({
    credentialId: b64url,
    clientDataJSON: b64url,
    publicKey: b64url,
    algorithm: z.number().int(),
  })
  .strict();
export type WebAuthnRegistration = z.infer<typeof registrationSchema>;

const fromB64url = (value: string) => Buffer.from(value, 'base64url');
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest();

const field = (type: GateType) => (type === 'merge' ? 'mergeApprovers' : 'gateApprovers');

/** 정책의 승인자 값이 `{ webauthn: {...} }`면 Touch ID 승인자다. PEM 문자열이면 기존 Ed25519 승인자다 */
function asCredential(value: unknown): WebAuthnCredential | undefined {
  if (!isPlainObject(value)) return undefined;
  const parsed = credentialSchema.safeParse(value['webauthn']);
  return parsed.success ? parsed.data : undefined;
}

/** 이 레포와 유형에 등록된 Touch ID 승인자 */
export function webAuthnApprovers(
  policy: Record<string, unknown> | undefined,
  type: GateType,
  repo: string,
): { id: string; credential: WebAuthnCredential }[] {
  const table = policy?.[field(type)];
  const key = repo.toLowerCase();
  if (!isPlainObject(table) || !Object.hasOwn(table, key)) return [];
  const row = table[key];
  if (!isPlainObject(row)) return [];
  return Object.entries(row).flatMap(([id, value]) => {
    const credential = asCredential(value);
    return credential ? [{ id, credential }] : [];
  });
}

/** 서명 대상 문자열을 그대로 challenge로 쓰지 않고 해시한다. 길이가 일정하고 브라우저 제한에 안 걸린다 */
export function webAuthnChallenge(message: string): string {
  return sha256(message).toString('base64url');
}

function p256Key(pem: string): KeyObject {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new Error('Touch ID 승인자의 공개키가 P-256이 아니에요');
  return key;
}

function readClientData(encoded: string) {
  let value: unknown;
  try {
    value = JSON.parse(fromB64url(encoded).toString('utf8'));
  } catch {
    throw new Error('WebAuthn 응답의 clientDataJSON을 읽지 못했어요');
  }
  if (!isPlainObject(value)) throw new Error('WebAuthn 응답의 clientDataJSON을 읽지 못했어요');
  return value;
}

/**
 * 게이트 서명 문자열(`gateApprovalMessage`)에 한 Touch ID 서명을 확인한다. challenge가 문자열의 해시라
 * 다른 게이트, 다른 결정, 바뀐 게이트 내용이나 HEAD에는 같은 서명을 쓸 수 없다
 */
export function verifyWebAuthnAssertion(
  credential: WebAuthnCredential,
  message: string,
  raw: unknown,
): { signCount: number } {
  const parsed = assertionSchema.safeParse(raw);
  if (!parsed.success) throw new Error('WebAuthn 응답 형식을 확인하지 못했어요');
  const assertion = parsed.data;
  if (assertion.credentialId !== credential.credentialId)
    throw new Error('등록된 Touch ID 키가 아니에요');
  const client = readClientData(assertion.clientDataJSON);
  if (client['type'] !== 'webauthn.get') throw new Error('WebAuthn 응답 유형이 승인이 아니에요');
  if (client['origin'] !== credential.origin)
    throw new Error('승인 페이지 주소가 등록할 때와 달라요');
  if (client['crossOrigin'] === true) throw new Error('다른 사이트 안에서 연 승인은 받지 않아요');
  if (client['challenge'] !== webAuthnChallenge(message))
    throw new Error(
      '게이트 내용이나 PR HEAD가 바뀌었어요. 승인 페이지를 새로 열어 다시 승인해 주세요',
    );
  const auth = fromB64url(assertion.authenticatorData);
  if (auth.length < 37) throw new Error('WebAuthn 인증 데이터가 짧아요');
  if (!auth.subarray(0, 32).equals(sha256(WEBAUTHN_RP_ID)))
    throw new Error('WebAuthn RP ID가 localhost가 아니에요');
  const flags = auth[32]!;
  // 0x01 사용자 확인(UP), 0x04 생체나 암호 확인(UV). Touch ID로 본인 확인까지 한 서명만 받는다
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0)
    throw new Error('Touch ID 본인 확인을 거치지 않은 서명이에요');
  const signed = Buffer.concat([auth, sha256(fromB64url(assertion.clientDataJSON))]);
  if (!verify('sha256', signed, p256Key(credential.publicKey), fromB64url(assertion.signature)))
    throw new Error('게이트와 결정에 대한 Touch ID 서명을 확인하지 못했어요');
  return { signCount: auth.readUInt32BE(33) };
}

/** 등록 응답을 확인하고 정책에 넣을 자격 정보를 만든다. 공개키는 브라우저의 getPublicKey()가 준 SPKI다 */
export function verifyWebAuthnRegistration(
  raw: unknown,
  challenge: string,
  origin: string,
): WebAuthnCredential {
  const parsed = registrationSchema.safeParse(raw);
  if (!parsed.success) throw new Error('WebAuthn 등록 응답 형식을 확인하지 못했어요');
  const reg = parsed.data;
  if (reg.algorithm !== ES256) throw new Error('ES256(P-256) 키만 등록할 수 있어요');
  const client = readClientData(reg.clientDataJSON);
  if (client['type'] !== 'webauthn.create') throw new Error('WebAuthn 응답 유형이 등록이 아니에요');
  if (client['origin'] !== origin) throw new Error('등록 페이지 주소가 달라요');
  if (client['challenge'] !== challenge)
    throw new Error('등록 요청이 바뀌었어요. 다시 시도해 주세요');
  const key = p256Key(
    createPublicKey({ key: fromB64url(reg.publicKey), format: 'der', type: 'spki' })
      .export({ type: 'spki', format: 'pem' })
      .toString(),
  );
  return {
    credentialId: reg.credentialId,
    publicKey: key.export({ type: 'spki', format: 'pem' }).toString(),
    origin,
  };
}

/**
 * 승인자를 bot-policy.json에 넣는다. 다른 칸은 그대로 두고 임시 파일에 쓴 뒤 바꿔 끼워 반쯤 쓴 파일이 남지 않게 한다.
 * 개인키는 기기 밖으로 나오지 않아 여기 오는 건 공개키뿐이다
 */
export function addWebAuthnApprover(
  dir: string,
  type: 'merge' | 'gate',
  repo: string,
  id: string,
  credential: WebAuthnCredential,
  replace = false,
): void {
  const policy = loadBotPolicy(dir) ?? {};
  const name = type === 'merge' ? 'mergeApprovers' : 'gateApprovers';
  const table = isPlainObject(policy[name]) ? policy[name] : {};
  const key = repo.toLowerCase();
  const row = isPlainObject(table[key]) ? table[key] : {};
  if (Object.hasOwn(row, id) && !replace)
    throw new Error(`${repo}의 ${id} 승인자가 이미 있어요. 바꾸려면 --replace를 붙여 주세요`);
  const next = {
    ...policy,
    [name]: { ...table, [key]: { ...row, [id]: { webauthn: credential } } },
  };
  const path = join(dir, BOT_POLICY_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
