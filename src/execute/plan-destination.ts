import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { gestaltPath } from '../core/home.js';
import { writeJsonAtomic } from '../core/json-file.js';
import { real } from '../conductor/parent-worktree.js';
import { preparedPlanSourceRef } from '../conductor/prepared-plan.js';
import { resolveStateDir } from '../conductor/state-dir.js';
import { replayStore, takenSourceRefs } from '../conductor/store.js';

type Destination = { kind: 'local' } | { kind: 'conductor'; stateDir: string };

function key(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function planStores(planId: string): string {
  return gestaltPath('prepared-plans', 'stores', key(planId));
}

export function rememberPlanStore(planId: string, stateDir: string): void {
  const directory = real(stateDir);
  writeJsonAtomic(join(planStores(planId), key(directory)), directory, { mode: 0o600 });
}

function recordedOrderDestination(planId: string): Destination | undefined {
  const registered = planStores(planId);
  const stores = new Set([real(resolveStateDir(undefined, loadConfig().conductor))]);
  if (existsSync(registered)) {
    for (const file of readdirSync(registered).filter((name) => /^[a-f0-9]{64}$/.test(name))) {
      const path: unknown = JSON.parse(readFileSync(join(registered, file), 'utf8'));
      if (typeof path !== 'string' || !isAbsolute(path))
        throw new Error('계획의 컨덕터 저장소 기록을 읽지 못했어요');
      stores.add(real(path));
    }
  }
  const sourceRef = preparedPlanSourceRef(planId);
  const accepted = [...stores].filter((dir) => takenSourceRefs(replayStore(dir)).has(sourceRef));
  if (accepted.length > 1) throw new Error('이 계획이 여러 컨덕터 저장소에 기록돼 있어요');
  return accepted[0] ? { kind: 'conductor', stateDir: accepted[0] } : undefined;
}

export function claimPlanDestination(planId: string, destination: Destination): void {
  const directory = gestaltPath('prepared-plans', 'destinations');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, key(planId));
  const requested = JSON.stringify(destination);

  if (!existsSync(path)) {
    // 복구 때는 이미 기록된 주문을 우선한다. 새 주문은 이 목적지를 기록한 뒤 접수된다.
    const choice = JSON.stringify(recordedOrderDestination(planId) ?? destination);
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, choice, { flag: 'wx', mode: 0o600 });
      linkSync(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      rmSync(temp, { force: true });
    }
  }

  if (readFileSync(path, 'utf8') !== requested)
    throw new Error('이 계획은 이미 로컬 실행 또는 다른 컨덕터 접수에 사용됐어요');
}
