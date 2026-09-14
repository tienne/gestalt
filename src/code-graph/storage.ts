import { createRequire } from 'node:module';
import { statSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SQLITE_BUSY_TIMEOUT_MS } from '../core/constants.js';
import type { CodeGraphNode, CodeGraphEdge, CodeGraphStats, CoChangeMeta } from './types.js';
import type { CodeNodeEmbedding } from './embedding-provider.js';

const _require = createRequire(import.meta.url);

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface SqliteDb {
  pragma(source: string): unknown;
  exec(source: string): unknown;
  prepare(source: string): SqliteStatement;
  transaction(fn: () => void): () => void;
  close(): void;
}

type SqliteConstructor = new (path: string) => SqliteDb;

function loadSqlite(): SqliteConstructor {
  const mod = _require('better-sqlite3') as SqliteConstructor | { default?: SqliteConstructor };
  if (typeof mod === 'function') return mod;
  if (typeof mod.default === 'function') return mod.default;
  throw new Error('better-sqlite3 did not export a Database constructor');
}

interface RawNodeRow {
  id: string;
  kind: string;
  name: string;
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  is_test: number;
  file_hash: string | null;
  updated_at: number;
}

interface RawEdgeRow {
  id: number;
  kind: string;
  source_id: string;
  target_id: string;
  line: number | null;
  updated_at: number;
}

function toNode(row: RawNodeRow): CodeGraphNode {
  return {
    id: row.id,
    kind: row.kind as CodeGraphNode['kind'],
    name: row.name,
    filePath: row.file_path,
    lineStart: row.line_start ?? undefined,
    lineEnd: row.line_end ?? undefined,
    isTest: row.is_test === 1,
    fileHash: row.file_hash ?? undefined,
    updatedAt: row.updated_at,
  };
}

interface RawEmbeddingRow {
  node_id: string;
  file_path: string;
  embedding: Buffer;
  model_id: string;
  created_at: number;
}

function toEmbedding(row: RawEmbeddingRow): CodeNodeEmbedding {
  return {
    nodeId: row.node_id,
    filePath: row.file_path,
    embedding: row.embedding,
    modelId: row.model_id,
    createdAt: row.created_at,
  };
}

function toEdge(row: RawEdgeRow): CodeGraphEdge {
  return {
    id: row.id,
    kind: row.kind as CodeGraphEdge['kind'],
    sourceId: row.source_id,
    targetId: row.target_id,
    line: row.line ?? undefined,
    updatedAt: row.updated_at,
  };
}

interface RawCoChangeMetaRow {
  id: number;
  head_sha: string;
  commits_used: number;
  commits_scanned: number;
  max_files_per_commit: number;
  min_pair_count: number;
  built_at: number;
}

export interface CoChangeNeighborRow {
  other: string;
  pairCount: number;
  soloOther: number;
}

export interface CoChangePairRow {
  fileA: string;
  fileB: string;
  pairCount: number;
  soloA: number;
  soloB: number;
}

/**
 * 임계를 통과한 행의 절대 천장. 두 임계는 외부 입력이고 둘 다 0이 허용되므로
 * 임계만으로는 조회가 읽는 행이 안 막힌다. 출력 `limit`은 랭킹을 다 세운
 * 뒤에 걸려서 읽는 행과 워킹트리 stat 팬아웃을 못 막는다. 그 자리를 메운다.
 *
 * 10,000인 근거는 셋이다.
 * 1. 정상 질의에 절대 안 걸린다. 이 레포는 임계를 둘 다 0으로 내려 전량을
 *    떠도 4,597행이라 두 배 넘게 남는다 (`c927188` 기준 — 커밋이 쌓이면
 *    함께 움직이는 스냅숏이다)
 * 2. 출력 상한(`limit` 최대 500)의 20배다. 천장이 사용자가 보는 목록을
 *    결정하는 자리가 되면 안 된다
 * 3. 천장에 걸려도 동기 stat 호출 수가 유한하다. 호출은 천장을 통과한 행에만
 *    붙고 전역 경로는 페어당 파일이 둘이라 최악이 천장의 두 배다. 행 수가
 *    아니라 천장이 이 팬아웃을 묶는다는 건 테스트가 지킨다
 *
 * 천장에 걸리면 접두사 보장이 깨지고 `totalMatched`가 다시 하한이 된다.
 * 그래서 `capped`로 따로 알린다 — 출력 `limit`에 잘린 것과 사유가 다르다.
 */
