import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { indexText } from "./stem-ru.js";

let db: Database.Database | null = null;
let currentPath: string | null = null;

// Plain relative segments: "\.eva" would become a literal filename on Linux.
const DEFAULT_DB_PATH = path.join(os.homedir(), ".eva", "eva.db");

/**
 * Get or create the SQLite database, initializing tables and FTS5 index.
 * Accepts an optional path; defaults to ~/.eva/eva.db.
 */
export function getDB(dbPath?: string): Database.Database {
  // If no path specified and a connection already exists, reuse it
  if (!dbPath && db) return db;

  const resolvedPath = dbPath ?? DEFAULT_DB_PATH;

  if (db && currentPath === resolvedPath) return db;

  // Close previous connection if switching paths
  if (db) {
    db.close();
    db = null;
    currentPath = null;
  }

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  db = new Database(resolvedPath);
  currentPath = resolvedPath;

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_calls TEXT,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      insight TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0.5,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      timestamp INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS user_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      fact TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      timestamp INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts
      USING fts5(stems, content='knowledge', content_rowid='id');

    -- Triggers to keep FTS index in sync. The stems are computed in JS and
    -- stored on the row, because an FTS5 tokenizer cannot call out to it.
    CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, stems) VALUES (new.id, new.stems);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, stems)
        VALUES ('delete', old.id, old.stems);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, stems)
        VALUES ('delete', old.id, old.stems);
      INSERT INTO knowledge_fts(rowid, stems) VALUES (new.id, new.stems);
    END;
  `);

  // Migration: upgrade old conversations table if needed
  const cols = db.pragma("table_info(conversations)") as Array<{ name: string }>;
  const colNames = cols.map((c: { name: string }) => c.name);
  const hasCorrectSchema = colNames.includes("user_id") && colNames.includes("channel");
  if (!hasCorrectSchema) {
    // Old schema may have chat_id instead of channel, or missing user_id/tool columns
    // Safest approach: drop and recreate (data is either empty or unrecoverable)
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM conversations").get() as { cnt: number }).cnt;
    if (count === 0 || !colNames.includes("channel")) {
      // Empty table or incompatible schema (e.g., chat_id instead of channel) — recreate
      db.exec("DROP TABLE IF EXISTS conversations");
      db.exec(`CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        tool_calls TEXT,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch())
      )`);
    } else {
      // Has channel but missing user_id/tool columns — ALTER TABLE
      const conn = db;
      conn.transaction(() => {
        if (!colNames.includes("user_id")) conn.prepare("ALTER TABLE conversations ADD COLUMN user_id TEXT NOT NULL DEFAULT ''").run();
        if (!colNames.includes("tool_call_id")) conn.prepare("ALTER TABLE conversations ADD COLUMN tool_call_id TEXT").run();
        if (!colNames.includes("tool_calls")) conn.prepare("ALTER TABLE conversations ADD COLUMN tool_calls TEXT").run();
        conn.prepare("DELETE FROM conversations WHERE user_id = ''").run();
      })();
    }
  }

  db.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (
    user_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    token_estimate INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  db.exec("CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, timestamp)");

  migrateKnowledgeIndex();

  db.exec(`CREATE TABLE IF NOT EXISTS service_tokens (
    service_id    TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    access_token  TEXT NOT NULL,
    refresh_token TEXT,
    scopes        TEXT,
    expires_at    INTEGER,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (service_id, user_id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS installed_skills (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id   TEXT,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL,
    content      TEXT NOT NULL,
    embedding    BLOB,
    source_url   TEXT,
    installed_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  return db;
}

/**
 * Layout version of the knowledge search index.
 *
 * Bump it whenever `indexText` changes what it produces. The stored value is
 * what decides whether existing rows need reindexing, so a format change can
 * never silently leave the memory half-updated.
 *
 *   0 — no index, or the original raw topic/insight text
 *   1 — stems only
 *   2 — stems plus the raw tokens
 */
const KNOWLEDGE_INDEX_VERSION = 2;

function readMeta(key: string): string | null {
  const row = db!.prepare("SELECT value FROM eva_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeMeta(key: string, value: string): void {
  db!.prepare("INSERT OR REPLACE INTO eva_meta (key, value) VALUES (?, ?)").run(key, value);
}

/**
 * Bring the knowledge search index up to the current layout.
 *
 * The original index held the raw `topic`/`insight` text, which made the memory
 * useless in Russian: FTS5's default tokenizer has no notion of inflection, so
 * an entry about "кот был рыжим" could not be found by "котом", "коты" or
 * "котов" — and raw user text handed straight to MATCH threw SQLite syntax
 * errors on any colon, dash or caret.
 *
 * SQLite cannot stem on its own, so the searchable form is computed in JS and
 * stored on the row. The migration rebuilds the FTS table and backfills every
 * entry: they are tiny and the table holds a few dozen of them at most, so a
 * full rebuild costs nothing and is far easier to reason about than patching.
 */
function migrateKnowledgeIndex(): void {
  const conn = db;
  if (!conn) return;

  conn.exec(`
    CREATE TABLE IF NOT EXISTS eva_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const knowledgeCols = (conn.pragma("table_info(knowledge)") as Array<{ name: string }>).map(
    (c) => c.name,
  );
  if (!knowledgeCols.includes("stems")) {
    conn.exec("ALTER TABLE knowledge ADD COLUMN stems TEXT NOT NULL DEFAULT ''");
  }

  // Which columns does the existing FTS table actually have? The original one
  // was built over topic/insight, and its shape is the only reliable hint that
  // a pre-migration database is being opened.
  let ftsCols: string[] = [];
  try {
    ftsCols = (conn.pragma("table_info(knowledge_fts)") as Array<{ name: string }>).map(
      (c) => c.name,
    );
  } catch {
    ftsCols = [];
  }

  const stored = Number(readMeta("knowledge_index_version") ?? "0");
  const looksMigrated = ftsCols.includes("stems") && stored >= KNOWLEDGE_INDEX_VERSION;

  if (looksMigrated) {
    // Only rows that never got an index written still need filling in.
    const { missing } = conn
      .prepare("SELECT COUNT(*) as missing FROM knowledge WHERE stems IS NULL OR stems = ''")
      .get() as { missing: number };
    if (missing === 0) return;
  }

  if (ftsCols.length > 0) {
    conn.exec(`
      DROP TRIGGER IF EXISTS knowledge_ai;
      DROP TRIGGER IF EXISTS knowledge_ad;
      DROP TRIGGER IF EXISTS knowledge_au;
      DROP TABLE IF EXISTS knowledge_fts;
    `);
  }

  const rows = conn
    .prepare("SELECT id, topic, insight FROM knowledge")
    .all() as Array<{ id: number; topic: string; insight: string }>;
  if (rows.length > 0) {
    const update = conn.prepare("UPDATE knowledge SET stems = ? WHERE id = ?");
    conn.transaction(() => {
      for (const row of rows) {
        update.run(indexText(`${row.topic} ${row.insight}`), row.id);
      }
    })();
  }

  conn.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts
      USING fts5(stems, content='knowledge', content_rowid='id');

    CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, stems) VALUES (new.id, new.stems);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, stems)
        VALUES ('delete', old.id, old.stems);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, stems)
        VALUES ('delete', old.id, old.stems);
      INSERT INTO knowledge_fts(rowid, stems) VALUES (new.id, new.stems);
    END;
  `);
  conn.exec("INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')");
  writeMeta("knowledge_index_version", String(KNOWLEDGE_INDEX_VERSION));

  if (rows.length > 0) {
    console.log(`🔤 Индекс памяти: перестроен для ${rows.length} записей`);
  }
}

/**
 * Log a structured event to the events table.
 */
export function logEvent(type: string, data: Record<string, unknown> = {}): void {
  const d = getDB();
  d.prepare(
    "INSERT INTO events (type, data, timestamp) VALUES (?, ?, ?)",
  ).run(type, JSON.stringify(data), Math.floor(Date.now() / 1000));
}

/**
 * Close the database connection (useful for cleanup in tests).
 */
export function closeDB(): void {
  if (db) {
    db.close();
    db = null;
    currentPath = null;
  }
}
