import { chmodSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { ToolsLevel } from './redact.js';

const require = createRequire(import.meta.url);

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  pragma(source: string): unknown;
  exec(source: string): unknown;
  prepare(source: string): SqliteStatement;
  close(): void;
}

type SqliteConstructor = new (path: string) => SqliteDatabase;

function loadSqlite(): SqliteConstructor {
  const mod = require('better-sqlite3') as SqliteConstructor | { default?: SqliteConstructor };
  if (typeof mod === 'function') return mod;
  if (mod.default) return mod.default;
  throw new Error('better-sqlite3 did not export a Database constructor');
}

export type ShareCloseReason = 'unshare' | 'expired' | 'daemon_stop' | 'daemon_restart' | 'error';

export interface ShareRow {
  id: string;
  sessionId: string | null;
  transcriptPath: string;
  tools: ToolsLevel;
  createdAt: number;
  expiresAt: number;
  closedAt: number | null;
  closeReason: string | null;
}

export type AuditAction =
  | 'share_open'
  | 'share_close'
  | 'viewer_connect'
  | 'viewer_disconnect'
  | 'unknown_lines';

export interface AuditRow {
  at: number;
  shareId: string | null;
  action: AuditAction;
  detail: string | null;
}

/**
 * 공유 목록과 감사 로그. 대화 내용은 한 글자도 여기 안 들어온다 — 줄 수나 버전 같은
 * 숫자와 이름만 남긴다. 공유 토큰도 저장하지 않는다. 데몬이 다시 뜨면 이전 공유는
 * 닫힌 걸로 치고 새로 연다.
 */
export class PeerState {
  private db: SqliteDatabase;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const Database = loadSqlite();
    this.db = new Database(path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // :memory: 같은 경로는 파일이 없다
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        transcript_path TEXT NOT NULL,
        tools TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        closed_at INTEGER,
        close_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        share_id TEXT,
        action TEXT NOT NULL,
        detail TEXT
      );
    `);
  }

  insertShare(row: Omit<ShareRow, 'closedAt' | 'closeReason'>): void {
    this.db
      .prepare(
        `INSERT INTO shares (id, session_id, transcript_path, tools, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.sessionId, row.transcriptPath, row.tools, row.createdAt, row.expiresAt);
  }

  closeShare(id: string, reason: ShareCloseReason, at = Date.now()): void {
    this.db
      .prepare(
        `UPDATE shares SET closed_at = ?, close_reason = ? WHERE id = ? AND closed_at IS NULL`,
      )
      .run(at, reason, id);
  }

  /** 데몬이 죽어서 닫는 기록 없이 남은 공유를 닫는다. 닫은 id 목록을 돌려준다 */
  closeDangling(reason: ShareCloseReason, at = Date.now()): string[] {
    const rows = this.db.prepare(`SELECT id FROM shares WHERE closed_at IS NULL`).all() as {
      id: string;
    }[];
    for (const r of rows) this.closeShare(r.id, reason, at);
    return rows.map((r) => r.id);
  }

  getShare(id: string): ShareRow | undefined {
    const r = this.db.prepare(`SELECT * FROM shares WHERE id = ?`).get(id) as RawShare | undefined;
    return r ? toShare(r) : undefined;
  }

  audit(action: AuditAction, shareId: string | null, detail?: string, at = Date.now()): void {
    this.db
      .prepare(`INSERT INTO audit (at, share_id, action, detail) VALUES (?, ?, ?, ?)`)
      .run(at, shareId, action, detail ?? null);
  }

  auditLog(shareId?: string): AuditRow[] {
    const rows = (
      shareId
        ? this.db.prepare(`SELECT * FROM audit WHERE share_id = ? ORDER BY id`).all(shareId)
        : this.db.prepare(`SELECT * FROM audit ORDER BY id`).all()
    ) as { at: number; share_id: string | null; action: AuditAction; detail: string | null }[];
    return rows.map((r) => ({ at: r.at, shareId: r.share_id, action: r.action, detail: r.detail }));
  }

  close(): void {
    this.db.close();
  }
}

interface RawShare {
  id: string;
  session_id: string | null;
  transcript_path: string;
  tools: ToolsLevel;
  created_at: number;
  expires_at: number;
  closed_at: number | null;
  close_reason: string | null;
}

function toShare(r: RawShare): ShareRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    transcriptPath: r.transcript_path,
    tools: r.tools,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    closedAt: r.closed_at,
    closeReason: r.close_reason,
  };
}
