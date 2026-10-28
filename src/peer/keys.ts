import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 기기 키. Ed25519로 서명하고 X25519로 봉인을 연다. 이 기기를 가리키는 이름(`id`)은
 * Ed25519 공개키 32바이트를 base64url로 쓴 43자다.
 */
export interface MachineKey {
  id: string;
  /** X25519 공개키 32바이트 base64url */
  boxKey: string;
  signPrivate: KeyObject;
  boxPrivate: KeyObject;
}

interface KeyFile {
  v: 1;
  sign: JsonWebKey;
  box: JsonWebKey;
}

export function machineKeyPath(root: string): string {
  return join(root, 'machine.key');
}

/**
 * 키 파일을 읽고 없으면 만든다. 파일은 만드는 순간부터 0600이다 — 쓰고 나서 chmod하면
 * 그 사이에 기본 권한(umask)으로 열려 있다.
 *
 * 권한이 넓거나 심링크거나 남의 파일이면 읽지 않고 던진다. 고치는 건 사람 몫이다.
 */
export function loadOrCreateMachineKey(root: string): MachineKey {
  const path = machineKeyPath(root);
  try {
    return loadMachineKey(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const sign = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const box = generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
  const body: KeyFile = { v: 1, sign, box };
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    // 다른 데몬이 먼저 만들었다. 그쪽 키를 쓴다
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return loadMachineKey(path);
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(body) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return fromFile(body, path);
}

export function loadMachineKey(path: string): MachineKey {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`기기 키가 심링크예요: ${path}`);
  if (!st.isFile()) throw new Error(`기기 키 자리에 다른 파일이 있어요: ${path}`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid)
    throw new Error(`기기 키의 주인이 내가 아니에요: ${path}`);
  if ((st.mode & 0o077) !== 0) {
    throw new Error(
      `기기 키 권한이 넓어요(${(st.mode & 0o777).toString(8)}). chmod 600 ${path} 뒤에 다시 띄워 주세요`,
    );
  }
  let body: KeyFile;
  try {
    body = JSON.parse(readFileSync(path, 'utf8')) as KeyFile;
  } catch {
    throw new Error(`기기 키 파일을 못 읽었어요: ${path}`);
  }
  return fromFile(body, path);
}

function fromFile(body: KeyFile, path: string): MachineKey {
  if (body.v !== 1 || body.sign?.crv !== 'Ed25519' || body.box?.crv !== 'X25519') {
    throw new Error(`기기 키 형식이 아니에요: ${path}`);
  }
  const signPrivate = createPrivateKey({ key: body.sign, format: 'jwk' });
  const boxPrivate = createPrivateKey({ key: body.box, format: 'jwk' });
  return {
    id: rawPublic(signPrivate),
    boxKey: rawPublic(boxPrivate),
    signPrivate,
    boxPrivate,
  };
}

function rawPublic(priv: KeyObject): string {
  const jwk = createPublicKey(priv).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('공개키를 못 꺼냈어요');
  return jwk.x;
}

const RAW_KEY = /^[A-Za-z0-9_-]{43}$/;

/** 32바이트 공개키를 base64url로 쓴 꼴인지 */
export function isRawKey(value: unknown): value is string {
  return typeof value === 'string' && RAW_KEY.test(value);
}

export function signPublicKey(id: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: id }, format: 'jwk' });
}

export function boxPublicKey(raw: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw }, format: 'jwk' });
}
