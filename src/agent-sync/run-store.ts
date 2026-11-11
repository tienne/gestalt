import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { gestaltPath } from '../core/home.js';
import { copyPath, movePath, removePath } from './fs-ops.js';

export type RunKind = 'sync' | 'doctor' | 'revert';

/**
 * 실행 하나가 한 일. 되돌리기는 sync 실행의 이 목록을 거꾸로 읽는다.
 * `backup`은 실행 폴더 안의 절대 경로다.
 */
export type RunAction =
  | { op: 'mkdir'; path: string }
  | { op: 'create_file'; path: string }
  | { op: 'write_file'; path: string; backup: string }
  | { op: 'create_link'; path: string; target: string }
  | { op: 'move'; from: string; to: string }
  | { op: 'stash'; path: string; backup: string }
  /** 되돌리기가 남기는 기록. 그 자리에 sync 뒤로 생긴 것을 치워둔 곳 */
  | { op: 'backup'; path: string; backup: string }
  | { op: 'restore'; path: string }
  | { op: 'remove'; path: string };

export interface RunRecord {
  version: 1;
  runId: string;
  kind: RunKind;
  createdAt: string;
  /** 실행 폴더 이름. `<YYYY-MM-DD>-<runId>` */
  dirName: string;
  actions: RunAction[];
  /** 사람이 읽을 한 줄 요약. 출력에 보여준 것과 같다 */
  changes: string[];
  revertOf?: string;
  revertedAt?: string;
  revertedBy?: string;
}

export const RUN_FILE = 'run.json';
const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/;
export const RETENTION_MONTHS = 6;

export function backupsRoot(): string {
  return gestaltPath('backups');
}

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

  /** 원래 경로 구조 그대로. 홈 아래는 `home/`, 그 밖은 `root/` 아래에 둔다 */
  backupPathFor(path: string): string {
    const rel = relative(this.home, path);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return join(this.dir, 'home', rel);
    return join(this.dir, 'root', path.replace(/^[/\\]+/, '').replace(/:/g, ''));
  }

  /** 지금 자리에 있는 것을 백업 폴더로 옮긴다 */
  moveToBackup(path: string): string {
    const backup = this.backupPathFor(path);
    movePath(path, backup);
    return backup;
  }

  copyToBackup(path: string): string {
    const backup = this.backupPathFor(path);
    copyPath(path, backup);
    return backup;
  }

  log(action: RunAction, change?: string): void {
    this.record.actions.push(action);
    if (change) this.record.changes.push(change);
    this.save();
  }

  /** 한 동작마다 저장해서 중간에 죽어도 거기까지는 되돌릴 수 있게 한다 */
  save(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.recordFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.record, null, 2)}\n`);
    renameSync(tmp, this.recordFile);
  }
}

export function readRun(dir: string): RunRecord | null {
  const file = join(dir, RUN_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as RunRecord;
  } catch {
    return null;
  }
}

export function writeRun(record: RunRecord): void {
  const dir = join(backupsRoot(), record.dirName);
  writeFileSync(join(dir, RUN_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

/** 새것부터 */
export function listRuns(): RunRecord[] {
  const root = backupsRoot();
  if (!existsSync(root)) return [];
  const out: RunRecord[] = [];
  for (const name of readdirSync(root)) {
    if (!RUN_DIR_PATTERN.test(name)) continue;
    const rec = readRun(join(root, name));
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
 * 보관 기간이 지난 실행 폴더를 지운다. 쓰는 실행(sync, doctor --fix, 되돌리기)이 시작할 때 부른다.
 * 기록 파일을 못 읽으면 폴더 이름의 날짜로 판단한다.
 */
export function pruneRuns(now: Date = new Date()): string[] {
  const root = backupsRoot();
  if (!existsSync(root)) return [];
  const cutoff = retentionCutoff(now).getTime();
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    if (!RUN_DIR_PATTERN.test(name)) continue;
    const dir = join(root, name);
    const rec = readRun(dir);
    const created = Date.parse(rec?.createdAt ?? `${name.slice(0, 10)}T00:00:00`);
    if (Number.isNaN(created) || created >= cutoff) continue;
    removePath(dir);
    removed.push(name);
  }
  return removed;
}
