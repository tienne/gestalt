import { chmodSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { ToolsLevel } from './redact.js';
import type { SignedRoster } from './roster.js';

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
  | 'unknown_lines'
  | 'team_init'
  | 'team_join'
  | 'invite_create'
  | 'member_join'
  | 'member_remove'
  | 'roster_accept'
  | 'roster_reject'
  | 'remote_watch'
  | 'remote_watch_end'
  | 'watch_open'
  | 'watch_close'
  | 'message_receive'
  | 'message_insert'
  | 'message_deliver'
  | 'message_reject';

/** 이 기기가 든 팀. 한 기기는 팀 하나에만 든다 */
export interface TeamConfig {
  team: string;
  relay: string;
  person: string;
  /** 명단을 하나도 못 들고 있을 때 믿을 관리자 키. 팀을 만든 기기면 자기 자신이다 */
  anchor: string;
}

export interface InviteRow {
  id: string;
  secret: string;
  person: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedBy: string | null;
}

export interface AuditRow {
  at: number;
  shareId: string | null;
  action: AuditAction;
  detail: string | null;
}

/**
 * 공유 목록, 팀 설정과 명단, 초대, 감사 로그. 대화 내용은 한 글자도 여기 안 들어온다 —
 * 줄 수나 버전 같은 숫자와 이름만 남긴다. 공유 토큰과 공유 키도 저장하지 않는다. 데몬이
 * 다시 뜨면 이전 공유는 종료된 걸로 치고 새로 연다.
 *
 * 초대 비밀은 저장한다. 관리자 데몬이 나중에 온 join 요청의 증명을 맞춰 봐야 해서다.
 * 파일은 0600이고 쓰고 나면 used_at이 찬다.
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
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        secret TEXT NOT NULL,
        person TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        used_by TEXT
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

  /** 데몬이 죽어서 종료 기록 없이 남은 공유를 종료한다. 종료한 id 목록을 돌려준다 */
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

  getTeam(): TeamConfig | null {
    return this.getJson<TeamConfig>('team');
  }

  setTeam(team: TeamConfig): void {
    this.setJson('team', team);
  }

  /** 받은 명단 중 가장 새것. 받을지는 부르는 쪽이 checkRosterUpdate로 정한 뒤다 */
  getRoster(): SignedRoster | null {
    return this.getJson<SignedRoster>('roster');
  }

  setRoster(roster: SignedRoster): void {
    this.setJson('roster', roster);
  }

  insertInvite(row: Omit<InviteRow, 'usedAt' | 'usedBy'>): void {
    this.db
      .prepare(
        `INSERT INTO invites (id, secret, person, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.secret, row.person, row.createdAt, row.expiresAt);
  }

  getInvite(id: string): InviteRow | undefined {
    const r = this.db.prepare(`SELECT * FROM invites WHERE id = ?`).get(id) as
      | {
          id: string;
          secret: string;
          person: string;
          created_at: number;
          expires_at: number;
          used_at: number | null;
          used_by: string | null;
        }
      | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      secret: r.secret,
      person: r.person,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      usedAt: r.used_at,
      usedBy: r.used_by,
    };
  }

  useInvite(id: string, machineKey: string, at = Date.now()): void {
    this.db
      .prepare(`UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL`)
      .run(at, machineKey, id);
  }

  private getJson<T>(key: string): T | null {
    const r = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return r ? (JSON.parse(r.value) as T) : null;
  }

  private setJson(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value));
  }

  audit(action: AuditAction, shareId: string | null, detail?: string, at = Date.now()): void {
    this.db
      .prepare(`INSERT INTO audit (at, share_id, action, detail) VALUES (?, ?, ?, ?)`)
      .run(at, shareId, action, detail ?? null);
  }

  /** 받은 메시지 기록. 본문은 없고 id, 보낸 사람, 크기, 거절 이유만 있다 */
  messageLog(limit = 100): AuditRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM audit WHERE action LIKE 'message_%' ORDER BY id DESC LIMIT ?`)
      .all(limit) as {
      at: number;
      share_id: string | null;
      action: AuditAction;
      detail: string | null;
    }[];
    return rows
      .reverse()
      .map((r) => ({ at: r.at, shareId: r.share_id, action: r.action, detail: r.detail }));
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