export const MAX_MATCHED_ROWS = 10_000;

/**
 * 질의문을 상수로 뽑아둔다. `EXPLAIN QUERY PLAN` 테스트가 이 문자열을 그대로
 * 설명해야 실제로 도는 질의의 계획을 고정하는 것이 된다. 테스트가 SQL을
 * 베껴 쓰면 베낀 쪽만 검사하게 된다.
 *
 * 두 질의는 `pair_count` 범위와 `file_a`/`file_b` 동등 비교로 인덱스를 탄다.
 * 인덱스를 건드리면 계획이 조용히 전체 스캔으로 떨어질 수 있어 테스트로 박았다.
 */
export const CO_CHANGE_NEIGHBORS_SQL = `
      SELECT other, pair_count, solo_other FROM (
        SELECT p.other AS other, p.pair_count AS pair_count, COALESCE(s.solo_count, 0) AS solo_other
        FROM (
          SELECT file_b AS other, pair_count FROM cg_cochange
            WHERE file_a = @path AND pair_count >= @minPairCount
          UNION ALL
          SELECT file_a AS other, pair_count FROM cg_cochange
            WHERE file_b = @path AND pair_count >= @minPairCount
        ) p
        LEFT JOIN cg_cochange_solo s ON s.file_path = p.other
      )
      WHERE ${CONFIDENCE_SQL('@soloSelf', 'solo_other')} >= @minConfidence
      LIMIT @scanLimit
    `;

export const CO_CHANGE_PAIRS_SQL = `
      SELECT file_a, file_b, pair_count, solo_a, solo_b FROM (
        SELECT c.file_a AS file_a, c.file_b AS file_b, c.pair_count AS pair_count,
               COALESCE(sa.solo_count, 0) AS solo_a, COALESCE(sb.solo_count, 0) AS solo_b
        FROM cg_cochange c
        LEFT JOIN cg_cochange_solo sa ON sa.file_path = c.file_a
        LEFT JOIN cg_cochange_solo sb ON sb.file_path = c.file_b
        WHERE c.pair_count >= @minPairCount
      )
      WHERE ${CONFIDENCE_SQL('solo_a', 'solo_b')} >= @minConfidence
      LIMIT @scanLimit
    `;

/**
 * `capped`는 천장에 걸려 `rows`가 임계 통과분 전부가 아니라는 뜻이다.
 * 개수를 돌려받는 쪽이 "전부"인지 "일부"인지 구분 못 하면 하한을 정확한
 * 수로 보고하게 된다.
 */
export interface CoChangeScan<Row> {
  rows: Row[];
  capped: boolean;
}

export interface CoChangeMergeInput {
  pairs: { fileA: string; fileB: string; count: number }[];
  solos: { filePath: string; count: number }[];
  meta: {
    headSha: string;
    commitsUsed: number;
    commitsScanned: number;
    maxFilesPerCommit: number;
    /** 수집 임계가 아니다. 빌드 시점의 조회 기본값을 기록만 한다 */
    defaultMinPairCount: number;
  };
  /** true면 세 테이블을 비우고 새로 쓴다 (전량 재수집). false면 카운터를 더한다 */
  reset: boolean;
}

/**
 * `scoreNeighbor()`의 confidence를 SQL로 옮긴 것. 두 방향 중 큰 쪽이므로
 * 작은 solo로 나눈다. solo가 0이면 그 방향은 0이라 반대쪽만 남는다. 둘 다 0이면 0이다.
 *
 * 임계를 반올림 전 값에 건다. 표시값(소수 두 자리)에 걸면 0.295가 0.3으로
 * 올라 minConfidence 0.3을 통과한다.
 *
 * 인자는 SQL에 그대로 보간되므로 타입을 아는 컬럼과 바인딩 이름으로 좁혔다.
 * 지금 호출부가 리터럴만 넘긴다는 사실에 기대는 대신 컴파일이 막게 한다.
 * 열을 늘릴 일이 있으면 이 유니온에 먼저 적는다.
 */
