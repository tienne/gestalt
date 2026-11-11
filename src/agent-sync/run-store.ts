import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import { z } from 'zod';
import { gestaltPath } from '../core/home.js';
import { copyPath, movePath, removePath } from './fs-ops.js';
import { isInside } from './paths.js';

export type RunKind = 'sync' | 'doctor' | 'revert';

const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/;

const stashAction = z.object({ op: z.literal('stash'), path: z.string(), backup: z.string() });
const moveAction = z.object({ op: z.literal('move'), from: z.string(), to: z.string() });
/** 되돌리기가 남기는 기록. 그 자리에 sync 뒤로 생긴 것을 치워둔 곳 */
const backupAction = z.object({ op: z.literal('backup'), path: z.string(), backup: z.string() });
const movingAction = z.discriminatedUnion('op', [stashAction, moveAction, backupAction]);

/**
 * 실행 하나가 한 일. 되돌리기는 sync 실행의 이 목록을 거꾸로 읽는다.
 * `backup`은 실행 폴더 안의 절대 경로다. `pending`은 옮기기 시작했지만 끝났다고 적기 전에 멈춘 동작이다.
 */
const runAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('mkdir'), path: z.string() }),
  z.object({ op: z.literal('create_file'), path: z.string() }),
  z.object({ op: z.literal('write_file'), path: z.string(), backup: z.string() }),
  z.object({ op: z.literal('create_link'), path: z.string(), target: z.string() }),
  moveAction,
  stashAction,
  backupAction,
  z.object({ op: z.literal('pending'), action: movingAction }),
  z.object({ op: z.literal('restore'), path: z.string() }),
  z.object({ op: z.literal('remove'), path: z.string() }),
]);

const runRecordSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().regex(/^[0-9a-f]{8}$/),
    kind: z.enum(['sync', 'doctor', 'revert']),
    createdAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), '날짜가 아니에요'),
    /** 실행 폴더 이름. `<YYYY-MM-DD>-<runId>` */
    dirName: z.string().regex(RUN_DIR_PATTERN),
    actions: z.array(runAction),
    /** 사람이 읽을 한 줄 요약. 출력에 보여준 것과 같다 */
    changes: z.array(z.string()),
    revertOf: z.string().optional(),
    revertedAt: z.string().optional(),
    revertedBy: z.string().optional(),
    /** 되돌리기가 어디까지 했는지. 이 인덱스부터 끝까지의 동작은 되돌렸다 */
    revertProgress: z.number().int().nonnegative().optional(),
  })
  .refine((r) => r.dirName.endsWith(`-${r.runId}`), {
    message: 'dirName이 runId로 끝나지 않아요',
    path: ['dirName'],
  });

export type RunAction = z.infer<typeof runAction>;
export type MovingAction = z.infer<typeof movingAction>;
export type RunRecord = z.infer<typeof runRecordSchema>;

export const RUN_FILE = 'run.json';
export const RETENTION_MONTHS = 6;

export function backupsRoot(): string {
  return gestaltPath('backups');
}

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 원래 경로 구조 그대로. 홈 아래는 `home/`, 그 밖은 `root/` 아래에 둔다 */
export function backupPathIn(dir: string, home: string, path: string): string {
  if (path !== home && isInside(home, path)) return join(dir, 'home', relative(home, path));
  return join(dir, 'root', path.replace(/^[/\\]+/, '').replace(/:/g, ''));
}

/**
 * 실행 폴더는 백업이 처음 들어오기 전에 0700으로 만든다. 옮기기가 부모 폴더를 먼저 만들면 umask 권한으로 생긴다.
 * 이미 있던 폴더는 사용자가 정한 권한일 수 있어 건드리지 않는다.
 */
function ensureRunDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** 임시 파일에 다 쓴 뒤 rename한다. 쓰다가 죽어도 run.json은 직전 내용 그대로 남는다 */
function writeRunFile(dir: string, record: RunRecord): void {
  const file = join(dir, RUN_FILE);
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * 실행 하나의 백업 폴더와 기록 파일. 폴더는 처음 쓸 일이 생길 때 만든다.
 * 바꾼 게 없는 실행은 흔적을 안 남긴다.
 */
export class RunWriter {
  readonly record: RunRecord;
  readonly dir: string;

  constructor(
    kind: RunKind,
    private readonly home: string,
    now: Date = new Date(),
    revertOf?: string,
  ) {
    const runId = randomBytes(4).toString('hex');
    const dirName = `${localDate(now)}-${runId}`;
    this.dir = join(backupsRoot(), dirName);
    this.record = {
      version: 1,
      runId,
      kind,
      createdAt: now.toISOString(),
      dirName,
      actions: [],
      changes: [],
      ...(revertOf ? { revertOf } : {}),
    };
  }

  get recordFile(): string {
    return join(this.dir, RUN_FILE);
  }

  get touched(): boolean {
    return this.record.actions.length > 0;
  }

  backupPathFor(path: string): string {
    return backupPathIn(this.dir, this.home, path);
  }

  /**
   * 옮기기 전에 `pending`으로 먼저 적고 옮긴 뒤 완료로 바꾼다.
   * 그 사이에 멈춰도 어디로 옮기려 했는지 기록에 남아 되돌리기가 찾아갈 수 있다.
   */
  recordMove(action: MovingAction, move: () => void): void {
    const at = this.record.actions.length;
    this.log({ op: 'pending', action });
    move();
    this.record.actions[at] = action;
    this.save();
  }

  /** 지금 자리에 있는 것을 백업 폴더로 옮긴다 */
  moveToBackup(op: 'stash' | 'backup', path: string): string {
    const backup = this.backupPathFor(path);
    this.recordMove({ op, path, backup }, () => movePath(path, backup));
    return backup;
  }

  copyToBackup(path: string): string {
    ensureRunDir(this.dir);
    const backup = this.backupPathFor(path);
    copyPath(path, backup);
    return backup;
  }

  log(action: RunAction): void {
    this.record.actions.push(action);
    this.save();
  }

  /**
   * 동작을 적을 때마다 저장한다. 프로세스가 죽어도 마지막으로 저장한 데까지는 run.json에 남는다.
   * 옮기는 동작은 옮기기 전에 적으므로 저장한 기록이 실제보다 뒤처지지 않는다.
   */
  save(): void {
    ensureRunDir(this.dir);
    writeRunFile(this.dir, this.record);
  }
}

export interface CorruptRun {
  dirName: string;
  reason: string;
}

export type StoredRun = { ok: true; record: RunRecord } | ({ ok: false } & CorruptRun);

/** 기록 파일이 없으면 null. 있는데 못 읽거나 형식이 틀리면 깨진 기록으로 돌려준다 */
export function readRun(dir: string): StoredRun | null {
  const file = join(dir, RUN_FILE);
  if (!existsSync(file)) return null;
  const dirName = basename(dir);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    return { ok: false, dirName, reason: `JSON으로 읽지 못했어요: ${(e as Error).message}` };
  }
  const parsed = runRecordSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, dirName, reason: `형식이 맞지 않아요: ${detail}` };
  }
  if (parsed.data.dirName !== dirName) {
    return {
      ok: false,
      dirName,
      reason: `기록의 dirName ${parsed.data.dirName}이 폴더 이름과 달라요`,
    };
  }
  return { ok: true, record: parsed.data };
}

export function writeRun(record: RunRecord): void {
  writeRunFile(runDir(record), record);
}

export interface RunListing {
  runs: RunRecord[];
  corrupt: CorruptRun[];
}

export function listRunsNewestFirst(): RunListing {
  const root = backupsRoot();
  const listing: RunListing = { runs: [], corrupt: [] };
  if (!existsSync(root)) return listing;
  for (const name of readdirSync(root)) {
    if (!RUN_DIR_PATTERN.test(name)) continue;
    const stored = readRun(join(root, name));
    if (!stored) continue;
    if (stored.ok) listing.runs.push(stored.record);
    else listing.corrupt.push({ dirName: stored.dirName, reason: stored.reason });
  }
  listing.runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  listing.corrupt.sort((a, b) => b.dirName.localeCompare(a.dirName));
  return listing;
}

export function runDir(record: RunRecord): string {
  return join(backupsRoot(), record.dirName);
}

export function retentionCutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);
  return cutoff;
}

/**
 * 보관 기간이 지난 실행 폴더를 지운다. sync와 `doctor --fix`는 시작할 때, 되돌리기는 끝난 뒤에 부른다.
 * 아직 되돌리지 않은 가장 최근 sync 실행은 기간이 지나도 남긴다. 그게 없어지면 되돌릴 길이 없다.
 * 읽지 못한 기록도 남긴다. 사람이 열어 볼 수 있게 두고 doctor와 되돌리기가 경고한다.
 * 기록 파일이 없으면 폴더 이름의 날짜로 판단한다.
 */
export function pruneRuns(now: Date = new Date()): string[] {
  const root = backupsRoot();
  if (!existsSync(root)) return [];
  const cutoff = retentionCutoff(now).getTime();
  const keep = listRunsNewestFirst().runs.find((r) => r.kind === 'sync' && !r.revertedAt)?.dirName;
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    if (!RUN_DIR_PATTERN.test(name) || name === keep) continue;
    const dir = join(root, name);
    const stored = readRun(dir);
    if (stored && !stored.ok) continue;
    const created = Date.parse(stored?.record.createdAt ?? `${name.slice(0, 10)}T00:00:00`);
    if (Number.isNaN(created) || created >= cutoff) continue;
    removePath(dir);
    removed.push(name);
  }
  return removed;
}
