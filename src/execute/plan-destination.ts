import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gestaltPath } from '../core/home.js';

type Destination = { kind: 'local' } | { kind: 'conductor'; stateDir: string };

export function claimPlanDestination(planId: string, destination: Destination): void {
  const directory = gestaltPath('prepared-plans', 'destinations');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(planId).digest('hex');
  const path = join(directory, key);
  const temp = `${path}.${randomUUID()}.tmp`;
  const choice = JSON.stringify(destination);
  try {
    writeFileSync(temp, choice, { flag: 'wx', mode: 0o600 });
    // 두 프로세스가 다른 저장소에 쓰기 전에, 복구해도 바뀌지 않는 목적지를 먼저 정한다.
    linkSync(temp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (readFileSync(path, 'utf8') !== choice)
      throw new Error('이 계획은 이미 로컬 실행 또는 다른 컨덕터 접수에 사용됐어요', {
        cause: error,
      });
  } finally {
    rmSync(temp, { force: true });
  }
}