type ConfidenceOperand = '@soloSelf' | 'solo_other' | 'solo_a' | 'solo_b';

function CONFIDENCE_SQL(soloSelf: ConfidenceOperand, soloOther: ConfidenceOperand): string {
  return `CASE
    WHEN ${soloSelf} > 0 AND ${soloOther} > 0 THEN CAST(pair_count AS REAL) / MIN(${soloSelf}, ${soloOther})
    WHEN ${soloSelf} > 0 THEN CAST(pair_count AS REAL) / ${soloSelf}
    WHEN ${soloOther} > 0 THEN CAST(pair_count AS REAL) / ${soloOther}
    ELSE 0.0
  END`;
}

export class CodeGraphStore {
  private db: SqliteDb;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const Database = loadSqlite();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    this.db.pragma('foreign_keys = ON');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cg_nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line_start INTEGER,
        line_end INTEGER,
        is_test INTEGER DEFAULT 0,
        file_hash TEXT,
        updated_at REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cg_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        line INTEGER DEFAULT 0,
        updated_at REAL NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cg_nodes_file ON cg_nodes(file_path);
      CREATE INDEX IF NOT EXISTS idx_cg_nodes_kind ON cg_nodes(kind);
      CREATE INDEX IF NOT EXISTS idx_cg_edges_source ON cg_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_cg_edges_target ON cg_edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_cg_edges_kind ON cg_edges(kind);

      CREATE TABLE IF NOT EXISTS node_embeddings (
        node_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        embedding BLOB NOT NULL,
        model_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_file ON node_embeddings(file_path);

      CREATE TABLE IF NOT EXISTS cg_cochange (
        file_a TEXT NOT NULL,
        file_b TEXT NOT NULL,
        pair_count INTEGER NOT NULL,
        updated_at REAL NOT NULL,
        PRIMARY KEY (file_a, file_b)
      );
      CREATE INDEX IF NOT EXISTS idx_cg_cochange_b ON cg_cochange(file_b);
      -- getCoChangePairs가 pair_count로 거른다. 이게 없으면 전역 페어 조회가
      -- 매번 전체 스캔이다. 기본 임계(3회)에서 이 레포는 4,597행 중 485행만
      -- 남는다 (\`c927188\` 기준 — 커밋이 쌓이면 함께 움직이는 스냅숏이다).
      -- 계획이 이 인덱스를 타는지는 EXPLAIN QUERY PLAN 테스트가 고정한다.
      CREATE INDEX IF NOT EXISTS idx_cg_cochange_count ON cg_cochange(pair_count);

      CREATE TABLE IF NOT EXISTS cg_cochange_solo (
        file_path TEXT PRIMARY KEY,
        solo_count INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cg_cochange_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        head_sha TEXT NOT NULL,
        commits_used INTEGER NOT NULL,
        commits_scanned INTEGER NOT NULL,
        max_files_per_commit INTEGER NOT NULL,
        -- 수집이 강제하는 값이 아니다. 빌드 시점의 조회 기본 임계를 남겨둔
        -- 기록일 뿐이라 실제 질의에 쓰인 값과 다를 수 있다.
        min_pair_count INTEGER NOT NULL,
        built_at REAL NOT NULL
      );
    `);
  }

  getNodesByFile(filePath: string): CodeGraphNode[] {
    const stmt = this.db.prepare(`
      SELECT * FROM cg_nodes WHERE file_path = ?
    `);
    const rows = stmt.all(filePath) as RawNodeRow[];
    return rows.map(toNode);
  }

  getNodeById(id: string): CodeGraphNode | null {
    const stmt = this.db.prepare(`
      SELECT * FROM cg_nodes WHERE id = ?
    `);
    const row = stmt.get(id) as RawNodeRow | undefined;
    return row ? toNode(row) : null;
  }

  getEdgesBySource(sourceId: string): CodeGraphEdge[] {
    const stmt = this.db.prepare(`
      SELECT * FROM cg_edges WHERE source_id = ?
    `);
    const rows = stmt.all(sourceId) as RawEdgeRow[];
    return rows.map(toEdge);
  }

