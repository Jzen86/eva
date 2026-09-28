import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import {
  addKnowledge,
  searchKnowledge,
  getKnowledgeCount,
} from "../../src/core/memory/knowledge.js";
import { loadSummary, foldedUpTo } from "../../src/core/memory/conversations.js";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

describe("Memory", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `betsy-test-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {}
    }
  });

  it("adds and searches knowledge", () => {
    addKnowledge(
      { topic: "test", insight: "TypeScript is great", source: "test" },
      100,
    );
    const results = searchKnowledge("TypeScript", 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it("counts knowledge entries", () => {
    addKnowledge({ topic: "a", insight: "fact 1", source: "test" }, 100);
    addKnowledge({ topic: "b", insight: "fact 2", source: "test" }, 100);
    expect(getKnowledgeCount()).toBe(2);
  });

  describe("DB Schema", () => {
    it("creates conversations table with user_id column", () => {
      const d = getDB(dbPath);
      const cols = d.pragma("table_info(conversations)") as Array<{ name: string }>;
      const colNames = cols.map(c => c.name);
      expect(colNames).toContain("user_id");
      expect(colNames).toContain("tool_call_id");
      expect(colNames).toContain("tool_calls");
    });

    it("creates conversation_summaries table", () => {
      const d = getDB(dbPath);
      const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_summaries'").all();
      expect(tables.length).toBe(1);
    });

    it("creates idx_conv_user index", () => {
      const d = getDB(dbPath);
      const indexes = d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_conv_user'").all();
      expect(indexes.length).toBe(1);
    });

    it("migrates old conversations table (empty)", async () => {
      closeDB();
      const Database = (await import("better-sqlite3")).default;
      const oldDb = new Database(dbPath);
      oldDb.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `);
      oldDb.close();
      getDB(dbPath);
      const d = getDB(dbPath);
      const cols = d.pragma("table_info(conversations)") as Array<{ name: string }>;
      expect(cols.map(c => c.name)).toContain("user_id");
    });

    it("keeps an old rolling summary as a carry instead of dropping it", async () => {
      // Its own file: the shared one was opened by `beforeEach`, so the table
      // there is already the new shape and there would be nothing to migrate.
      const legacyPath = path.join(os.tmpdir(), `betsy-legacy-${crypto.randomUUID()}.db`);
      try {
        const Database = (await import("better-sqlite3")).default;
        const oldDb = new Database(legacyPath);
        // The shape the digest had before it learned to say which rows it covers.
        oldDb.exec(`
          CREATE TABLE conversation_summaries (
            user_id TEXT PRIMARY KEY,
            summary TEXT NOT NULL,
            token_estimate INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
          );
          INSERT INTO conversation_summaries (user_id, summary, token_estimate)
            VALUES ('u1', 'Давно обсуждали TypeScript', 30);
        `);
        oldDb.close();

        getDB(legacyPath);

        // It cannot keep its range — the old folds deleted the rows as they went
        // in, so there is nothing left to re-derive them from. It becomes a carry
        // at `to_id = 0`, which the first real fold absorbs and retires.
        const cols = (
          getDB().pragma("table_info(conversation_summaries)") as Array<{ name: string }>
        ).map((c) => c.name);
        expect(cols).toContain("from_id");
        expect(cols).toContain("to_id");
        expect(loadSummary("u1")).toBe("Давно обсуждали TypeScript");
        expect(foldedUpTo("u1")).toBe(0);
      } finally {
        closeDB();
        for (const suffix of ["", "-wal", "-shm"]) {
          try {
            fs.unlinkSync(legacyPath + suffix);
          } catch {}
        }
      }
    });
  });
});
