import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDB, closeDB } from "../../src/core/memory/db";
import {
  addKnowledge,
  searchKnowledge,
  renderKnowledge,
  isCase,
  KNOWLEDGE_PROMPT_LIMIT,
} from "../../src/core/memory/knowledge";
import { createMemoryTool } from "../../src/core/tools/memory";
import { SqliteShim } from "../shim/better-sqlite3";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eva-cases-"));
  closeDB();
  getDB(path.join(dir, "t.db"));
});

afterEach(() => {
  closeDB();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The case log: what she did, the state he was in, what he did about it.
 *
 * The point of the three fields is that the reaction is unreadable without the
 * state, and these tests are mostly about that staying true on the way into the
 * prompt — the read side is the only place the base can turn back into rules.
 */
describe("cases", () => {
  it("tells a case from a plain statement", () => {
    const statement = addKnowledge({
      topic: "техника",
      insight: "Женя не любит айфоны",
      source: "memory_tool",
    });
    const recorded = addKnowledge({
      topic: "шутки",
      insight: "околололо",
      source: "memory_tool",
      her_move: "назвала его ангелом и пошутила про облако",
      context: "был весёлый",
      his_reaction: "подхватил, отвечал тепло",
    });

    expect(isCase(byId(statement))).toBe(false);
    expect(isCase(byId(recorded))).toBe(true);
  });

  it("renders a case with the state it happened in", () => {
    addKnowledge({
      topic: "шутки",
      insight: "околололо",
      source: "memory_tool",
      her_move: "назвала его ангелом",
      context: "был весёлый",
      his_reaction: "подхватил, тепло",
    });

    const out = renderKnowledge(searchKnowledge("ангелом", 5));
    expect(out).toContain("состояние: был весёлый");
    expect(out).toContain("она: назвала его ангелом");
    expect(out).toContain("ты: подхватил, тепло");
  });

  it("says so when a case has no recorded state instead of dropping it", () => {
    // The danger is the silent one: rendering the reaction alone turns a
    // moment into a rule. Marking it unknown keeps the case usable and keeps
    // the absence visible, where hiding it would make the base look smaller
    // every time the schema grew.
    addKnowledge({
      topic: "шутки",
      insight: "околололо",
      source: "memory_tool",
      her_move: "назвала его ангелом",
      context: "",
      his_reaction: "ответил холодно",
    });

    const out = renderKnowledge(searchKnowledge("ангелом", 5));
    expect(out).toContain("состояние: не определяется");
    expect(out).toContain("ты: ответил холодно");
  });

  it("tells the model these are examples and not rules", () => {
    addKnowledge({
      topic: "шутки",
      insight: "околололо",
      source: "memory_tool",
      her_move: "назвала его ангелом",
      context: "был весёлый",
      his_reaction: "подхватил, тепло",
    });

    const out = renderKnowledge(searchKnowledge("ангелом", 5));
    expect(out).toContain("а не правила");
    expect(out).toContain("выбирай");
  });

  it("keeps a statement readable as itself, with no case fields invented", () => {
    addKnowledge({ topic: "техника", insight: "Женя не любит айфоны", source: "memory_tool" });

    const out = renderKnowledge(searchKnowledge("айфон", 5));
    expect(out).toContain("1. Женя не любит айфоны");
    expect(out).not.toContain("состояние:");
  });

  it("is found by what she did, not only by the sentence about it", () => {
    // The note is written around the moment, so the words that will come up
    // next time are the ones in her_move and his_reaction. Without them in the
    // index every fresh phrasing of the same observation is a fact nothing can
    // reach.
    addKnowledge({
      topic: "общее",
      insight: "заметка",
      source: "memory_tool",
      her_move: "обозвала его подлизателем",
      context: "был занят",
      his_reaction: "отшутился, но голосом посадил",
    });

    expect(searchKnowledge("подлизателем", 5)).toHaveLength(1);
    expect(searchKnowledge("занят", 5)).toHaveLength(1);
    expect(searchKnowledge("отшутился", 5)).toHaveLength(1);
  });

  it("gives the prompt room for a spread of cases", () => {
    // Five slots was sized for three-sentence conclusions. A case is a line, and
    // the base is only worth anything if the same thing can show up more than
    // once in more than one state.
    expect(KNOWLEDGE_PROMPT_LIMIT).toBeGreaterThanOrEqual(10);
  });
});

describe("memory tool, case fields", () => {
  it("refuses a case with no state rather than storing a rule", async () => {
    const tool = createMemoryTool();

    const result = await tool.execute({
      action: "save",
      content: "околололо",
      her_move: "назвала его ангелом",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("incomplete_case");
    expect(getDB().prepare("SELECT COUNT(*) c FROM knowledge").get()).toEqual({ c: 0 });
  });

  it("saves the whole trio when it is there", async () => {
    const tool = createMemoryTool();

    const result = await tool.execute({
      action: "save",
      content: "околололо",
      her_move: "назвала его ангелом",
      context: "был весёлый",
      his_reaction: "подхватил, тепло",
    });

    expect(result.success).toBe(true);
    const row = getAll()[0];
    expect(row.her_move).toBe("назвала его ангелом");
    expect(row.context).toBe("был весёлый");
    expect(row.his_reaction).toBe("подхватил, тепло");
  });

  it("still saves a plain fact about a person with no case fields", async () => {
    const tool = createMemoryTool();

    const result = await tool.execute({
      action: "save",
      content: "Женя гомофоб, не упоминать пидоров",
      topic: "тема",
    });

    expect(result.success).toBe(true);
    const row = getAll()[0];
    expect(row.her_move).toBe("");
    expect(isCase(row)).toBe(false);
  });
});

describe("migration", () => {
  it("adds the case columns to an install that predates them", () => {
    // The live install: 45 rows written by the memory tool and by study, none of
    // them with a case field, and an index built from topic and insight alone.
    const p = path.join(dir, "legacy.db");
    const legacy = new SqliteShim(p);
    legacy.exec(`
      CREATE TABLE knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        insight TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0.5,
        timestamp INTEGER NOT NULL DEFAULT 0,
        stems TEXT NOT NULL DEFAULT '',
        zone TEXT NOT NULL DEFAULT '',
        access_count INTEGER NOT NULL DEFAULT 0,
        last_used INTEGER,
        superseded_at INTEGER,
        superseded_by INTEGER
      );
    `);
    legacy
      .prepare(
        "INSERT INTO knowledge (topic, insight, source, timestamp) VALUES (?,?,?,0)",
      )
      .run("техника", "Женя не любит айфоны", "memory_tool");
    legacy.close();

    closeDB();
    getDB(p);

    const cols = (getDB().pragma("table_info(knowledge)") as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("her_move");
    expect(cols).toContain("context");
    expect(cols).toContain("his_reaction");

    // The old rows are statements, not broken cases, and the index still finds
    // them by the words they always answered to.
    const row = getAll()[0];
    expect(row.her_move).toBe("");
    expect(isCase(row)).toBe(false);
    expect(searchKnowledge("айфон", 5)).toHaveLength(1);
  });
});

/** Live rows, oldest first. */
function getAll() {
  return getDB()
    .prepare(
      "SELECT id, topic, insight, source, confidence, timestamp, zone, access_count, " +
        "last_used, superseded_at, superseded_by, her_move, context, his_reaction " +
        "FROM knowledge WHERE superseded_at IS NULL ORDER BY id ASC",
    )
    .all() as CaseRow;
}

/**
 * By row id, not by position. Ids start at 1, so indexing a list of rows with
 * one silently returns the neighbouring row and the test passes on the wrong
 * thing.
 */
function byId(id: number): CaseRow {
  const row = getAll().find((r) => r.id === id);
  if (!row) throw new Error(`no row ${id}`);
  return row;
}

interface CaseRow {
  id: number;
  her_move: string;
  context: string;
  his_reaction: string;
}