  getEdgesByTarget(targetId: string): CodeGraphEdge[] {
    const stmt = this.db.prepare(`
      SELECT * FROM cg_edges WHERE target_id = ?
    `);
    const rows = stmt.all(targetId) as RawEdgeRow[];
    return rows.map(toEdge);
  }

  /**
   * filePath를 target으로 하는 엣지들의 source 파일 목록을 반환한다 (1-hop, 자기 자신 제외).
   * 증분 빌드에서 deleteByFile로 filePath의 엣지를 지우기 전에 호출해야 한다 —
   * 지운 뒤에는 filePath를 참조하던 파일 목록을 더 이상 조회할 수 없다.
   */
  getReferencingFiles(filePath: string): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT src.file_path AS file_path
      FROM cg_edges e
      JOIN cg_nodes tgt ON tgt.id = e.target_id
      JOIN cg_nodes src ON src.id = e.source_id
      WHERE tgt.file_path = ? AND src.file_path != ?
    `);
    const rows = stmt.all(filePath, filePath) as { file_path: string }[];
    return rows.map((r) => r.file_path);
  }

  getAllNodes(): CodeGraphNode[] {
    const stmt = this.db.prepare(`
      SELECT * FROM cg_nodes
    `);
    const rows = stmt.all() as RawNodeRow[];
    return rows.map(toNode);
  }

  getAllEdges(): CodeGraphEdge[] {
    const stmt = this.db.prepare(`
      SELECT * FROM cg_edges
    `);
    const rows = stmt.all() as RawEdgeRow[];
    return rows.map(toEdge);
  }

  upsertNode(node: CodeGraphNode): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO cg_nodes
        (id, kind, name, file_path, line_start, line_end, is_test, file_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      node.id,
      node.kind,
      node.name,
      node.filePath,
      node.lineStart ?? null,
      node.lineEnd ?? null,
      node.isTest ? 1 : 0,
      node.fileHash ?? null,
      node.updatedAt,
    );
  }

  upsertEdge(edge: CodeGraphEdge): void {
    const deleteStmt = this.db.prepare(`
      DELETE FROM cg_edges WHERE source_id = ? AND target_id = ? AND kind = ?
    `);
    deleteStmt.run(edge.sourceId, edge.targetId, edge.kind);

    const insertStmt = this.db.prepare(`
      INSERT INTO cg_edges (kind, source_id, target_id, line, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertStmt.run(edge.kind, edge.sourceId, edge.targetId, edge.line ?? 0, edge.updatedAt);
  }

  deleteByFile(filePath: string): void {
    const nodeIds = this.db
      .prepare(`SELECT id FROM cg_nodes WHERE file_path = ?`)
      .all(filePath) as { id: string }[];

    const deleteEdgesForNode = this.db.prepare(`
      DELETE FROM cg_edges WHERE source_id = ? OR target_id = ?
    `);

    const deleteNodeStmt = this.db.prepare(`
      DELETE FROM cg_nodes WHERE file_path = ?
    `);

    const run = this.db.transaction(() => {
      for (const { id } of nodeIds) {
        deleteEdgesForNode.run(id, id);
      }
      deleteNodeStmt.run(filePath);
    });

    run();
  }

  getFileHash(filePath: string): string | null {
    const stmt = this.db.prepare(`
      SELECT file_hash FROM cg_nodes WHERE file_path = ? LIMIT 1
    `);
    const row = stmt.get(filePath) as { file_hash: string | null } | undefined;
    return row?.file_hash ?? null;
  }

