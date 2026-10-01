import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { log } from './log.js';

/**
 * JSON 파일을 통째로 바꿔 쓴다.
 *
 * 같은 디렉토리에 다 쓴 뒤 `rename`으로 갈아 끼운다. `writeFileSync`는 자르고 나서 쓰기
 * 때문에 그 사이에 읽는 쪽이 반쯤 쓰인 JSON을 본다. `rename`은 같은 파일시스템 안에서
 * 원자적이라 읽는 쪽은 항상 이전 내용이나 새 내용 중 하나를 온전히 본다.
 *
 * 임시 파일 이름에 pid와 uuid를 붙이는 건 프로세스 여럿이 같은 파일을 동시에 쓸 때
 * 서로의 임시 파일을 덮지 않게 하려는 것이다.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 이미 없으면 됐다
    }
    throw e;
  }
}

/**
 * JSON 파일을 읽는다. 없으면 `undefined`다.
 *
 * 파싱이 안 되거나 `isValid`를 통과 못 하면 그 파일을 `<path>.corrupt-<시각>`으로 옮기고
 * 경고를 남긴 뒤 `undefined`를 돌려준다. 예전에는 빈 값을 돌려주고 끝냈는데, 다음 쓰기가
 * 그 빈 값으로 파일을 덮어서 쌓인 기록이 흔적 없이 사라졌다. 옮겨두면 사람이 고쳐서
 * 되살릴 수 있다.
 *
 * 파싱 말고 읽기 자체가 실패한 경우(권한 등)는 그대로 던진다. 그건 파일이 깨진 게
 * 아니라서 옮기면 안 된다.
 */
export function readJsonOrQuarantine(
  path: string,
  isValid: (value: unknown) => boolean = () => true,
): unknown {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf-8');

  let parsed: unknown;
  let reason: string | null = null;
  try {
    parsed = JSON.parse(raw);
    if (!isValid(parsed)) reason = '모양이 예상과 달라요';
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }
  if (reason === null) return parsed;

  const backup = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    renameSync(path, backup);
  } catch (e) {
    // 다른 프로세스가 같은 파일을 방금 옮겼다. 내용은 그쪽 백업에 남아 있다
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`깨진 ${path}를 백업하지 못해서 손대지 않았어요`, { cause: e });
  }
  log(`${path}를 읽지 못해서 ${backup}로 옮겨뒀어요 (${reason}). 새 파일로 다시 시작해요`);
  return undefined;
}
