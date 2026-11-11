import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  type Stats,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

export function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** 링크가 가리키는 절대 경로. 상대 링크는 링크가 있는 폴더 기준으로 푼다 */
export function linkTargetOf(path: string): string {
  return resolve(dirname(path), readlinkSync(path));
}

export function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** 같은 자리를 가리키는지. macOS의 /var와 /private/var처럼 이름만 다른 경우도 같다고 본다 */
export function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b) || realOrSelf(a) === realOrSelf(b);
}

/** 옮길 자리가 다른 볼륨이면 rename이 EXDEV로 실패하니 복사하고 원래 것을 지운다 */
export function movePath(from: string, to: string): void {
  if (lstatOrNull(to)) throw new Error(`옮길 자리에 이미 뭔가 있어요: ${to}`);
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** 파일이나 링크, 폴더를 그대로 복사한다. 링크는 링크로 남긴다 */
export function copyPath(from: string, to: string): void {
  if (lstatOrNull(to)) throw new Error(`복사할 자리에 이미 뭔가 있어요: ${to}`);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
}

export function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function isEmptyDir(path: string): boolean {
  if (!lstatOrNull(path)?.isDirectory()) return false;
  return readdirSync(path).length === 0;
}