  getStats(dbPath: string): CodeGraphStats {
    const totalFiles = (
      this.db.prepare(`SELECT COUNT(DISTINCT file_path) AS cnt FROM cg_nodes`).get() as {
        cnt: number;
      }
    ).cnt;

    const totalNodes = (
      this.db.prepare(`SELECT COUNT(*) AS cnt FROM cg_nodes`).get() as { cnt: number }
    ).cnt;

    const totalEdges = (
      this.db.prepare(`SELECT COUNT(*) AS cnt FROM cg_edges`).get() as { cnt: number }
    ).cnt;

    const lastBuiltRow = this.db.prepare(`SELECT MAX(updated_at) AS last FROM cg_nodes`).get() as {
      last: number | null;
    };
    const lastBuiltAt = lastBuiltRow.last ?? null;

    let dbSizeBytes: number;
    try {
      dbSizeBytes = statSync(dbPath).size;
    } catch {
      dbSizeBytes = 0;
    }

    return {
      totalFiles,
      totalNodes,
      totalEdges,
      lastBuiltAt,
      dbSizeBytes,
    };
  }

  upsertEmbedding(embedding: CodeNodeEmbedding): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO node_embeddings
        (node_id, file_path, embedding, model_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      embedding.nodeId,
      embedding.filePath,
      embedding.embedding,
      embedding.modelId,
      embedding.createdAt,
    );
  }

  getEmbedding(nodeId: string): CodeNodeEmbedding | null {
    const stmt = this.db.prepare(`SELECT * FROM node_embeddings WHERE node_id = ?`);
    const row = stmt.get(nodeId) as RawEmbeddingRow | undefined;
    return row ? toEmbedding(row) : null;
  }

  getAllEmbeddings(): CodeNodeEmbedding[] {
    const stmt = this.db.prepare(`SELECT * FROM node_embeddings`);
    const rows = stmt.all() as RawEmbeddingRow[];
    return rows.map(toEmbedding);
  }

  deleteEmbedding(nodeId: string): void {
    this.db.prepare(`DELETE FROM node_embeddings WHERE node_id = ?`).run(nodeId);
  }

  deleteEmbeddingsByFile(filePath: string): void {
    this.db.prepare(`DELETE FROM node_embeddings WHERE file_path = ?`).run(filePath);
  }

  // ─── Co-Change ─────────────────────────────────────────────────
  //
  // 점수(confidence/lift)는 저장하지 않고 조회 시점에 계산한다. lift 분모가
  // commits_used라서 커밋 하나만 더 반영해도 저장된 점수가 전부 무효가 된다.
  // 그러면 증분 갱신이 매번 전량 재계산으로 떨어진다. 원시 카운트만 두면
  // 증분이 카운터 덧셈으로 끝난다.

  mergeCoChange(input: CoChangeMergeInput): void {
    const now = Date.now();

    const deletePairs = this.db.prepare(`DELETE FROM cg_cochange`);
    const deleteSolos = this.db.prepare(`DELETE FROM cg_cochange_solo`);
    const deleteMeta = this.db.prepare(`DELETE FROM cg_cochange_meta`);

    const upsertPair = this.db.prepare(`
      INSERT INTO cg_cochange (file_a, file_b, pair_count, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(file_a, file_b) DO UPDATE SET
        pair_count = pair_count + excluded.pair_count,
        updated_at = excluded.updated_at
    `);

    const upsertSolo = this.db.prepare(`
      INSERT INTO cg_cochange_solo (file_path, solo_count)
      VALUES (?, ?)
      ON CONFLICT(file_path) DO UPDATE SET solo_count = solo_count + excluded.solo_count
    `);

    const upsertMeta = this.db.prepare(`
      INSERT INTO cg_cochange_meta
        (id, head_sha, commits_used, commits_scanned, max_files_per_commit, min_pair_count, built_at)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        head_sha = excluded.head_sha,
        commits_used = commits_used + excluded.commits_used,
        commits_scanned = commits_scanned + excluded.commits_scanned,
        max_files_per_commit = excluded.max_files_per_commit,
        min_pair_count = excluded.min_pair_count,
        built_at = excluded.built_at
    `);

    const run = this.db.transaction(() => {
      if (input.reset) {
        deletePairs.run();
        deleteSolos.run();
        deleteMeta.run();
      }
      for (const pair of input.pairs) {
        upsertPair.run(pair.fileA, pair.fileB, pair.count, now);
      }
      for (const solo of input.solos) {
        upsertSolo.run(solo.filePath, solo.count);
      }
      upsertMeta.run(
        input.meta.headSha,
        input.meta.commitsUsed,
        input.meta.commitsScanned,
        input.meta.maxFilesPerCommit,
        input.meta.defaultMinPairCount,
        now,
      );
    });

    run();
  }

  getCoChangeMeta(): CoChangeMeta | null {
    const row = this.db.prepare(`SELECT * FROM cg_cochange_meta WHERE id = 1`).get() as
      | RawCoChangeMetaRow
      | undefined;
    if (!row) return null;
    return {
      headSha: row.head_sha,
      commitsUsed: row.commits_used,
      commitsScanned: row.commits_scanned,
      maxFilesPerCommit: row.max_files_per_commit,
      defaultMinPairCount: row.min_pair_count,
      builtAt: row.built_at,
    };
  }

  countCoChangePairs(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS cnt FROM cg_cochange`).get() as { cnt: number };
    return row.cnt;
  }

  getCoChangeSolo(filePath: string): number {
    const row = this.db
      .prepare(`SELECT solo_count FROM cg_cochange_solo WHERE file_path = ?`)
      .get(filePath) as { solo_count: number } | undefined;
    return row?.solo_count ?? 0;
  }

  /**
   * 무방향 페어라 file_a/file_b 양쪽을 합쳐야 한 파일의 이웃이 전부 나온다.
   *
   * 임계를 통과한 행을 전부 돌려준다. 점수순 개수 창이 없는 게 의도다 — 랭킹
   * 키가 confidence × lift라 `pair_count` 순으로 먼저 자르면 점수 상위가 창
   * 밖으로 빠진다. 대신 두 임계를 질의로 내려 호출부가 버릴 행을 애초에 안
   * 뜬다. 기본 임계에서 seed당 22행, 임계를 전부 0으로 내려도 133행이다
   * (`c927188` 기준 — 커밋이 쌓이면 함께 움직이는 스냅숏이다).
   *
   * `maxRows`는 그 위에 얹은 절대 천장이라 성격이 다르다. 임계가 0이어도
   * 읽는 행이 유한하도록 막는 자리고 정상 질의에는 안 걸린다. 걸리면
   * `capped`로 알린다 — 조용히 자르면 하한이 정확한 수로 둔갑한다.
   * 천장이 SQL에 있어야 호출부의 워킹트리 stat 팬아웃까지 함께 막힌다.
   */
  getCoChangeNeighbors(
    filePath: string,
    minPairCount: number,
    minConfidence: number,
    soloSelf: number,
    maxRows: number = MAX_MATCHED_ROWS,
  ): CoChangeScan<CoChangeNeighborRow> {
    const rows = this.db
      .prepare(CO_CHANGE_NEIGHBORS_SQL)
      // 한 행을 더 떠야 천장에 "닿은 것"과 "넘은 것"이 갈린다.
      .all({ path: filePath, minPairCount, minConfidence, soloSelf, scanLimit: maxRows + 1 }) as {
      other: string;
      pair_count: number;
      solo_other: number;
    }[];
    const capped = rows.length > maxRows;
    return {
      rows: (capped ? rows.slice(0, maxRows) : rows).map((r) => ({
        other: r.other,
        pairCount: r.pair_count,
        soloOther: r.solo_other,
      })),
      capped,
    };
  }

  /** 이웃 조회와 같은 규율이다 — 임계는 질의가 걸고 점수순 창은 두지 않는다 */
  getCoChangePairs(
    minPairCount: number,
    minConfidence: number,
    maxRows: number = MAX_MATCHED_ROWS,
  ): CoChangeScan<CoChangePairRow> {
    const rows = this.db
      .prepare(CO_CHANGE_PAIRS_SQL)
      .all({ minPairCount, minConfidence, scanLimit: maxRows + 1 }) as {
      file_a: string;
      file_b: string;
      pair_count: number;
      solo_a: number;
      solo_b: number;
    }[];
    const capped = rows.length > maxRows;
    return {
      rows: (capped ? rows.slice(0, maxRows) : rows).map((r) => ({
        fileA: r.file_a,
        fileB: r.file_b,
        pairCount: r.pair_count,
        soloA: r.solo_a,
        soloB: r.solo_b,
      })),
      capped,
    };
  }

  close(): void {
    this.db.close();
  }
}
