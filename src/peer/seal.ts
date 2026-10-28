import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { boxPublicKey, isRawKey, signPublicKey } from './keys.js';
import type { MachineKey } from './keys.js';

/**
 * 봉인과 서명. 전부 `node:crypto`다.
 *
 * - box: 받는 기기의 X25519 공개키로 봉인하고 보낸 기기의 Ed25519 키로 서명한다.
 *   보낼 때마다 임시 X25519 키를 만들어서 같은 두 기기 사이에도 키가 매번 다르다.
 * - aead: 공유 세션 키 하나로 여는 AES-256-GCM. 공유 스트림 프레임에 쓴다.
 */

/** 키를 정렬한 JSON. 서명할 바이트를 두 쪽이 똑같이 만들려고 쓴다 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

export function signText(key: MachineKey, text: string): string {
  return sign(null, Buffer.from(text, 'utf8'), key.signPrivate).toString('base64url');
}

/** 서명이 맞는지. 키나 서명 꼴이 틀려도 던지지 않고 false */
export function verifyText(signer: string, text: string, sig: unknown): boolean {
  if (!isRawKey(signer) || typeof sig !== 'string') return false;
  try {
    return verify(
      null,
      Buffer.from(text, 'utf8'),
      signPublicKey(signer),
      Buffer.from(sig, 'base64url'),
    );
  } catch {
    return false;
  }
}

export function deriveKey(ikm: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), 32));
}

export function hmac(key: Buffer, text: string): string {
  return createHmac('sha256', key).update(text, 'utf8').digest('base64url');
}

export function safeEqual(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** nonce 12바이트 + 암호문 + 태그 16바이트를 base64url 한 줄로 */
export function aeadSeal(key: Buffer, plaintext: Buffer, aad: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url');
}

/** 열지 못하면 null. 키가 틀렸거나 누가 바꿨거나 aad가 다르다 */
export function aeadOpen(key: Buffer, sealed: unknown, aad: string): Buffer | null {
  if (typeof sealed !== 'string') return null;
  const raw = Buffer.from(sealed, 'base64url');
  if (raw.length < 28) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
  } catch {
    return null;
  }
}

export interface Box {
  k: 'box';
  /** 임시 X25519 공개키 */
  e: string;
  /** aeadSeal 결과 */
  c: string;
  /** 보낸 기기의 서명 */
  s: string;
}

const BOX_INFO = 'gestalt-peer-box-v1';

/**
 * `to`(받는 기기 id)와 `toBox`(그 기기의 X25519 공개키)에게 봉인한다. 서명에 받는 기기
 * id를 넣어서 다른 기기에게 간 봉인을 그대로 옮겨 보내도 서명이 안 맞는다.
 */
export function sealBox(from: MachineKey, to: string, toBox: string, plaintext: string): Box {
  const eph = generateKeyPairSync('x25519');
  const e = eph.publicKey.export({ format: 'jwk' }).x!;
  const key = boxKey(eph.privateKey, boxPublicKey(toBox), e, toBox);
  const c = aeadSeal(key, Buffer.from(plaintext, 'utf8'), `${BOX_INFO}|${from.id}|${to}`);
  return { k: 'box', e, c, s: signText(from, boxSigned(from.id, to, e, c)) };
}

/** 보낸 기기 서명이 맞고 열리면 평문. 아니면 null */
export function openBox(me: MachineKey, from: string, box: unknown): string | null {
  if (!isBox(box)) return null;
  if (!verifyText(from, boxSigned(from, me.id, box.e, box.c), box.s)) return null;
  let key: Buffer;
  try {
    key = boxKey(me.boxPrivate, boxPublicKey(box.e), box.e, me.boxKey);
  } catch {
    return null;
  }
  const plain = aeadOpen(key, box.c, `${BOX_INFO}|${from}|${me.id}`);
  return plain ? plain.toString('utf8') : null;
}

function boxSigned(from: string, to: string, e: string, c: string): string {
  return `${BOX_INFO}\n${from}\n${to}\n${e}\n${c}`;
}

function boxKey(priv: KeyObject, pub: KeyObject, ephRaw: string, recipientRaw: string): Buffer {
  const shared = diffieHellman({ privateKey: priv, publicKey: pub });
  return deriveKey(shared, Buffer.from(ephRaw + recipientRaw, 'utf8'), BOX_INFO);
}

function isBox(v: unknown): v is Box {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Partial<Box>;
  return b.k === 'box' && isRawKey(b.e) && typeof b.c === 'string' && typeof b.s === 'string';
}
