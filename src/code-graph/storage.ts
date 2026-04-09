import Database from 'better-sqlite3';
import { statSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CodeGraphNode, CodeGraphEdge, CodeGraphStats } from './types.js';
import type { CodeNodeEmbedding } from './embedding-provider.js';

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

export class CodeGraphStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
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

    let dbSizeBytes = 0;
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

  close(): void {
    this.db.close();
  }
}
