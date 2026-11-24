import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { isPlainObject } from '../core/json-file.js';
import { gestaltPath } from '../core/home.js';

type LocalDestination = { kind: 'local' };
type ConductorDestination = { kind: 'conductor'; stateDir: string; orderId: string };
type Destination = LocalDestination | ConductorDestination;

function destinationPath(planId: string): string {
  const key = createHash('sha256').update(planId).digest('hex');
  return gestaltPath('plan-destinations', key);
}

export function readPlanDestination(planId: string): Destination | undefined {
  let text: string;
  try {
    text = readFileSync(destinationPath(planId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const decoded: unknown = JSON.parse(text);
  if (isPlainObject(decoded)) {
    if (decoded['kind'] === 'local') return { kind: 'local' };
    const stateDir = decoded['stateDir'];
    const orderId = decoded['orderId'];
    if (
      decoded['kind'] === 'conductor' &&
      typeof stateDir === 'string' &&
      isAbsolute(stateDir) &&
      typeof orderId === 'string' &&
      /^ord-[\da-z]+$/i.test(orderId)
    )
      return { kind: 'conductor', stateDir, orderId };
  }
  throw new Error('계획의 실행 목적지 기록을 읽지 못했어요');
}

export function claimPlanDestination(planId: string, requested: LocalDestination): LocalDestination;
export function claimPlanDestination(
  planId: string,
  requested: ConductorDestination,
): ConductorDestination;
export function claimPlanDestination(planId: string, requested: Destination): Destination {
  let winner = readPlanDestination(planId);
  if (!winner) {
    const path = destinationPath(planId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(requested), { flag: 'wx', mode: 0o600 });
      // 목적지가 공개된 뒤에만 실행 또는 주문을 기록한다. 재시도에서는 같은 주문 ID를 쓴다.
      linkSync(temp, path);
      winner = requested;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      winner = readPlanDestination(planId);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  if (
    !winner ||
    winner.kind !== requested.kind ||
    (winner.kind === 'conductor' &&
      requested.kind === 'conductor' &&
      winner.stateDir !== requested.stateDir)
  )
    throw new Error('이 계획은 이미 로컬 실행 또는 다른 컨덕터 접수에 사용됐어요');
  return winner;
}
